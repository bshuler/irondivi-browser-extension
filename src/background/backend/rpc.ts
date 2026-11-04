/**
 * Today's JSON-RPC path behind the Backend contract. It maps each method to the
 * call the wallet already makes and keeps the same requests; nothing about
 * what the default path sends changes.
 */
import { RPCClient } from '../rpc-client';
import type { Backend, HistoryItem, Network, ServerCheck, Utxo } from './types';
import { BackendError } from './types';

export class RpcBackend implements Backend {
  readonly kind = 'rpc' as const;

  constructor(private readonly client: RPCClient, readonly network: Network) {}

  async connect(): Promise<ServerCheck> {
    return { ok: true, network: this.network, tip: null, software: null, problem: null, message: 'Connected' };
  }

  close(): void {}

  getTipHeight(): Promise<number> {
    return this.client.getBlockCount();
  }

  async getBalance(addresses: string[]) {
    const results = await Promise.all(addresses.map(a => this.client.rpc<{ balance: number }>('getaddressbalance', [a])));
    // The address index reports one total, which counts the mempool
    return { confirmed: results.reduce((sum, r) => sum + r.balance, 0), unconfirmed: 0 };
  }

  async listUnspent(addresses: string[]): Promise<Utxo[]> {
    const lists = await Promise.all(addresses.map(a => this.client.getAddressUtxosRaw(a)));
    return lists.flatMap((list, i) => list.map(u => ({
      txid: u.txid, vout: u.outputIndex, value: u.satoshis, height: u.height,
      address: addresses[i], scriptPubKey: u.script,
    })));
  }

  async getHistory(addresses: string[]): Promise<HistoryItem[]> {
    const txids = await this.client.rpc<string[]>('getaddresstxids', [{ addresses }]);
    // The node does not say which address, or at what height; the first is enough for the contract
    return txids.map(txid => ({ txid, height: 1, address: addresses[0] }));
  }

  getTransaction(txid: string): Promise<object> {
    return this.client.getRawTransaction(txid, true);
  }

  broadcast(rawTxHex: string): Promise<string> {
    return this.client.broadcastTransaction(rawTxHex);
  }

  onNewBlock(): () => void {
    throw new BackendError('server-error', 'The standard server has no push; the wallet refreshes on its own');
  }

  onAddressChange(): () => void {
    throw new BackendError('server-error', 'The standard server has no push; the wallet refreshes on its own');
  }
}

export function rpcBackendFor(client: RPCClient): RpcBackend {
  return new RpcBackend(client, client.getNetwork());
}

