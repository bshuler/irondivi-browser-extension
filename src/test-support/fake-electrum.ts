/**
 * A WebSocket Electrum server for tests: one JSON-RPC message per text frame,
 * answering from state the test sets up, and able to push a header and a
 * scripthash notification on demand. Stand-in for lane L3's fake server
 * (packages/divi-electrum-client/test/fake-server.mjs) until that is vendored.
 */
import { createServer, type Server } from 'http';
import type { AddressInfo } from 'net';
import { createRequire } from 'module';
import { addressToScripthash, GENESIS } from '../../vendor/divi-electrum-client.esm.js';
import type { Network } from '../background/backend/types';

// Playwright bundles the ws package; it is a declared dev dependency
const { wsServer: WSServer } = createRequire(import.meta.url)('playwright-core/lib/utilsBundle');

export interface FakeCoin { txid: string; vout: number; value: number; height: number }
export interface FakeHistory { txid: string; height: number }

export class FakeElectrum {
  tip = 1000;
  network: Network;
  /** The prev-hash block 1 claims, so a test can fake the wrong chain */
  genesis: string;
  versionReply: unknown = ['IronDivi 0.2.8', '1.4'];
  balances = new Map<string, { confirmed: number; unconfirmed: number }>();
  coins = new Map<string, FakeCoin[]>();
  history = new Map<string, FakeHistory[]>();
  rawHex = new Map<string, string>();
  verbose = new Map<string, object>();
  broadcasts: string[] = [];
  requests: string[] = [];
  private server!: Server;
  private wss: any;
  private readonly sockets = new Set<any>();
  private subscribed = new Set<string>();
  port = 0;

  constructor(network: Network = 'mainnet') {
    this.network = network;
    this.genesis = GENESIS[network];
  }

  get url(): string { return `ws://127.0.0.1:${this.port}`; }

  async start(): Promise<void> {
    this.server = createServer();
    this.wss = new WSServer({ server: this.server });
    this.wss.on('connection', (sock: any) => {
      this.sockets.add(sock);
      sock.on('close', () => this.sockets.delete(sock));
      sock.on('message', (raw: Buffer) => this.handle(sock, JSON.parse(raw.toString())));
    });
    await new Promise<void>(r => this.server.listen(0, '127.0.0.1', r));
    this.port = (this.server.address() as AddressInfo).port;
  }

  async stop(): Promise<void> {
    for (const s of this.sockets) s.terminate();
    this.wss.close();
    await new Promise<void>(r => this.server.close(() => r()));
  }

  /** Drop every connection, as a server restart or a lost VPN would */
  dropConnections(): void {
    for (const s of this.sockets) s.terminate();
  }

  sh(address: string): string { return addressToScripthash(address, this.network); }

  setBalance(address: string, confirmed: number, unconfirmed = 0): void {
    this.balances.set(this.sh(address), { confirmed, unconfirmed });
  }
  setCoins(address: string, coins: FakeCoin[]): void { this.coins.set(this.sh(address), coins); }
  setHistory(address: string, items: FakeHistory[]): void { this.history.set(this.sh(address), items); }

  private header(height: number): string {
    const bytes = Buffer.alloc(112);
    if (height === 1) Buffer.from(this.genesis, 'hex').reverse().copy(bytes, 4);
    return bytes.toString('hex');
  }

  /** Mine a block and tell every subscriber */
  pushBlock(): void {
    this.tip++;
    this.send({ jsonrpc: '2.0', method: 'blockchain.headers.subscribe', params: [{ height: this.tip, hex: this.header(this.tip) }] });
  }

  /** Tell subscribers an address changed */
  pushAddress(address: string, status = 'ff'): void {
    const sh = this.sh(address);
    if (this.subscribed.has(sh)) this.send({ jsonrpc: '2.0', method: 'blockchain.scripthash.subscribe', params: [sh, status] });
  }

  private send(msg: unknown): void {
    for (const s of this.sockets) s.send(JSON.stringify(msg));
  }

  private handle(sock: any, req: { id: number; method: string; params: any[] }): void {
    this.requests.push(req.method);
    const reply = (result: unknown) => sock.send(JSON.stringify({ jsonrpc: '2.0', id: req.id, result }));
    const error = (message: string) => sock.send(JSON.stringify({ jsonrpc: '2.0', id: req.id, error: { code: -1, message } }));
    const p = req.params;
    switch (req.method) {
      case 'server.version': return reply(this.versionReply);
      case 'blockchain.block.header': return reply(this.header(p[0]));
      case 'blockchain.headers.subscribe': return reply({ height: this.tip, hex: this.header(this.tip) });
      case 'blockchain.scripthash.get_balance': return reply(this.balances.get(p[0]) ?? { confirmed: 0, unconfirmed: 0 });
      case 'blockchain.scripthash.listunspent':
        return reply((this.coins.get(p[0]) ?? []).map(c => ({ tx_hash: c.txid, tx_pos: c.vout, value: c.value, height: c.height })));
      case 'blockchain.scripthash.get_history':
        return reply((this.history.get(p[0]) ?? []).map(h => ({ tx_hash: h.txid, height: h.height })));
      case 'blockchain.scripthash.subscribe': this.subscribed.add(p[0]); return reply(null);
      case 'blockchain.scripthash.unsubscribe': return reply(this.subscribed.delete(p[0]));
      case 'blockchain.transaction.get': {
        if (p[1]) return this.verbose.has(p[0]) ? reply(this.verbose.get(p[0])) : error('no such transaction');
        return this.rawHex.has(p[0]) ? reply(this.rawHex.get(p[0])) : error('no such transaction');
      }
      case 'blockchain.transaction.broadcast': {
        this.broadcasts.push(p[0]);
        return reply(this.txidOf(p[0]));
      }
      default: return error(`unknown method ${req.method}`);
    }
  }

  /** Set by tests that broadcast: how the server names the transaction it accepted */
  txidOf: (hex: string) => string = () => '00'.repeat(32);
}
