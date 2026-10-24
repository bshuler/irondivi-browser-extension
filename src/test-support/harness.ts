/**
 * Test harness: runs the real background service worker, content script and
 * injected provider in one Node process, with fake browser APIs and a fake
 * Divi RPC (global fetch). Nothing touches a real network.
 *
 * Senders are built the way Chrome builds them:
 *   - popup (action popup): id, url = chrome-extension://<id>/popup.html, no tab
 *   - approval window (windows.create): id, extension url, and a tab
 *   - content script: id, tab, url = the page URL, origin = the page origin
 */
import { vi } from 'vitest';
import { Address } from '../lib/address';

export const EXT_ID = 'testextensionid';
export const EXT_BASE = `chrome-extension://${EXT_ID}/`;

// BIP39 test vector mnemonic; used only for testnet addresses in fake RPC.
export const TEST_MNEMONIC =
  'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
export const TEST_PASSWORD = 'harness-password-1';

type Listener = (msg: any, sender: any, sendResponse: (r: any) => void) => boolean | void;

export interface Utxo { address: string; satoshis: number; txid: string; vout: number }

export interface Harness {
  /** Message from the extension's action popup. */
  popup: (type: string, payload?: unknown) => Promise<any>;
  /** Message from the approval popup window (an extension page in a tab). */
  approvalWindow: (type: string, payload?: unknown) => Promise<any>;
  /** Message straight to the background as a content script in the page tab would send it. */
  fromTab: (type: string, payload?: unknown) => Promise<any>;
  /** A page script posting the provider bridge message itself (bypassing window.irondivi). */
  pagePost: (method: string, params?: unknown) => Promise<any>;
  /** The injected window.irondivi provider (undefined if the content script did not inject it). */
  provider: () => any;
  createdWindows: Array<{ id: number; url: string }>;
  closeWindow: (id: number) => void;
  broadcasts: string[];
  utxos: Utxo[];
  /** Txids the fake node's address index lists (mined), for getaddresstxids. */
  addressTxids: string[];
  /** Txids in the fake node's mempool, for getrawmempool. */
  mempool: string[];
  /** Verbose transactions by txid, for getrawtransaction. */
  rawTxs: Record<string, any>;
  /** What the fake faucet answers; the address it was asked to pay is pushed to faucetRequests. */
  faucetReply: { success: boolean; txid?: string; error?: string };
  faucetRequests: string[];
  storage: Record<string, any>;
  /** Import TEST_MNEMONIC on testnet and unlock a signing session. Returns the account. */
  setupWallet: () => Promise<any>;
  /** Approve the connect request for this page from the approval window. */
  connectPage: () => Promise<void>;
  /** Wait until a pending request of the given type exists; returns it. */
  waitForPending: (type: string) => Promise<any>;
}

function makeStorageArea(store: Record<string, any>) {
  const pick = (keys: string | string[] | null | undefined) => {
    if (keys == null) return { ...store };
    const list = Array.isArray(keys) ? keys : [keys];
    const out: Record<string, any> = {};
    for (const k of list) if (k in store) out[k] = structuredClone(store[k]);
    return out;
  };
  return {
    get: (keys: any, cb?: (r: any) => void) => {
      const r = pick(keys);
      if (cb) { cb(r); return undefined; }
      return Promise.resolve(r);
    },
    set: (items: Record<string, any>, cb?: () => void) => {
      for (const [k, v] of Object.entries(items)) store[k] = structuredClone(v);
      if (cb) { cb(); return undefined; }
      return Promise.resolve();
    },
    remove: (keys: string | string[], cb?: () => void) => {
      for (const k of Array.isArray(keys) ? keys : [keys]) delete store[k];
      if (cb) { cb(); return undefined; }
      return Promise.resolve();
    },
  };
}

function event() {
  const listeners: Array<(...a: any[]) => any> = [];
  return {
    listeners,
    addListener: (fn: (...a: any[]) => any) => { listeners.push(fn); },
    removeListener: (fn: (...a: any[]) => any) => {
      const i = listeners.indexOf(fn);
      if (i >= 0) listeners.splice(i, 1);
    },
    hasListener: (fn: (...a: any[]) => any) => listeners.includes(fn),
  };
}

function p2pkhScript(address: string): string {
  const { hash } = Address.decode(address);
  return '76a914' + Array.from(hash, (b: number) => b.toString(16).padStart(2, '0')).join('') + '88ac';
}

/**
 * Build the fake browser and load the background (and, for a page URL, the
 * content script and provider). Call vi.resetModules() before each harness.
 */
