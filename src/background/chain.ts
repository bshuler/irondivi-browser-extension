/**
 * The wallet's view of the chain. With the default server setting every call
 * goes straight to rpcClient, exactly as before. With a chosen Electrum server
 * it goes to an ElectrumBackend instead, and never falls back to IronDivi on
 * its own: an unreachable chosen server is reported, and only the owner can
 * pick IronDivi for the rest of the session (design §6).
 */
import { storage } from '../shared/browser-polyfill';
import type { NetworkType } from '../shared/constants';
import {
  DEFAULT_SERVER_CONFIG, normalizeServerConfig, serverUrl,
  type ServerChoice, type ServerConfig,
} from '../shared/server-config';
import { Address } from '../lib/address';
import { ElectrumBackend, checkServer } from '../../vendor/divi-electrum-client.esm.js';
import { BackendError, type ServerCheck } from './backend/types';
import {
  historyItemFromTx, rpcClient,
  type TransactionHistoryItem, type UTXOResponse,
} from './rpc-client';

const SATS = 100000000;
const IDLE_CLOSE_MS = 30000;
const MEMPOOL_LIMIT = 200;

const STORAGE_KEY = 'server';

export async function getServerConfig(): Promise<ServerConfig> {
  const { [STORAGE_KEY]: stored } = await storage.local.get<{ server: unknown }>(STORAGE_KEY);
  return stored === undefined ? DEFAULT_SERVER_CONFIG : normalizeServerConfig(stored);
}

export async function saveServerConfig(config: ServerConfig): Promise<void> {
  await storage.local.set({ [STORAGE_KEY]: config });
}

/** What the popup needs to draw the Server screen, the home label and the banner */
export interface ServerStatus {
  config: ServerConfig;
  /** Using IronDivi until the wallet closes, though another server is chosen */
  sessionDefault: boolean;
  /** The chosen server could not be reached or failed its checks; the words to show */
  problem: string | null;
}

class Chain {
  private backend: ElectrumBackend | null = null;
  private backendKey = '';
  private verified = false;
  private idleTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly sessionDefault = new Set<NetworkType>();
  private problem: { network: NetworkType; message: string } | null = null;
  private lastTip: Partial<Record<NetworkType, number>> = {};
  /** For tests: the WebSocket class to use in place of the browser's */
  webSocket: unknown;

  async status(): Promise<ServerStatus> {
    const network = rpcClient.getNetwork();
    return {
      config: await getServerConfig(),
      sessionDefault: this.sessionDefault.has(network),
      problem: this.problem?.network === network ? this.problem.message : null,
    };
  }

  /** IronDivi (standard) until the wallet closes; never saved */
  useDefaultThisSession(): void {
    this.sessionDefault.add(rpcClient.getNetwork());
    this.problem = null;
    this.drop();
  }

  /** The wallet's windows are all closed: the per-session choice ends */
  endSession(): void {
    this.sessionDefault.clear();
    this.problem = null;
    this.drop();
  }

  /** A choice was saved or the network changed: connect afresh */
  reset(): void {
    this.problem = null;
    this.drop();
  }

  private drop(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = null;
    this.backend?.close();
    this.backend = null;
    this.verified = false;
    this.backendKey = '';
  }

  /** Test a server address without saving it */
  async test(url: string, network: NetworkType): Promise<ServerCheck> {
    return checkServer(url, network, this.lastTip[network], { WebSocket: this.webSocket });
  }

  noteTip(network: NetworkType, tip: number): void {
    this.lastTip[network] = tip;
  }

