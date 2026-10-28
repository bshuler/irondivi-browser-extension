import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createHash } from 'crypto';
import { readFileSync } from 'fs';
import { createRequire } from 'module';
import { FakeElectrum } from '../../test-support/fake-electrum';
import {
  addressToScripthash, addressToScriptPubKey, checkServer, ElectrumBackend, GENESIS,
} from '../../../vendor/divi-electrum-client.esm.js';
import { Address } from '../../lib/address';

const { ws: WS } = createRequire(import.meta.url)('playwright-core/lib/utilsBundle');
const options = { WebSocket: WS };
const backendFor = (url: string, lastSeenTip?: number) =>
  new ElectrumBackend({ url, network: 'mainnet', lastSeenTip, WebSocket: WS });

// The address of the secp256k1 generator point; its scripthash is checked below
// against node's own sha256 rather than the wallet's.
const G = Uint8Array.from(Buffer.from('0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798', 'hex'));
const MAIN_ADDR = Address.fromPublicKey(G, 'mainnet');
const MAIN_SPK = '76a914' + Buffer.from(Address.decode(MAIN_ADDR).hash).toString('hex') + '88ac';

let server: FakeElectrum;
beforeEach(async () => { server = new FakeElectrum('mainnet'); await server.start(); });
afterEach(async () => { await server.stop(); });

describe('scripthash', () => {
  it('is the byte-reversed sha256 of the scriptPubKey', async () => {
    expect(addressToScriptPubKey(MAIN_ADDR, 'mainnet')).toBe(MAIN_SPK);
    const want = Buffer.from(createHash('sha256').update(Buffer.from(MAIN_SPK, 'hex')).digest()).reverse().toString('hex');
    expect(addressToScripthash(MAIN_ADDR, 'mainnet')).toBe(want);
  });
});

describe('the vendored package', () => {
  it('is the file recorded in vendor/README.md, unchanged', () => {
    const file = readFileSync(new URL('../../../vendor/divi-electrum-client.esm.js', import.meta.url));
    const readme = readFileSync(new URL('../../../vendor/README.md', import.meta.url), 'utf-8');
    const recorded = /sha256 ([0-9a-f]{64})/.exec(readme)?.[1];
    expect(createHash('sha256').update(file).digest('hex')).toBe(recorded);
  });
});

describe('checkServer (design §5)', () => {
  it('passes a mainnet server for mainnet and reports the block', async () => {
    const r = await checkServer(server.url, 'mainnet', undefined, options);
    expect(r).toMatchObject({ ok: true, network: 'mainnet', tip: 1000, problem: null, software: 'IronDivi 0.2.8' });
  });

  it('says a testnet server is a testnet server', async () => {
    server.genesis = GENESIS.testnet;
    const r = await checkServer(server.url, 'mainnet', undefined, options);
    expect(r).toMatchObject({ ok: false, problem: 'wrong-network', network: 'testnet' });
    expect(r.message).toMatch(/testnet server/);
  });

  it('calls a server far behind the last tip out of date', async () => {
    const r = await checkServer(server.url, 'mainnet', 1200, options);
    expect(r).toMatchObject({ ok: false, problem: 'behind' });
  });

  it('is unreachable when nothing listens', async () => {
    const dead = new FakeElectrum();
    await dead.start();
    const url = dead.url;
    await dead.stop();
    const r = await checkServer(url, 'mainnet', undefined, options);
    expect(r).toMatchObject({ ok: false, problem: 'unreachable' });
  });

  it('refuses a server that is not Electrum', async () => {
    server.versionReply = 'hello';
    expect(await checkServer(server.url, 'mainnet', undefined, options)).toMatchObject({ ok: false, problem: 'bad-reply' });
  });
});

describe('ElectrumBackend', () => {
  it('maps balance, coins, history and tip to the contract', async () => {
    const b = backendFor(server.url);
    server.setBalance(MAIN_ADDR, 500, -20);
    server.setCoins(MAIN_ADDR, [{ txid: 'a'.repeat(64), vout: 1, value: 480, height: 990 }]);
    server.setHistory(MAIN_ADDR, [{ txid: 'a'.repeat(64), height: 990 }, { txid: 'b'.repeat(64), height: 0 }]);
    expect(await b.getBalance([MAIN_ADDR])).toEqual({ confirmed: 500, unconfirmed: -20 });
    expect(await b.listUnspent([MAIN_ADDR])).toEqual([
      { txid: 'a'.repeat(64), vout: 1, value: 480, height: 990, address: MAIN_ADDR, scriptPubKey: MAIN_SPK },
    ]);
    expect(await b.getHistory([MAIN_ADDR])).toEqual([
      { txid: 'a'.repeat(64), height: 990, address: MAIN_ADDR },
      { txid: 'b'.repeat(64), height: 0, address: MAIN_ADDR },
    ]);
    expect(await b.getTipHeight()).toBe(1000);
    b.close();
  });

  it('carries a server error as server-error', async () => {
    const b = backendFor(server.url);
    await expect(b.getTransaction('c'.repeat(64))).rejects.toMatchObject({ code: 'server-error', message: 'no such transaction' });
    b.close();
  });

  it('pushes new blocks and address changes, and replays the subscription after a reconnect', async () => {
    const b = backendFor(server.url);
    const blocks: number[] = [];
    await b.connect();
    const changed: string[] = [];
    const offBlocks = b.onNewBlock((h: number) => blocks.push(h));
    const offAddr = b.onAddressChange([MAIN_ADDR], (a: string) => changed.push(a));
    await new Promise(r => setTimeout(r, 100));
    server.pushBlock();
    server.pushAddress(MAIN_ADDR);
    await new Promise(r => setTimeout(r, 100));
    expect(blocks).toEqual([1001]);
    expect(changed).toEqual([MAIN_ADDR]);

    server.dropConnections();
    await new Promise(r => setTimeout(r, 3000));
    server.pushAddress(MAIN_ADDR);
    await new Promise(r => setTimeout(r, 100));
    // The package re-sends the subscription and calls back if its state changed while away
    expect(changed.length).toBeGreaterThanOrEqual(2);
    expect(new Set(changed)).toEqual(new Set([MAIN_ADDR]));
    offBlocks();
    offAddr();
    b.close();
  });
});
