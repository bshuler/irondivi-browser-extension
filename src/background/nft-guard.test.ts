import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createRequire } from 'module';
import { createHarness, TEST_MNEMONIC, TEST_PASSWORD, type Harness } from '../test-support/harness';
import { FakeElectrum } from '../test-support/fake-electrum';
import { Mnemonic } from '../lib/mnemonic';
import { deriveAddresses } from '../lib/derivation';
import { Transaction } from '../lib/transaction';
import { hexToBytes } from '../lib/hex';
import { p2pkhScript } from './wallet-core';
import VECTORS from './fixtures/nft-vectors.json';

// NFT coin guard (nft-guard.ts): DT/1 colored outputs never reach coin
// selection, on the RPC path and through an Electrum server, and the input
// check refuses one even if the filter was fooled. fixtures/nft-vectors.json
// was made with divi-nft's own payload encoder (shared with the web wallet
// and the Telegram Mini App in divi-infrastructure).

const { ws: WS } = createRequire(import.meta.url)('playwright-core/lib/utilsBundle');

vi.setConfig({ testTimeout: 30000 });

const sorted = (a: number[]) => [...a].sort((x, y) => x - y);
const ISSUE = VECTORS.find(v => v.name.startsWith('ISSUE to vout 0'))!;
const txidOf = (i: number) => i.toString(16).padStart(64, '0');

// A raw transaction with the given output scripts (hex), each worth `value`
function rawTx(scripts: string[], seed: number, value = 1000n): Transaction {
  const tx = new Transaction();
  tx.inputs.push({ txid: txidOf(seed), vout: 0, script: '', sequence: 0xffffffff });
  for (const s of scripts) tx.outputs.push({ value, script: hexToBytes(s) });
  return tx;
}

async function foreignAddress(): Promise<string> {
  const seed = await Mnemonic.toSeed(TEST_MNEMONIC, 'other-account');
  const [a] = await deriveAddresses(seed, 'testnet', 0, 1);
  return a.address;
}

describe('coloredVouts', () => {
  let coloredVouts: typeof import('./nft-guard').coloredVouts;
  beforeAll(async () => {
    vi.resetModules();
    await createHarness(); // the guard's module reads the browser API on load
    ({ coloredVouts } = await import('./nft-guard'));
  });

  it('vectors: colored outputs match divi-nft', () => {
    expect(VECTORS.length).toBeGreaterThanOrEqual(13);
    for (const v of VECTORS) expect(sorted(coloredVouts(v.scripts)), v.name).toEqual(sorted(v.colored));
  });

  it('a "DIVA" in an odd-shaped OP_META holds every output', () => {
    expect(sorted(coloredVouts(['76a914' + '00'.repeat(20) + '88ac', '6a0444495641' + '0101']))).toEqual([0, 1]);
  });
});