  /** The Electrum backend to use now, or null for the default path */
  private async electrum(): Promise<ElectrumBackend | null> {
    const network = rpcClient.getNetwork();
    if (this.sessionDefault.has(network)) return null;
    const choice: ServerChoice = (await getServerConfig())[network];
    const url = serverUrl(choice, network);
    if (!url) return null;

    const key = `${network} ${url}`;
    if (this.backend && this.backendKey !== key) this.drop();
    if (!this.backend) {
      this.backend = new ElectrumBackend({ url, network, lastSeenTip: this.lastTip[network], WebSocket: this.webSocket });
      this.backendKey = key;
    }
    if (!this.verified) {
      const check = await this.backend.connect();
      if (!check.ok) {
        this.drop();
        throw this.fail(network, check.problem === 'unreachable' ? 'Can\u2019t reach your server' : check.message,
          check.problem === 'unreachable' ? 'unreachable' : 'bad-reply');
      }
      this.verified = true;
      if (check.tip) this.lastTip[network] = check.tip;
    }
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => this.drop(), IDLE_CLOSE_MS);
    return this.backend;
  }

  private fail(network: NetworkType, message: string, code: BackendError['code']): BackendError {
    this.problem = { network, message };
    return new BackendError(code, message);
  }

  /** Run a call on the chosen server; a dropped connection is reported as unreachable, never retried elsewhere */
  private async run<T>(electrumCall: (b: ElectrumBackend) => Promise<T>, rpcCall: () => Promise<T>): Promise<T> {
    const b = await this.electrum();
    if (!b) return rpcCall();
    try {
      const out = await electrumCall(b);
      this.problem = null;
      return out;
    } catch (e: any) {
      const code: string | undefined = e?.code;
      if (code === 'unreachable' || code === 'bad-reply' || code === 'wrong-network' || code === 'behind') {
        this.drop();
        throw this.fail(rpcClient.getNetwork(), e.code === 'unreachable'
          ? 'Can’t reach your server' : e.message, e.code);
      }
      throw e;
    }
  }

  /** In DIVI, like RPCClient.getBalance */
  getBalance(addresses: string[]): Promise<number> {
    return this.run(async b => {
      const { confirmed, unconfirmed } = await b.getBalance(addresses);
      return (confirmed + unconfirmed) / SATS;
    }, () => rpcClient.getBalance(addresses));
  }

  getUtxos(addresses: string[]): Promise<UTXOResponse[]> {
    return this.run(async b => {
      const [tip, coins] = await Promise.all([b.getTipHeight(), b.listUnspent(addresses)]);
      this.noteTip(rpcClient.getNetwork(), tip);
      // As on the RPC path, a coin is used only if every field is well formed
      for (const c of coins) {
        if (typeof c.txid !== 'string' || !/^[0-9a-fA-F]{64}$/.test(c.txid) ||
            !Number.isInteger(c.vout) || c.vout < 0 || c.vout > 0xffffffff ||
            !Number.isSafeInteger(c.value) || c.value <= 0) {
          throw new BackendError('bad-reply', 'The server sent an invalid coin');
        }
      }
      return coins.map(c => ({
        txid: c.txid.toLowerCase(),
        vout: c.vout,
        address: c.address,
        satoshis: BigInt(c.value),
        amount: c.value / SATS,
        confirmations: c.height > 0 ? Math.max(tip - c.height + 1, 0) : 0,
      }));
    }, () => rpcClient.getUtxos(addresses));
  }

  getTransactionHistory(addresses: string[], limit: number, extraTxids: string[]): Promise<TransactionHistoryItem[]> {
    return this.run(async b => {
      const [tip, history] = await Promise.all([b.getTipHeight(), b.getHistory(addresses)]);
      const heights = new Map<string, number>();
      for (const h of history) heights.set(h.txid, h.height);
      // Mined first, newest last in the server's order; unconfirmed ones lead
      const mined = [...heights.keys()].filter(t => (heights.get(t) ?? 0) > 0).slice(-limit).reverse();
      const pendingIds = [...new Set([
        ...[...heights.keys()].filter(t => (heights.get(t) ?? 0) <= 0),
        ...extraTxids.filter(t => !heights.has(t)),
      ])].slice(0, MEMPOOL_LIMIT);
      const out: TransactionHistoryItem[] = [];
      const pending: TransactionHistoryItem[] = [];
      const ids = [...pendingIds, ...mined];
      for (let i = 0; i < ids.length; i += 10) {
        const batch = ids.slice(i, i + 10);
        const got = await Promise.allSettled(batch.map(t => b.getTransaction(t)));
        got.forEach((r, j) => {
          if (r.status !== 'fulfilled') return;
          const tx = r.value as any;
          const item = historyItemFromTx(tx, addresses);
          const height = heights.get(batch[j]) ?? 0;
          item.txid = batch[j];
          item.confirmations = height > 0 ? Math.max(tip - height + 1, 0) : 0;
          (item.confirmations === 0 ? pending : out).push(item);
        });
      }
      return [...pending, ...out];
    }, () => rpcClient.getTransactionHistory(addresses, limit, extraTxids));
  }

  getRawTransactionHex(txid: string): Promise<string> {
    // The contract has no raw-hex call; the caller parses it and checks the txid itself
    return this.run(async b => {
      const hex = await b.client.request('blockchain.transaction.get', [txid, false]);
      if (typeof hex !== 'string' || !/^[0-9a-fA-F]+$/.test(hex)) {
        throw new BackendError('bad-reply', 'The server sent an invalid transaction');
      }
      return hex;
    }, () => rpcClient.getRawTransactionHex(txid));
  }

  broadcastTransaction(hex: string): Promise<string> {
    return this.run(b => b.broadcast(hex), () => rpcClient.broadcastTransaction(hex));
  }

  /** Locally on a chosen Electrum server (it has no validateaddress, and the node is not asked); the default path asks the node */
  async validateAddress(address: string): Promise<boolean> {
    const network = rpcClient.getNetwork();
    if (this.sessionDefault.has(network) || !serverUrl((await getServerConfig())[network], network)) {
      return rpcClient.validateAddress(address);
    }
    return Address.validate(address, network);
  }

  /** Subscribe to new blocks while a window is open; null on the default path */
  async watchBlocks(cb: (height: number) => void): Promise<(() => void) | null> {
    const b = await this.electrum().catch(() => null);
    return b ? b.onNewBlock(cb) : null;
  }

  async watchAddresses(addresses: string[], cb: (address: string) => void): Promise<(() => void) | null> {
    const b = await this.electrum().catch(() => null);
    return b ? b.onAddressChange(addresses, cb) : null;
  }
}

export const chain = new Chain();
