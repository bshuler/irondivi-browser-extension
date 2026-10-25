import { describe, expect, it } from 'vitest';
import fixture from './fixtures/irondivi-connect-v1.json';
import {
  CLOCK_SKEW_MS, ConnectError, IDC_ERR, WalletSession, deriveKeys, open, parseUri, toAmount, unb64u, validateParams,
  type Envelope,
} from './irondivi-connect';

// The wallet end of IronDivi Connect matches the reference library byte for
// byte: the fixture was sealed by irondivi-connect src/irondivi-connect.js

const TS = 1790000000000;
const NOW = TS / 1000;
const ADDR = 'yGpZVzXypG13pEhNkieYBiEvpXsf5PqXnY';

describe('interop with the reference library', () => {
  it('derives the same topic and relay URL from the pairing code', async () => {
    const s = await WalletSession.pair(fixture.uri, NOW);
    expect(s.topic).toBe(fixture.topic);
    expect(s.url()).toBe(fixture.url);
    expect(s.state.origin).toBe('https://games.divi.domains');
    expect(s.state.network).toBe('testnet');
  });

  it('opens every envelope the reference sealed, in both directions', async () => {
    const keys = await deriveKeys(unb64u(fixture.k));
    for (const m of fixture.messages) {
      expect(await open(keys, m.envelope as Envelope)).toEqual(m.plaintext);
    }
  });

  it('a session the reference stored restores here', async () => {
    const s = await WalletSession.restore(fixture.toJSON as any);
    expect(s.topic).toBe(fixture.topic);
    expect(s.toJSON()).toEqual(fixture.toJSON);
  });

  it('receives the page messages in order and drops replays and the wrong direction', async () => {
    const s = await WalletSession.pair(fixture.uri, NOW);
    const [connect, reply, send, rejected, bye] = fixture.messages.map(m => m.envelope as Envelope);
    expect(await s.receive(reply, TS)).toBeNull();                // our own direction
    expect((await s.receive(connect, TS))?.method).toBe('irondivi_connect');
    expect(await s.receive(connect, TS)).toBeNull();              // replay
    expect((await s.receive(send, TS))?.params.memo).toBe('héllo ✓');
    expect(await s.receive(send, TS)).toBeNull();
    expect(await s.receive(rejected, TS)).toBeNull();
    expect((await s.receive(bye, TS))?.method).toBe('irondivi_disconnect');
  });

  it('drops a message whose clock is more than 15 minutes off, and a tampered one', async () => {
    const env = fixture.messages[0].envelope as Envelope;
    const late = await WalletSession.pair(fixture.uri, NOW);
    expect(await late.receive(env, TS + CLOCK_SKEW_MS + 1)).toBeNull();
    const early = await WalletSession.pair(fixture.uri, NOW);
    expect(await early.receive(env, TS - CLOCK_SKEW_MS - 1)).toBeNull();
    const t = await WalletSession.pair(fixture.uri, NOW);
    const c = env.c.slice(0, -2) + (env.c.endsWith('A') ? 'BB' : 'AA');
    expect(await t.receive({ ...env, c }, TS)).toBeNull();
    expect(t.state.seqIn).toBe(0);
  });

  it('what it seals, the page end opens with the wallet->dapp key', async () => {
    const s = await WalletSession.pair(fixture.uri, NOW);
    const env = await s.sealOut({ jsonrpc: '2.0', id: 1, result: 'x' }, TS);
    expect(env.d).toBe('w');
    const keys = await deriveKeys(unb64u(fixture.k));
    expect(await open(keys, env)).toEqual({ seq: 1, ts: TS, rpc: { jsonrpc: '2.0', id: 1, result: 'x' } });
    // The other direction's key does not open it
    await expect(open(keys, { ...env, d: 'd' })).rejects.toThrow();
  });
});