describe('filterNftCoins', () => {
  let guard: typeof import('./nft-guard');
  beforeEach(async () => {
    vi.resetModules();
    await createHarness(); // fake browser storage
    guard = await import('./nft-guard');
  });

  const fetcher = (txs: Map<string, Transaction>) => async (id: string) => {
    const t = txs.get(id);
    if (!t) throw new Error('No such transaction');
    return t.toHex();
  };

  it('held coins name their reason, the rest stay spendable in order', async () => {
    const txs = new Map<string, Transaction>();
    const coins: Array<{ txid: string; vout: number }> = [];
    const expectHeld: string[] = [];
    VECTORS.forEach((v, i) => {
      const tx = rawTx(v.scripts, i + 1);
      txs.set(tx.txid(), tx);
      v.scripts.forEach((_, n) => coins.push({ txid: tx.txid(), vout: n }));
      v.colored.forEach(n => expectHeld.push(`${tx.txid()}:${n}`));
    });
    const { spendable, held } = await guard.filterNftCoins('testnet', coins, fetcher(txs));
    expect(held.map(x => `${x.coin.txid}:${x.coin.vout}`).sort()).toEqual(expectHeld.sort());
    expect(held.every(x => x.reason === 'nft')).toBe(true);
    expect(spendable.length + held.length).toBe(coins.length);
    const order = spendable.map(c => coins.indexOf(c));
    expect(order).toEqual(sorted(order));
  });

  it('sale proceeds and change from a TRANSFER stay spendable', async () => {
    const sale = VECTORS.find(v => v.name.startsWith('sale TRANSFER'))!;
    const tx = rawTx(sale.scripts, 1);
    const id = tx.txid();
    const r = await guard.filterNftCoins('testnet', [0, 1, 3].map(vout => ({ txid: id, vout })), async () => tx.toHex());
    expect(r.held.map(x => x.coin.vout)).toEqual([0]);
    expect(r.spendable.map(c => c.vout)).toEqual([1, 3]);
  });

  it('unknown status holds the coin and is not cached', async () => {
    const tx = rawTx(VECTORS[0].scripts, 7);
    let calls = 0;
    let fail = true;
    const fetch = async () => { calls++; if (fail) throw new Error('down'); return tx.toHex(); };
    const coin = { txid: tx.txid(), vout: 0 };
    let r = await guard.filterNftCoins('testnet', [coin], fetch);
    expect(r.held.map(x => x.reason)).toEqual(['unknown']);
    expect(r.spendable).toHaveLength(0);
    fail = false;
    r = await guard.filterNftCoins('testnet', [coin], fetch);
    expect(r.spendable).toHaveLength(1);
    expect(calls).toBe(2);
  });

  it('replies that are not the transaction asked for are unknown', async () => {
    const tx = rawTx(VECTORS[0].scripts, 5);
    const other = rawTx(VECTORS[0].scripts, 6);
    for (const reply of ['', 'zz', '00', other.toHex(), tx.toHex().slice(0, -2)]) {
      const r = await guard.filterNftCoins('testnet', [{ txid: tx.txid(), vout: 0 }], async () => reply);
      expect(r.held.map(x => x.reason), reply.slice(0, 20)).toEqual(['unknown']);
    }
  });

  it('a vout past the end of the parent, or missing, is unknown', async () => {
    const tx = rawTx(VECTORS[0].scripts, 3);
    const id = tx.txid();
    const r = await guard.filterNftCoins('testnet', [{ txid: id, vout: 9 }, { txid: id }, { txid: id, vout: -1 }], async () => tx.toHex());
    expect(r.held.map(x => x.reason)).toEqual(['unknown', 'unknown', 'unknown']);
  });

  it('accepts coins keyed by outputIndex as well as vout', async () => {
    const tx = rawTx(ISSUE.scripts, 4);
    const r = await guard.filterNftCoins('testnet', [{ txid: tx.txid(), outputIndex: 0 }, { txid: tx.txid(), outputIndex: 2 }], async () => tx.toHex());
    expect(r.held.map(x => x.coin.outputIndex)).toEqual([0]);
    expect(r.spendable.map(c => c.outputIndex)).toEqual([2]);
  });

  it('results persist in storage, per network: a restarted worker reads them offline', async () => {
    const tx = rawTx(ISSUE.scripts, 8);
    let calls = 0;
    await guard.filterNftCoins('testnet', [{ txid: tx.txid(), vout: 0 }], async () => (calls++, tx.toHex()));
    await guard.filterNftCoins('testnet', [{ txid: tx.txid(), vout: 2 }], async () => (calls++, tx.toHex()));
    expect(calls).toBe(1);

    guard.resetNftGuardMemory();
    const offline = async (): Promise<string> => { throw new Error('offline'); };
    const r = await guard.filterNftCoins('testnet', [{ txid: tx.txid(), vout: 0 }, { txid: tx.txid(), vout: 2 }], offline);
    expect(r.held.map(x => x.reason)).toEqual(['nft']);
    expect(r.spendable).toHaveLength(1);
    // Mainnet has its own cache
    const m = await guard.filterNftCoins('mainnet', [{ txid: tx.txid(), vout: 2 }], offline);
    expect(m.held.map(x => x.reason)).toEqual(['unknown']);
  });

  it('a corrupt cache entry is ignored', async () => {
    const { storage } = await import('../shared/browser-polyfill');
    const tx = rawTx(VECTORS[0].scripts, 2);
    await storage.local.set({ 'nftGuard:testnet': { [tx.txid()]: ['x'] } });
    let calls = 0;
    const r = await guard.filterNftCoins('testnet', [{ txid: tx.txid(), vout: 0 }], async () => (calls++, tx.toHex()));
    expect(r.spendable).toHaveLength(1);
    expect(calls).toBe(1);
  });

  it('fetches run at most 8 at a time, once per transaction', async () => {
    let live = 0;
    let peak = 0;
    const seen: string[] = [];
    const txs = new Map<string, Transaction>();
    const coins: Array<{ txid: string; vout: number }> = [];
    for (let i = 0; i < 40; i++) {
      const tx = rawTx(VECTORS[0].scripts, 100 + i);
      txs.set(tx.txid(), tx);
      coins.push({ txid: tx.txid(), vout: 0 }, { txid: tx.txid(), vout: 0 });
    }
    const r = await guard.filterNftCoins('testnet', coins, async id => {
      seen.push(id);
      live++;
      peak = Math.max(peak, live);
      await new Promise(res => setTimeout(res, 2));
      live--;
      return txs.get(id)!.toHex();
    });
    expect(r.spendable).toHaveLength(80);
    expect(seen).toHaveLength(40);
    expect(peak).toBeLessThanOrEqual(8);
    expect(peak).toBeGreaterThan(1);
  });
});

