import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createHarness, TEST_MNEMONIC, TEST_PASSWORD, type Harness } from '../test-support/harness';
import { Mnemonic } from '../lib/mnemonic';
import { deriveAddresses } from '../lib/derivation';
import { b64u, deriveKeys, open, seal, type Envelope, type Keys } from '../lib/irondivi-connect';

// IronDivi Connect over the relay: the owner pastes a page's pairing URI and
// the wallet answers that page's requests through the relay, with the same
// approval windows as an in-page request, under its own "relay:<o>" grant.
// The relay here is a fake of divi.cx/connect; the page end is played by
// the test with the library's own envelope code.

vi.setConfig({ testTimeout: 30000 });

const RELAY = 'https://divi.cx/connect';
const GAMES = 'https://games.divi.domains';
const GRANT = 'relay:' + GAMES;

interface Stored { id: number; envelope: Envelope }

// A fake relay in front of the harness's node: POST appends, GET returns the
// messages after `after` in one direction, waiting a little when there are none
function fakeRelay() {
  const topics = new Map<string, Stored[]>();
  let lastId = 0;
  const inner = globalThis.fetch as any;
  const fetchFn = vi.fn(async (url: string, init?: { method?: string; body?: string }) => {
    if (!String(url).startsWith(RELAY + '/')) return inner(url, init);
    const u = new URL(url);
    const m = u.pathname.match(/\/v1\/topics\/([0-9a-f]{64})\/messages$/);
    if (!m) return { ok: false, status: 404, json: async () => ({}) };
    const list = topics.get(m[1]) ?? [];
    topics.set(m[1], list);
    if (init?.method === 'POST') {
      list.push({ id: ++lastId, envelope: JSON.parse(init.body!) });
      return { ok: true, status: 201, json: async () => ({ id: lastId }) };
    }
    const dir = u.searchParams.get('dir');
    const after = Number(u.searchParams.get('after') ?? 0);
    const pick = () => list.filter(x => x.id > after && x.envelope.d === dir);
    if (!pick().length) await new Promise(r => setTimeout(r, 30));
    const messages = pick();
    return { ok: true, status: 200, json: async () => ({ messages, last: lastId }) };
  });
  (globalThis as any).fetch = fetchFn;
  return { topics, fetchFn, inject: (topic: string, envelope: Envelope) => {
    const list = topics.get(topic) ?? [];
    topics.set(topic, list);
    list.push({ id: ++lastId, envelope });
  } };
}

// The page's end of a pairing
async function makePage(relay: ReturnType<typeof fakeRelay>, opts: { origin?: string; network?: string; expires?: number } = {}) {
  const key = crypto.getRandomValues(new Uint8Array(32));
  const keys: Keys = await deriveKeys(key);
  const now = Math.floor(Date.now() / 1000);
  const uri = `irondivi-connect:v1?k=${b64u(key)}&r=${encodeURIComponent(RELAY)}&o=${encodeURIComponent(opts.origin ?? GAMES)}`
    + `&n=${opts.network ?? 'testnet'}&e=${opts.expires ?? now + 600}`;
  let seq = 0;
  let nextId = 1;
  const seen = new Set<number>();
  const inbox: any[] = [];
  const read = async () => {
    for (const m of relay.topics.get(keys.topic) ?? []) {
      if (m.envelope.d !== 'w' || seen.has(m.id)) continue;
      seen.add(m.id);
      inbox.push(await open(keys, m.envelope));
    }
    return inbox;
  };
  const post = async (rpc: object, override: { seq?: number; ts?: number } = {}) => {
    const envelope = await seal(keys, 'd', { seq: override.seq ?? ++seq, ts: override.ts ?? Date.now(), rpc });
    relay.inject(keys.topic, envelope);
    return envelope;
  };
  const waitFor = async (pred: (msg: any) => boolean, ms = 10000) => {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      const hit = (await read()).find(pred);
      if (hit) return hit;
      await new Promise(r => setTimeout(r, 10));
    }
    throw new Error('the page got no such message');
  };
  return {
    uri, keys, inbox, read, post, waitFor,
    /** Send a request; resolves with the reply's rpc */
    request: async (method: string, params: object = {}) => {
      const id = nextId++;
      await post({ jsonrpc: '2.0', id, method, params });
      return (await waitFor(m => m.rpc?.id === id)).rpc;
    },
    send: async (method: string, params: object = {}) => {
      const id = nextId++;
      await post({ jsonrpc: '2.0', id, method, params });
      return id;
    },
    reply: async (id: number) => (await waitFor(m => m.rpc?.id === id)).rpc,
    notify: (method: string, params: object = {}) => post({ jsonrpc: '2.0', method, params }),
  };
}