describe('parseUri', () => {
  const good = fixture.uri;
  const code = (f: () => unknown) => { try { f(); } catch (e) { return (e as ConnectError).code; } return 'ok'; };
  it('refuses an expired code, another scheme, another version, a short key, a bad origin, http relays, unknown networks', () => {
    expect(code(() => parseUri(good, 4102444800))).toBe(IDC_ERR.INVALID_PARAMS);
    expect(code(() => parseUri('wc:abc', NOW))).toBe(IDC_ERR.INVALID_PARAMS);
    expect(code(() => parseUri(good.replace(':v1?', ':v2?'), NOW))).toBe(IDC_ERR.UNSUPPORTED);
    expect(code(() => parseUri(good.replace(/k=[^&]+/, 'k=AAAA'), NOW))).toBe(IDC_ERR.INVALID_PARAMS);
    expect(code(() => parseUri(good.replace(/o=[^&]+/, 'o=' + encodeURIComponent('https://games.divi.domains/path')), NOW))).toBe(IDC_ERR.INVALID_PARAMS);
    expect(code(() => parseUri(good.replace(/r=[^&]+/, 'r=' + encodeURIComponent('http://divi.cx/connect')), NOW))).toBe(IDC_ERR.INVALID_PARAMS);
    expect(code(() => parseUri(good.replace('n=testnet', 'n=regtest'), NOW))).toBe(IDC_ERR.INVALID_PARAMS);
    expect(code(() => parseUri('  ' + good + '\n', NOW))).toBe('ok');
  });
});

describe('answer', () => {
  const ok = async () => ({ address: ADDR });
  it('refuses everything but connect before connecting (4100), and a network mismatch (4901)', async () => {
    const s = await WalletSession.pair(fixture.uri, NOW);
    const r1 = await s.answer({ jsonrpc: '2.0', id: 1, method: 'irondivi_signMessage', params: { message: 'hi', address: ADDR } }, ok);
    expect(r1?.error?.code).toBe(4100);
    const r2 = await s.answer({ jsonrpc: '2.0', id: 2, method: 'irondivi_connect', params: { origin: 'https://x.y', name: 'X', network: 'mainnet' } }, ok);
    expect(r2?.error?.code).toBe(4901);
    expect(s.state.connected).toBe(false);
    const r3 = await s.answer({ jsonrpc: '2.0', id: 3, method: 'irondivi_connect', params: { origin: 'https://x.y', name: 'X', network: 'testnet' } }, ok);
    expect(r3).toEqual({ jsonrpc: '2.0', id: 3, result: { address: ADDR } });
    expect(s.state).toMatchObject({ connected: true, account: ADDR, name: 'X' });
  });

  it('passes a handler error code through, and bad params are -32602 before the handler runs', async () => {
    const s = await WalletSession.restore({ ...(fixture.toJSON as any), connected: true });
    let ran = false;
    const r = await s.answer({ jsonrpc: '2.0', id: 1, method: 'irondivi_sendTransaction', params: { to: ADDR, amount: 1 } }, async () => { ran = true; });
    expect(r?.error?.code).toBe(-32602);
    expect(ran).toBe(false);
    const big = await s.answer({ jsonrpc: '2.0', id: 2, method: 'irondivi_sendTransaction', params: { to: ADDR, amount: '1', memo: 'x'.repeat(513) } }, async () => { ran = true; });
    expect(big?.error?.code).toBe(-32602);
    const no = await s.answer({ jsonrpc: '2.0', id: 3, method: 'irondivi_getBalance' }, async () => { throw new ConnectError(4001, 'no'); });
    expect(no?.error).toEqual({ code: 4001, message: 'no' });
    const boom = await s.answer({ jsonrpc: '2.0', id: 4, method: 'irondivi_getBalance' }, async () => { throw new Error('x'); });
    expect(boom?.error?.code).toBe(-32603);
    expect(await s.answer({ jsonrpc: '2.0', method: 'irondivi_getBalance' }, ok)).toBeNull();
  });
});

describe('params', () => {
  it('amounts are canonical DIVI decimals above zero', () => {
    expect(toAmount('1.25')).toBe('1.25');
    expect(toAmount(0.1)).toBe('0.1');
    for (const v of ['0', '01', '1.123456789', '-1', '1e3', '']) expect(() => toAmount(v)).toThrow();
    expect(() => validateParams('irondivi_signMessage', { message: '', address: ADDR })).toThrow();
    expect(() => validateParams('irondivi_signMessage', { message: 'x'.repeat(4097), address: ADDR })).toThrow();
  });
  it('a stored session must be a wallet one', async () => {
    await expect(WalletSession.restore({ ...(fixture.toJSON as any), role: 'dapp' })).rejects.toThrow();
    await expect(WalletSession.restore({ ...(fixture.toJSON as any), relay: 'http://evil' })).rejects.toThrow();
  });
});