export async function createHarness(pageUrl = 'https://app.divi.domains/'): Promise<Harness> {
  const pageOrigin = new URL(pageUrl).origin;
  const local: Record<string, any> = {};
  const session: Record<string, any> = {};
  const onMessage = event();
  const onRemoved = event();
  const createdWindows: Array<{ id: number; url: string }> = [];
  const broadcasts: string[] = [];
  const utxos: Utxo[] = [];
  const addressTxids: string[] = [];
  const mempool: string[] = [];
  const rawTxs: Record<string, any> = {};
  const faucetRequests: string[] = [];
  let nextWindowId = 100;

  const dispatch = (msg: any, sender: any): Promise<any> => new Promise((resolve) => {
    let answered = false;
    const sendResponse = (r: any) => { if (!answered) { answered = true; resolve(r); } };
    let async = false;
    for (const l of onMessage.listeners) {
      if ((l as Listener)(structuredClone(msg), sender, sendResponse) === true) async = true;
    }
    if (!async && !answered) resolve(undefined);
  });

  const popupSender = { id: EXT_ID, url: `${EXT_BASE}popup.html`, origin: `chrome-extension://${EXT_ID}` };
  const tabSender = {
    id: EXT_ID,
    url: pageUrl,
    origin: pageOrigin,
    frameId: 0,
    tab: { id: 7, url: pageUrl, windowId: 1 },
  };

  const chromeFake: any = {
    runtime: {
      id: EXT_ID,
      getURL: (p: string) => EXT_BASE + p.replace(/^\//, ''),
      onMessage,
      lastError: undefined,
      // Only the content script calls this in the harness; popup calls use popup().
      sendMessage: (msg: any, cb?: (r: any) => void) => {
        const p = dispatch(msg, tabSender);
        if (cb) { p.then(cb); return undefined; }
        return p;
      },
    },
    storage: { local: makeStorageArea(local), session: makeStorageArea(session) },
    alarms: { create: () => {}, clear: (_n: string, cb?: (b: boolean) => void) => { cb?.(true); return Promise.resolve(true); }, onAlarm: event() },
    action: { setBadgeText: () => {}, setBadgeBackgroundColor: () => {} },
    windows: {
      getAll: async () => [],
      create: async (opts: { url: string }) => {
        const w = { id: nextWindowId++, url: opts.url };
        createdWindows.push(w);
        return { id: w.id, tabs: [{ id: w.id * 10 }] };
      },
      remove: async (id: number) => { onRemoved.listeners.forEach(l => l(id)); },
      onRemoved,
    },
    webNavigation: { onCommitted: event() },
    tabs: { onActivated: event(), get: async () => ({}) },
    scripting: {
      executeScript: async () => [],
      registerContentScripts: async () => {},
      unregisterContentScripts: async () => {},
    },
  };
  (globalThis as any).chrome = chromeFake;
  delete (globalThis as any).browser;

  // Fake Divi RPC
  const rpcFetch = vi.fn(async (url: string, init: { body: string }) => {
    if (url.includes('/faucet/')) {
      faucetRequests.push(JSON.parse(init.body).address);
      return { ok: true, status: 200, statusText: 'OK', json: async () => structuredClone(h.faucetReply) };
    }
    const { method, params, id } = JSON.parse(init.body);
    let result: unknown;
    switch (method) {
      case 'getblockcount': result = 1000; break;
      case 'getaddressutxos':
        result = utxos.filter(u => u.address === params[0]).map(u => ({
          address: u.address, txid: u.txid, outputIndex: u.vout, script: p2pkhScript(u.address),
          satoshis: u.satoshis, height: 990,
        }));
        break;
      case 'getaddressbalance': {
        const bal = utxos.filter(u => u.address === params[0]).reduce((s, u) => s + u.satoshis, 0);
        result = { balance: bal, received: bal };
        break;
      }
      case 'sendrawtransaction':
        broadcasts.push(params[0]);
        result = 'ab'.repeat(32);
        break;
      case 'validateaddress': result = { isvalid: true }; break;
      case 'getaddresstxids': result = [...addressTxids]; break;
      case 'getrawmempool': result = [...mempool]; break;
      case 'getrawtransaction': result = rawTxs[params[0]] ? structuredClone(rawTxs[params[0]]) : null; break;
      default: result = null;
    }
    return { ok: true, status: 200, statusText: 'OK', json: async () => ({ jsonrpc: '2.0', id, result }) };
  });
  (globalThis as any).fetch = rpcFetch;

  // Fake page window for the content script and provider
  const windowListeners: Array<(e: any) => void> = [];
  const injected: string[] = [];
  const fakeWindow: any = {
    location: { origin: pageOrigin, href: pageUrl },
    addEventListener: (type: string, fn: (e: any) => void) => { if (type === 'message') windowListeners.push(fn); },
    removeEventListener: () => {},
    postMessage: (data: any, _target: string) => {
      const ev = { source: fakeWindow, data: structuredClone(data), origin: pageOrigin };
      queueMicrotask(() => windowListeners.slice().forEach(l => l(ev)));
    },
    dispatchEvent: () => true,
  };
  const fakeDocument: any = {
    readyState: 'complete',
    addEventListener: () => {},
    createElement: () => ({ src: '', onload: null as null | (() => void), remove: () => {} }),
    documentElement: { appendChild: (el: any) => { injected.push(el.src); el.onload?.(); } },
  };
  fakeDocument.head = fakeDocument.documentElement;
  (globalThis as any).window = fakeWindow;
  (globalThis as any).document = fakeDocument;

  await import('../background/service-worker');
  await import('../content/content-script');
  // Let the content script read settings and decide whether to inject.
  for (let i = 0; i < 20; i++) await new Promise(r => setTimeout(r, 0));
  if (injected.some(src => src.endsWith('provider.js'))) {
    // provider.ts is a classic script, not a module; import it by path.
    const providerPath = '../injected/provider';
    await import(/* @vite-ignore */ providerPath);
  }

  const pagePost = (method: string, params?: unknown) => new Promise<any>((resolve) => {
    const id = `raw-${Math.random()}`;
    const onResp = (e: any) => {
      if (e.data?.type === 'IRONDIVI_PROVIDER_RESPONSE' && e.data.id === id) resolve(e.data.response);
    };
    windowListeners.push(onResp);
    fakeWindow.postMessage({ type: 'IRONDIVI_PROVIDER_MESSAGE', id, method, params }, pageOrigin);
    // A content script that drops the message never answers.
    setTimeout(() => resolve({ dropped: true }), 3000);
  });

  const h: Harness = {
    popup: (type, payload) => dispatch({ type, payload }, popupSender),
    approvalWindow: (type, payload) => {
      const w = createdWindows[createdWindows.length - 1];
      const url = `${EXT_BASE}${w ? w.url : 'popup.html'}`;
      return dispatch({ type, payload }, { id: EXT_ID, url, origin: `chrome-extension://${EXT_ID}`, tab: { id: 900, url, windowId: w?.id ?? 900 } });
    },
    fromTab: (type, payload) => dispatch({ type, payload, origin: pageOrigin }, tabSender),
    pagePost,
    provider: () => fakeWindow.irondivi,
    createdWindows,
    closeWindow: (id) => onRemoved.listeners.forEach(l => l(id)),
    broadcasts,
    utxos,
    addressTxids,
    mempool,
    rawTxs,
    faucetReply: { success: false, error: 'faucet not set up in this test' },
    faucetRequests,
    storage: local,
    setupWallet: async () => {
      const r = await h.popup('IMPORT_ACCOUNT', { name: 'Test', mnemonic: TEST_MNEMONIC, password: TEST_PASSWORD, network: 'testnet' });
      if (!r?.success) throw new Error(`import failed: ${r?.error}`);
      const account = r.data.account;
      await h.popup('SELECT_ACCOUNT', { accountId: account.id });
      const a = await h.popup('AUTHENTICATE', { accountId: account.id, password: TEST_PASSWORD });
      if (!a?.success) throw new Error(`auth failed: ${a?.error}`);
      utxos.push({ address: account.addresses[0].address, satoshis: 1000 * 1e8, txid: 'cd'.repeat(32), vout: 0 });
      return account;
    },
    waitForPending: async (type) => {
      for (let i = 0; i < 200; i++) {
        const r = await h.popup('GET_PENDING_SIGNING_REQUESTS');
        const req = r?.data?.requests?.find((x: any) => x.type === type);
        if (req) return req;
        await new Promise(res => setTimeout(res, 5));
      }
      throw new Error(`no pending ${type} request`);
    },
    connectPage: async () => {
      const done = h.fromTab('CONNECT');
      const req = await h.waitForPending('connect');
      const ok = await h.approvalWindow('APPROVE_SIGNING_REQUEST', { requestId: req.id, isConnection: true });
      if (!ok?.success) throw new Error(`approve connect failed: ${ok?.error}`);
      const r = await done;
      if (!r?.success) throw new Error(`connect failed: ${r?.error}`);
    },
  };
  return h;
}
