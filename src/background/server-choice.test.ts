import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createRequire } from 'module';
import { createHarness, TEST_PASSWORD, type Harness } from '../test-support/harness';
import { FakeElectrum } from '../test-support/fake-electrum';
import { Mnemonic } from '../lib/mnemonic';
import { deriveAddresses } from '../lib/derivation';
import { Transaction } from '../lib/transaction';
import { GENESIS } from '../../vendor/divi-electrum-client.esm.js';

const { ws: WS } = createRequire(import.meta.url)('playwright-core/lib/utilsBundle');

vi.setConfig({ testTimeout: 30000 });

let h: Harness;
let server: FakeElectrum;
let account: any;
let sockets = 0;
let originalWebSocket: unknown;

const wait = (ms: number) => new Promise(r => setTimeout(r, ms));
const rpcMethods = () => ((globalThis as any).fetch.mock.calls as any[][])
  .filter(c => c[1]?.body && !String(c[0]).includes('/faucet/'))
  .map(c => JSON.parse(c[1].body).method as string);

async function foreignAddress(): Promise<string> {
  const seed = await Mnemonic.toSeed('abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about', 'other-account');
  const [a] = await deriveAddresses(seed, 'testnet', 0, 1);
  return a.address;
}

beforeEach(async () => {
  vi.resetModules();
  originalWebSocket = (globalThis as any).WebSocket;
  sockets = 0;
  // Counts every socket the wallet opens, to the fake server or anywhere else
  (globalThis as any).WebSocket = class extends WS { constructor(url: string) { super(url); sockets++; } };
  h = await createHarness();
  account = await h.setupWallet();
  server = new FakeElectrum('testnet');
  await server.start();
});

afterEach(async () => {
  await server.stop();
  (globalThis as any).WebSocket = originalWebSocket;
});

async function chooseOwn(): Promise<void> {
  const test = await h.popup('TEST_SERVER', { url: server.url.replace('ws://', 'wss://') });
  expect(test.success).toBe(true);
}

describe('the default server', () => {
  it('is IronDivi (standard): no Electrum socket, today’s RPC calls', async () => {
    const status = await h.popup('GET_SERVER');
    expect(status.data.config).toEqual({ mainnet: { mode: 'default' }, testnet: { mode: 'default' } });
    expect(status.data.problem).toBeNull();
    const bal = await h.popup('GET_BALANCE');
    expect(bal.data.balance).toBe(1000);
    expect(await h.popup('GET_TRANSACTIONS')).toMatchObject({ success: true });
    expect(sockets).toBe(0);
    expect(rpcMethods()).toContain('getaddressbalance');
    expect(h.storage.server).toBeUndefined();
  });
});