// The wallet end to end: the node lists the NFT coin like any other
describe('sending', () => {
  let h: Harness;
  let addr: string;
  let nftTx: Transaction;

  async function noLimits() {
    const { data } = await h.popup('GET_SETTINGS');
    const r = await h.popup('UPDATE_SETTINGS', {
      transactionLimits: { ...data.settings.transactionLimits, maxAmountAbsolute: 0, maxAmountPercent: 0, dailyLimitAbsolute: 0, dailyLimitPercent: 0 },
      password: TEST_PASSWORD,
    });
    expect(r.success).toBe(true);
  }

  // [500 DIVI with the NFT, ISSUE payload, 200 DIVI change] to our address,
  // in place of the 1000 DIVI coin the harness funds
  function holdOnlyNftAndChange(): string {
    h.utxos.splice(0);
    nftTx = new Transaction();
    nftTx.inputs.push({ txid: txidOf(0xa1), vout: 0, script: '', sequence: 0xffffffff });
    nftTx.outputs.push(
      { value: 500n * 100000000n, script: hexToBytes(p2pkhScript(addr)) },
      { value: 0n, script: hexToBytes(ISSUE.scripts[1]) },
      { value: 200n * 100000000n, script: hexToBytes(p2pkhScript(addr)) },
    );
    const txid = nftTx.txid();
    h.rawHex[txid] = nftTx.toHex();
    h.utxos.push({ address: addr, satoshis: 500e8, txid, vout: 0 }, { address: addr, satoshis: 200e8, txid, vout: 2 });
    return txid;
  }

  beforeEach(async () => {
    vi.resetModules();
    h = await createHarness();
    const account = await h.setupWallet();
    addr = account.addresses[0].address;
    await noLimits();
  });

  it('the fixture really is an ISSUE coloring output 0', () => {
    expect(ISSUE.scripts[1].startsWith('6a')).toBe(true);
    expect(ISSUE.colored).toEqual([0]);
  });

  it('RPC path: spends the change, never the NFT coin', async () => {
    const txid = holdOnlyNftAndChange();
    const r = await h.popup('SEND_TRANSACTION', { password: TEST_PASSWORD, to: await foreignAddress(), amount: 100 });
    expect(r.error).toBeUndefined();
    expect(h.broadcasts).toHaveLength(1);
    const sent = Transaction.fromHex(h.broadcasts[0]);
    expect(sent.inputs.map(i => `${i.txid}:${i.vout}`)).toEqual([`${txid}:2`]);
  });

  it('RPC path: an amount only the NFT coin could cover is refused, saying why', async () => {
    holdOnlyNftAndChange();
    const r = await h.popup('SEND_TRANSACTION', { password: TEST_PASSWORD, to: await foreignAddress(), amount: 300 });
    expect(r.success).toBe(false);
    expect(r.error).toMatch(/Insufficient funds.*Divi NFT/);
    expect(h.broadcasts).toHaveLength(0);
  });

  it('a coin whose parent the node will not return is held, not spent', async () => {
    const txid = h.utxos[0].txid;
    delete h.rawHex[txid];
    const r = await h.popup('SEND_TRANSACTION', { password: TEST_PASSWORD, to: await foreignAddress(), amount: 1 });
    expect(r.success).toBe(false);
    expect(r.error).toMatch(/could not be checked/);
    expect(h.broadcasts).toHaveLength(0);
  });

  it('the input check refuses an NFT coin even when the filter was fooled', async () => {
    const txid = holdOnlyNftAndChange();
    // A poisoned cache says the transaction is plain; the input check reads
    // the transaction itself
    const { storage } = await import('../shared/browser-polyfill');
    await storage.local.set({ 'nftGuard:testnet': { [txid]: [3] } });
    const r = await h.popup('SEND_TRANSACTION', { password: TEST_PASSWORD, to: await foreignAddress(), amount: 600 });
    expect(r.success).toBe(false);
    expect(r.error).toMatch(/carries a Divi NFT/);
    expect(h.broadcasts).toHaveLength(0);
  });
});