const CONNECT = { origin: GAMES, name: 'Divi Games', network: 'testnet' };

async function foreignTestnetAddress(): Promise<string> {
  const seed = await Mnemonic.toSeed(TEST_MNEMONIC, 'other-account');
  const [a] = await deriveAddresses(seed, 'testnet', 0, 1);
  return a.address;
}

describe('IronDivi Connect over the relay', () => {
  let h: Harness;
  let relay: ReturnType<typeof fakeRelay>;

  const relayModule = () => import('./connect-relay');
  const shorten = async () => {
    const { relayTiming } = await relayModule();
    Object.assign(relayTiming, { minPollGapMs: 20, retryMs: 20, maxBackoffMs: 100 });
  };

  beforeEach(async () => {
    vi.resetModules();
    h = await createHarness(GAMES + '/');
    relay = fakeRelay();
    await shorten();
    await h.setupWallet();
  });

  afterEach(async () => {
    (await relayModule()).connectRelay.stopAll();
  });

  async function pairAndConnect(page: Awaited<ReturnType<typeof makePage>>) {
    const p = await h.popup('CONNECT_PAIR', { uri: page.uri });
    expect(p.success).toBe(true);
    const id = await page.send('irondivi_connect', CONNECT);
    const req = await h.waitForPending('connect');
    const ok = await h.approvalWindow('APPROVE_SIGNING_REQUEST', { requestId: req.id, isConnection: true });
    expect(ok.success).toBe(true);
    return { req, reply: await page.reply(id), pairing: p.data };
  }

  it('pairs, connects through the approval window and answers every method', async () => {
    const page = await makePage(relay);
    const { req, reply, pairing } = await pairAndConnect(page);
    expect(pairing).toMatchObject({ origin: GAMES, network: 'testnet', relayHost: 'divi.cx', connected: false });
    // The window is told who asks, and that it came through the relay
    expect(req.origin).toBe(GRANT);
    expect(req.relay).toMatchObject({ origin: GAMES, name: 'Divi Games', relayHost: 'divi.cx' });
    expect(reply.error).toBeUndefined();
    const address = reply.result.address;
    expect(address).toMatch(/^y/);
    expect(reply.result).toMatchObject({ network: 'testnet', wallet: { name: 'IronDivi Wallet', version: '0.0.0-test' } });
    expect(reply.result.accounts).toContain(address);

    expect((await page.request('irondivi_accounts')).result).toContain(address);
    expect((await page.request('irondivi_getNetwork')).result).toBe('testnet');
    expect((await page.request('irondivi_getBalance', { address })).result).toEqual({ confirmed: '1000', unconfirmed: '0' });

    const to = await foreignTestnetAddress();
    const sendId = await page.send('irondivi_sendTransaction', { to, amount: '1.5', memo: 'game 7' });
    const send = await h.waitForPending('send_transaction');
    expect(send.origin).toBe(GRANT);
    expect(send.data.memo).toBe('game 7');
    expect(h.broadcasts).toHaveLength(0);
    expect((await h.approvalWindow('APPROVE_SIGNING_REQUEST', { requestId: send.id, password: TEST_PASSWORD })).success).toBe(true);
    const sent = await page.reply(sendId);
    expect(sent.result.txid).toMatch(/^[0-9a-f]{64}$/);
    expect(h.broadcasts).toHaveLength(1);

    const signId = await page.send('irondivi_signMessage', { message: 'hello', address });
    const sign = await h.waitForPending('sign_message');
    await h.approvalWindow('APPROVE_SIGNING_REQUEST', { requestId: sign.id, password: TEST_PASSWORD });
    expect(typeof (await page.reply(signId)).result).toBe('string');

    // Game transactions are for the page's own window.irondivi only
    expect((await page.request('irondivi_signGameTx', { tx: {} })).error.code).toBe(4200);

    // The page ends it: the grant and the pairing go
    await page.notify('irondivi_disconnect');
    const granted = async () => JSON.stringify((await h.popup('GET_CONNECTED_SITES')).data).includes(GRANT);
    for (let i = 0; i < 200 && await granted(); i++) await new Promise(r => setTimeout(r, 10));
    expect(await granted()).toBe(false);
    expect((await h.popup('CONNECT_SESSIONS')).data).toEqual([]);
  });

  it('refuses everything but connect before the owner approves the connection (4100)', async () => {
    const page = await makePage(relay);
    expect((await h.popup('CONNECT_PAIR', { uri: page.uri })).success).toBe(true);
    expect((await page.request('irondivi_accounts')).error.code).toBe(4100);
    expect((await page.request('irondivi_sendTransaction', { to: await foreignTestnetAddress(), amount: '1' })).error.code).toBe(4100);
    expect(h.createdWindows).toHaveLength(0);
  });

  it('refuses a network mismatch with 4901: in the code, in connect, and after the wallet switches', async () => {
    const mainnet = await makePage(relay, { network: 'mainnet' });
    const r = await h.popup('CONNECT_PAIR', { uri: mainnet.uri });
    expect(r).toMatchObject({ success: false, code: 4901 });

    const page = await makePage(relay);
    expect((await h.popup('CONNECT_PAIR', { uri: page.uri })).success).toBe(true);
    expect((await page.request('irondivi_connect', { ...CONNECT, network: 'mainnet' })).error.code).toBe(4901);
    expect(h.createdWindows).toHaveLength(0);

    const id = await page.send('irondivi_connect', CONNECT);
    const req = await h.waitForPending('connect');
    await h.approvalWindow('APPROVE_SIGNING_REQUEST', { requestId: req.id, isConnection: true });
    expect((await page.reply(id)).result.network).toBe('testnet');
    expect((await h.popup('UPDATE_SETTINGS', { network: 'mainnet', password: TEST_PASSWORD })).success).toBe(true);
    expect((await page.request('irondivi_accounts')).error.code).toBe(4901);
  });

  it('drops replays, stale messages and tampered envelopes, and moves past them', async () => {
    const page = await makePage(relay);
    await pairAndConnect(page);
    // seq 1 was the connect; a fresh request with seq 1 again is a replay
    await page.post({ jsonrpc: '2.0', id: 90, method: 'irondivi_getNetwork', params: {} }, { seq: 1 });
    // a message from 20 minutes ago
    await page.post({ jsonrpc: '2.0', id: 91, method: 'irondivi_getNetwork', params: {} }, { seq: 50, ts: Date.now() - 20 * 60_000 });
    // ciphertext someone changed
    const env = await seal(page.keys, 'd', { seq: 60, ts: Date.now(), rpc: { jsonrpc: '2.0', id: 92, method: 'irondivi_getNetwork', params: {} } });
    const c = env.c.split('');
    c[5] = c[5] === 'A' ? 'B' : 'A';
    relay.inject(page.keys.topic, { ...env, c: c.join('') });
    // ...and a good one after them is still answered
    await page.post({ jsonrpc: '2.0', id: 93, method: 'irondivi_getNetwork', params: {} }, { seq: 70 });
    expect((await page.reply(93)).result).toBe('testnet');
    const ids = (await page.read()).map(m => m.rpc?.id);
    expect(ids).not.toContain(90);
    expect(ids).not.toContain(91);
    expect(ids).not.toContain(92);
    const { connectRelay } = await relayModule();
    const stored = h.sessionStorage.connectSessions[0];
    expect(stored.after).toBeGreaterThanOrEqual(Math.max(...relay.topics.get(page.keys.topic)!.filter(m => m.envelope.d === 'd').map(m => m.id)));
    expect(connectRelay.list()).toHaveLength(1);
  });

  it('refuses an expired code, a blocked site, a repeat of the same code and a third pairing', async () => {
    const expired = await makePage(relay, { expires: Math.floor(Date.now() / 1000) - 5 });
    expect((await h.popup('CONNECT_PAIR', { uri: expired.uri })).success).toBe(false);

    const shop = 'https://shop.example';
    expect((await h.popup('SET_SITE_ACCESS', { action: 'block', origin: shop })).success).toBe(true);
    const blocked = await makePage(relay, { origin: shop });
    expect(await h.popup('CONNECT_PAIR', { uri: blocked.uri })).toMatchObject({ success: false, code: 4301 });

    const a = await makePage(relay);
    expect((await h.popup('CONNECT_PAIR', { uri: a.uri })).success).toBe(true);
    expect((await h.popup('CONNECT_PAIR', { uri: a.uri })).success).toBe(false);
    expect((await h.popup('CONNECT_PAIR', { uri: (await makePage(relay)).uri })).success).toBe(true);
    expect((await h.popup('CONNECT_PAIR', { uri: (await makePage(relay)).uri })).success).toBe(false);
    expect((await h.popup('CONNECT_SESSIONS')).data).toHaveLength(2);
  });

  it('keeps the relay grant and the page\'s own window.irondivi grant apart', async () => {
    // Connected in the page itself: the relay pairing is still not connected
    await h.connectPage();
    const page = await makePage(relay);
    expect((await h.popup('CONNECT_PAIR', { uri: page.uri })).success).toBe(true);
    expect((await page.request('irondivi_accounts')).error.code).toBe(4100);
    // Connected over the relay: forgetting the page's own grant leaves it
    await page.request('irondivi_getNetwork');
    const id = await page.send('irondivi_connect', CONNECT);
    const req = await h.waitForPending('connect');
    await h.approvalWindow('APPROVE_SIGNING_REQUEST', { requestId: req.id, isConnection: true });
    await page.reply(id);
    expect((await h.popup('REVOKE_SITE', { origin: GAMES })).success).toBe(true);
    expect((await h.fromTab('IS_CONNECTED')).data.connected).toBe(false);
    expect((await page.request('irondivi_getNetwork')).result).toBe('testnet');
    // ...and the other way round
    await h.connectPage();
    expect((await h.popup('REVOKE_SITE', { origin: GRANT })).success).toBe(true);
    expect((await h.fromTab('IS_CONNECTED')).data.connected).toBe(true);
  });

  it('blocking the site ends the pairing and tells the page', async () => {
    const page = await makePage(relay);
    await pairAndConnect(page);
    expect((await h.popup('SET_SITE_ACCESS', { action: 'block', origin: GAMES })).success).toBe(true);
    await page.waitFor(m => m.rpc?.method === 'irondivi_disconnect' && m.rpc.id === undefined);
    expect((await h.popup('CONNECT_SESSIONS')).data).toEqual([]);
    expect(JSON.stringify((await h.popup('GET_CONNECTED_SITES')).data)).not.toContain(GRANT);
  });

  it('the owner ends a pairing from the wallet and the page is told', async () => {
    const page = await makePage(relay);
    const { pairing } = await pairAndConnect(page);
    expect((await h.popup('CONNECT_SESSIONS')).data[0]).toMatchObject({ topic: pairing.topic, connected: true, name: 'Divi Games' });
    expect((await h.popup('CONNECT_END', { topic: pairing.topic })).success).toBe(true);
    await page.waitFor(m => m.rpc?.method === 'irondivi_disconnect');
    expect((await h.popup('CONNECT_SESSIONS')).data).toEqual([]);
  });

  it('a pairing outlives the service worker being stopped', async () => {
    const page = await makePage(relay);
    await pairAndConnect(page);
    (await relayModule()).connectRelay.stopAll();
    await h.restartWorker();
    await shorten();
    for (let i = 0; i < 20; i++) await new Promise(r => setTimeout(r, 0));
    expect((await h.popup('CONNECT_SESSIONS')).data).toHaveLength(1);
    expect((await page.request('irondivi_getNetwork')).result).toBe('testnet');
  });

  it('only the wallet\'s own windows can pair or end a pairing', async () => {
    const page = await makePage(relay);
    expect((await h.fromTab('CONNECT_PAIR', { uri: page.uri })).success).toBe(false);
    expect((await h.fromTab('CONNECT_SESSIONS')).success).toBe(false);
    expect((await h.popup('CONNECT_SESSIONS')).data).toEqual([]);
  });
});