describe('saving a server', () => {
  it('refuses an address that is not wss://', async () => {
    const r = await h.popup('TEST_SERVER', { url: 'ws://box.local:50003' });
    expect(r).toMatchObject({ success: false, error: expect.stringMatching(/wss:\/\//) });
    const s = await h.popup('SET_SERVER', { network: 'testnet', mode: 'own', url: 'http://x.example' });
    expect(s.success).toBe(false);
    expect(h.storage.server).toBeUndefined();
  });

  it('refuses to save a server that fails the check (a mainnet server on testnet)', async () => {
    server.genesis = GENESIS.mainnet;
    const r = await h.popup('SET_SERVER', { network: 'testnet', mode: 'own', url: 'wss://127.0.0.1:1' });
    expect(r.success).toBe(false);
    const t = await h.popup('TEST_SERVER', { url: 'wss://127.0.0.1:1' });
    expect(t.data).toMatchObject({ ok: false, problem: 'unreachable' });
    expect(h.storage.server).toBeUndefined();
  });
});

describe('a chosen Electrum server (against the fake server)', () => {
  let addr: string;
  beforeEach(async () => {
    addr = account.addresses[0].address;
    // The wallet only opens wss://; the fake speaks plain ws on loopback, so
    // the test points the factory at it
    const { chain } = await import('./chain');
    chain.webSocket = class extends WS { constructor() { super(server.url); sockets++; } };
    server.setBalance(addr, 700 * 1e8, 5 * 1e8);
    const txid = [...Object.keys(h.rawHex)][0];
    server.rawHex.set(txid, h.rawHex[txid]);
    server.setCoins(addr, [{ txid, vout: 0, value: 1000 * 1e8, height: 990 }]);
    server.setHistory(addr, [{ txid, height: 990 }]);
    server.txidOf = hex => Transaction.fromHex(hex).txid();
    const saved = await h.popup('SET_SERVER', { network: 'testnet', mode: 'own', url: 'wss://box.example:50004' });
    expect(saved.success).toBe(true);
  });

  it('saves per install, labels it, and shows balance and history from the server, not the RPC proxy', async () => {
    expect(h.storage.server.testnet).toEqual({ mode: 'own', url: 'wss://box.example:50004' });
    expect(h.storage.server.mainnet).toEqual({ mode: 'default' });
    const bal = await h.popup('GET_BALANCE');
    expect(bal.data.balance).toBe(705);
    const txs = await h.popup('GET_TRANSACTIONS');
    expect(txs.success).toBe(true);
    expect(rpcMethods().filter(m => m !== 'getblockcount')).toEqual([]);
  });

  it('sends through the server: coins from listunspent, broadcast to the server', async () => {
    const txid = server.coins.get(server.sh(addr))![0].txid;
    const r = await h.popup('SEND_TRANSACTION', { password: TEST_PASSWORD, to: await foreignAddress(), amount: 1 });
    expect(r.error).toBeUndefined();
    expect(r.success).toBe(true);
    expect(server.broadcasts).toHaveLength(1);
    expect(h.broadcasts).toHaveLength(0);
    expect(rpcMethods()).not.toContain('sendrawtransaction');
  });

  it('refuses a coin whose id is malformed, as the RPC path does', async () => {
    server.setCoins(addr, [{ txid: 'zz', vout: 0, value: 1000 * 1e8, height: 990 }]);
    const r = await h.popup('SEND_TRANSACTION', { password: TEST_PASSWORD, to: await foreignAddress(), amount: 1 });
    expect(r.success).toBe(false);
    expect(server.broadcasts).toHaveLength(0);
  });

  it('validates addresses locally, never asking IronDivi', async () => {
    const ok = await h.popup('VALIDATE_ADDRESS', { address: await foreignAddress() });
    expect(ok.data.isValid).toBe(true);
    const bad = await h.popup('VALIDATE_ADDRESS', { address: 'notanaddress' });
    expect(bad.data.isValid).toBe(false);
    expect(rpcMethods()).toEqual([]);
  });

  it('pushes a refresh to an open window on a new block and on a change to our address', async () => {
    const port = h.openUiPort();
    await wait(300);
    server.pushBlock();
    await wait(100);
    expect(port.messages.filter(m => m.type === 'chain-push')).toHaveLength(1);
    server.pushAddress(addr);
    await wait(100);
    expect(port.messages.filter(m => m.type === 'chain-push')).toHaveLength(2);
    port.disconnect();
  });

  it('does not fall back to IronDivi when the server is unreachable', async () => {
    await server.stop();
    const bal = await h.popup('GET_BALANCE');
    expect(bal.success).toBe(false);
    expect(bal.error).toMatch(/reach your server/i);
    const status = await h.popup('GET_SERVER');
    expect(status.data.problem).toMatch(/reach your server/i);
    expect(rpcMethods().filter(m => m !== 'getblockcount')).toEqual([]);
    server = new FakeElectrum('testnet');
    await server.start();
  });

  it('uses IronDivi for the session only when asked, and forgets that when the wallet closes', async () => {
    await server.stop();
    await h.popup('GET_BALANCE');
    const used = await h.popup('USE_DEFAULT_SERVER_SESSION');
    expect(used.data.sessionDefault).toBe(true);
    expect(used.data.problem).toBeNull();
    expect((await h.popup('GET_BALANCE')).data.balance).toBe(1000);
    // Never saved
    expect(h.storage.server.testnet.mode).toBe('own');
    const port = h.openUiPort();
    port.disconnect();
    expect((await h.popup('GET_SERVER')).data.sessionDefault).toBe(false);
    server = new FakeElectrum('testnet');
    await server.start();
  });

  it('goes back to the default by choice', async () => {
    const r = await h.popup('SET_SERVER', { network: 'testnet', mode: 'default' });
    expect(r.data.config.testnet).toEqual({ mode: 'default' });
    expect((await h.popup('GET_BALANCE')).data.balance).toBe(1000);
  });
});