describe('sending through an Electrum server', () => {
  let h: Harness;
  let server: FakeElectrum;
  let addr: string;
  let originalWebSocket: unknown;

  beforeEach(async () => {
    vi.resetModules();
    originalWebSocket = (globalThis as any).WebSocket;
    (globalThis as any).WebSocket = WS;
    h = await createHarness();
    const account = await h.setupWallet();
    addr = account.addresses[0].address;
    server = new FakeElectrum('testnet');
    await server.start();
    const { chain } = await import('./chain');
    chain.webSocket = class extends WS { constructor() { super(server.url); } };
    server.txidOf = hex => Transaction.fromHex(hex).txid();
    const { data } = await h.popup('GET_SETTINGS');
    await h.popup('UPDATE_SETTINGS', {
      transactionLimits: { ...data.settings.transactionLimits, maxAmountAbsolute: 0, maxAmountPercent: 0, dailyLimitAbsolute: 0, dailyLimitPercent: 0 },
      password: TEST_PASSWORD,
    });
  });

  afterEach(async () => {
    await server.stop();
    (globalThis as any).WebSocket = originalWebSocket;
  });

  it('listunspent lists the NFT coin; the wallet spends only the change', async () => {
    const tx = new Transaction();
    tx.inputs.push({ txid: txidOf(0xb2), vout: 0, script: '', sequence: 0xffffffff });
    tx.outputs.push(
      { value: 500n * 100000000n, script: hexToBytes(p2pkhScript(addr)) },
      { value: 0n, script: hexToBytes(ISSUE.scripts[1]) },
      { value: 200n * 100000000n, script: hexToBytes(p2pkhScript(addr)) },
    );
    const txid = tx.txid();
    server.rawHex.set(txid, tx.toHex());
    server.setBalance(addr, 700 * 1e8, 0);
    server.setCoins(addr, [{ txid, vout: 0, value: 500 * 1e8, height: 990 }, { txid, vout: 2, value: 200 * 1e8, height: 990 }]);
    server.setHistory(addr, [{ txid, height: 990 }]);
    const saved = await h.popup('SET_SERVER', { network: 'testnet', mode: 'own', url: 'wss://box.example:50004' });
    expect(saved.success).toBe(true);

    const big = await h.popup('SEND_TRANSACTION', { password: TEST_PASSWORD, to: await foreignAddress(), amount: 300 });
    expect(big.error).toMatch(/Divi NFT/);
    expect(server.broadcasts).toHaveLength(0);

    const r = await h.popup('SEND_TRANSACTION', { password: TEST_PASSWORD, to: await foreignAddress(), amount: 100 });
    expect(r.error).toBeUndefined();
    expect(server.broadcasts).toHaveLength(1);
    expect(Transaction.fromHex(server.broadcasts[0]).inputs.map(i => `${i.txid}:${i.vout}`)).toEqual([`${txid}:2`]);
  });
});
