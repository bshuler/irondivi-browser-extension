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
import { readFileSync } from 'fs';
import { vi } from 'vitest';
import { Address } from '../lib/address';
import { Transaction } from '../lib/transaction';
import type { SiteAccess } from '../shared/site-access';

export const EXT_ID = 'testextensionid';

/** Whether a match pattern (scheme://host/*, host may start with *.) covers a URL */
export function matchPattern(pattern: string, url: string): boolean {
  const u = new URL(url);
  const any = /^(https?):\/\/\*\/\*$/.exec(pattern);
  if (any) return u.protocol === `${any[1]}:`;
  const m = /^(https?):\/\/(\*\.)?([^/*]+)\/\*$/.exec(pattern);
  if (!m) return false;
  if (u.protocol !== `${m[1]}:`) return false;
  const host = u.hostname;
  return m[2] ? host === m[3] || host.endsWith(`.${m[3]}`) : host === m[3];
}
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
  windowPost: (data: unknown) => void;
  onWindowMessage: (fn: (e: any) => void) => void;
  /** window.irondivi (undefined if the background registered no provider for this page). */
  provider: () => any;
  /** The content scripts the background has registered. */
  registeredScripts: any[];
  createdWindows: Array<{ id: number; url: string }>;
  /** The size a new window really opens at; unset, the size asked for (Safari can ignore it). */
  openWindowsAt?: { width: number; height: number };
  /** windows.update calls, in order. */
  windowUpdates: Array<Record<string, number>>;
  closeWindow: (id: number) => void;
  /** The user granting a site outside the extension, as Safari's website access does. */
  grantInBrowser: (origin: string) => void;
  broadcasts: string[];
  /** What the node's address index reports; a test may edit it in place (not reassign it) to make the node lie. */
  utxos: Utxo[];
  /**
   * Pay `satoshis` to `address` in a real transaction the fake node can return
   * raw (getrawtransaction, verbose 0), and list the coin. Returns its txid.
   */
  fund: (address: string, satoshis: number) => string;
  /** Raw transactions by txid, for getrawtransaction with verbose 0. */
  rawHex: Record<string, string>;
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
  /** The fake storage.session area. */
  sessionStorage: Record<string, any>;
  /**
   * Stop and start the background as the browser does when it idles the
   * service worker: storage survives, the worker's memory does not.
   */
  restartWorker: () => Promise<void>;
  /** Open a wallet window's port to the background, as the popup does; from another URL if given */
  openUiPort: (url?: string) => { disconnect: () => void; messages: any[] };
  /** Tell the background the idle state changed ('active', 'idle' or 'locked') */
  setIdleState: (state: string) => void;
  /** Whether the running worker's signing session is open (for the account) */
  isAuthenticated: (accountId?: string) => Promise<boolean>;
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
export async function createHarness(
  pageUrl = 'https://games.divi.domains/',
  opts: { allowedSites?: string[]; siteAccess?: SiteAccess; grantedOrigins?: string[]; withheldOrigins?: string[] } = {},
): Promise<Harness> {
  const pageOrigin = new URL(pageUrl).origin;
  const local: Record<string, any> = {};
  if (opts.allowedSites) local.settings = { allowedSites: opts.allowedSites };
  if (opts.siteAccess) local.settings = { siteAccess: opts.siteAccess };
  const session: Record<string, any> = {};
  const onMessage = event();
  const onConnect = event();
  const onIdle = event();
  const onRemoved = event();
  const onPermissionsAdded = event();
  const createdWindows: Array<{ id: number; url: string }> = [];
  const windowUpdates: Array<Record<string, number>> = [];
  const broadcasts: string[] = [];
  const utxos: Utxo[] = [];
  const addressTxids: string[] = [];
  const mempool: string[] = [];
  const rawTxs: Record<string, any> = {};
  const rawHex: Record<string, string> = {};
  let fundings = 0;
  const fund = (address: string, satoshis: number): string => {
    const tx = new Transaction();
    const n = (++fundings).toString(16).padStart(64, '0');
    tx.inputs.push({ txid: n, vout: 0, script: '', sequence: 0xffffffff });
    tx.outputs.push({ value: BigInt(satoshis), script: p2pkhScript(address) });
    const txid = tx.txid();
    rawHex[txid] = tx.toHex();
    utxos.push({ address, satoshis, txid, vout: 0 });
    return txid;
  };
  const faucetRequests: string[] = [];
  let nextWindowId = 100;
  const registeredScripts: any[] = [];
  // The manifest's host permissions, granted at install, and any the test adds
  const manifest = JSON.parse(readFileSync(new URL('../../manifest.json', import.meta.url), 'utf-8'));
  // (less any the test says the user withheld)
  const grantedOrigins: string[] = [...manifest.host_permissions, ...(opts.grantedOrigins ?? [])]
    .filter(o => !(opts.withheldOrigins ?? []).includes(o));

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
      getManifest: () => ({ version: '0.0.0-test' }),
      onMessage,
      onConnect,
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
    idle: { onStateChanged: onIdle },
    action: { setBadgeText: () => {}, setBadgeBackgroundColor: () => {} },
    windows: {
      getAll: async () => [],
      create: async (opts: { url: string; width?: number; height?: number }) => {
        const w = { id: nextWindowId++, url: opts.url };
        createdWindows.push(w);
        const size = h.openWindowsAt ?? { width: opts.width, height: opts.height };
        return { id: w.id, tabs: [{ id: w.id * 10 }], ...size };
      },
      update: async (id: number, opts: Record<string, number>) => { windowUpdates.push({ id, ...opts }); return { id }; },
      remove: async (id: number) => { onRemoved.listeners.forEach(l => l(id)); },
      onRemoved,
    },
    webNavigation: { onCommitted: event() },
    tabs: { onActivated: event(), get: async () => ({}) },
    scripting: {
      executeScript: async () => [],
      getRegisteredContentScripts: async (filter?: { ids?: string[] }) =>
        registeredScripts.filter(s => !filter?.ids || filter.ids.includes(s.id)).map(s => structuredClone(s)),
      registerContentScripts: async (scripts: any[]) => {
        for (const s of scripts) {
          if (registeredScripts.some(r => r.id === s.id)) throw new Error(`Duplicate script ID '${s.id}'`);
        }
        registeredScripts.push(...scripts.map(s => structuredClone(s)));
      },
      unregisterContentScripts: async (filter?: { ids?: string[] }) => {
        for (let i = registeredScripts.length - 1; i >= 0; i--) {
          if (!filter?.ids || filter.ids.includes(registeredScripts[i].id)) registeredScripts.splice(i, 1);
        }
      },
    },
    permissions: {
      contains: async ({ origins }: { origins: string[] }) => origins.every(o => grantedOrigins.includes(o)),
      request: async ({ origins }: { origins: string[] }) => {
        grantedOrigins.push(...origins.filter(o => !grantedOrigins.includes(o)));
        return true;
      },
      onAdded: onPermissionsAdded,
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
        result = Transaction.fromHex(params[0]).txid();
        break;
      case 'validateaddress': result = { isvalid: true }; break;
      case 'getaddresstxids': result = [...addressTxids]; break;
      case 'getrawmempool': result = [...mempool]; break;
      case 'getrawtransaction':
        result = params[1] === 0
          ? rawHex[params[0]] ?? null
          : rawTxs[params[0]] ? structuredClone(rawTxs[params[0]]) : null;
        break;
      default: result = null;
    }
    return { ok: true, status: 200, statusText: 'OK', json: async () => ({ jsonrpc: '2.0', id, result }) };
  });
  (globalThis as any).fetch = rpcFetch;

  // Fake page window for the content script and provider
  const windowListeners: Array<(e: any) => void> = [];
  const windowEvents = new EventTarget();
  const injected: string[] = [];
  const fakeWindow: any = {
    location: { origin: pageOrigin, href: pageUrl },
    addEventListener: (type: string, fn: (e: any) => void) => {
      if (type === 'message') windowListeners.push(fn);
      else windowEvents.addEventListener(type, fn);
    },
    removeEventListener: (type: string, fn: (e: any) => void) => {
      if (type === 'message') windowListeners.splice(windowListeners.indexOf(fn) >>> 0, 1);
      else windowEvents.removeEventListener(type, fn);
    },
    postMessage: (data: any, _target: string) => {
      const ev = { source: fakeWindow, data: structuredClone(data), origin: pageOrigin };
      queueMicrotask(() => windowListeners.slice().forEach(l => l(ev)));
    },
    dispatchEvent: (e: Event) => windowEvents.dispatchEvent(e),
  };
  // Node's ports would keep the test worker alive
  const RealChannel: typeof MessageChannel = (globalThis as any).__realMessageChannel ??= globalThis.MessageChannel;
  (globalThis as any).MessageChannel = class extends RealChannel {
    constructor() {
      super();
      (this.port1 as any).unref?.();
      (this.port2 as any).unref?.();
    }
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

  // The listeners the worker adds, so a restart can take them away again
  const workerEvents = [onMessage, onConnect, onIdle];
  const loadWorker = async (path: string) => {
    const before = workerEvents.map(e => e.listeners.length);
    await import(/* @vite-ignore */ path);
    return workerEvents.map((e, i) => e.listeners.slice(before[i]));
  };
  let workerAdded = await loadWorker('../background/service-worker');
  let restarts = 0;
  const restartWorker = async () => {
    workerEvents.forEach((e, i) => workerAdded[i].forEach(l => e.removeListener(l)));
    vi.resetModules();
    workerAdded = await loadWorker(`../background/service-worker?restart=${++restarts}`);
  };
  // Let the worker register the scripts for the allowed sites
  for (let i = 0; i < 20; i++) await new Promise(r => setTimeout(r, 0));
  // The browser runs a registered script only on a page its patterns match
  const runs = (file: string) => registeredScripts.some(s => s.js.includes(file) && s.matches.some((m: string) => matchPattern(m, pageUrl)));
  if (runs('provider.js')) {
    // provider.ts is a classic script, not a module; import it by path.
    const providerPath = '../injected/provider';
    await import(/* @vite-ignore */ providerPath);
  }
  if (runs('content-script.js')) await import('../content/content-script');
  for (let i = 0; i < 20; i++) await new Promise(r => setTimeout(r, 0));

  // A raw request over the provider's private port, as if the provider sent
  // any method it liked: what the content script itself lets through
  const pagePost = (method: string, params?: unknown) => new Promise<any>((resolve) => {
    const port: MessagePort | undefined = fakeWindow.irondivi?.port;
    const id = `raw-${Math.random()}`;
    port?.addEventListener('message', (e: MessageEvent) => { if (e.data?.id === id) resolve(e.data.response); });
    port?.postMessage({ id, method, params });
    // A content script that drops the message never answers.
    setTimeout(() => resolve({ dropped: true }), 3000);
  });
  // What any page script can do: post to the window as the old bridge did
  const windowPost = (data: unknown) => fakeWindow.postMessage(data, pageOrigin);

  const h: Harness = {
    popup: (type, payload) => dispatch({ type, payload }, popupSender),
    approvalWindow: (type, payload) => {
      const w = createdWindows[createdWindows.length - 1];
      const url = `${EXT_BASE}${w ? w.url : 'popup.html'}`;
      return dispatch({ type, payload }, { id: EXT_ID, url, origin: `chrome-extension://${EXT_ID}`, tab: { id: 900, url, windowId: w?.id ?? 900 } });
    },
    fromTab: (type, payload) => dispatch({ type, payload, origin: pageOrigin }, tabSender),
    pagePost,
    windowPost,
    onWindowMessage: (fn: (e: any) => void) => windowListeners.push(fn),
    provider: () => fakeWindow.irondivi,
    registeredScripts,
    createdWindows,
    windowUpdates,
    closeWindow: (id) => onRemoved.listeners.forEach(l => l(id)),
    grantInBrowser: (origin) => {
      grantedOrigins.push(origin);
      onPermissionsAdded.listeners.forEach(l => l({ origins: [origin] }));
    },
    broadcasts,
    utxos,
    fund,
    rawHex,
    addressTxids,
    mempool,
    rawTxs,
    faucetReply: { success: false, error: 'faucet not set up in this test' },
    faucetRequests,
    storage: local,
    sessionStorage: session,
    restartWorker,
    openUiPort: (url = `${EXT_BASE}popup.html`) => {
      const onDisconnect = event();
      const messages: any[] = [];
      const port = { name: 'irondivi-ui', sender: { id: EXT_ID, url }, onDisconnect, onMessage: event(), postMessage: (m: any) => { messages.push(m); } };
      onConnect.listeners.forEach(l => l(port));
      return { disconnect: () => onDisconnect.listeners.forEach(l => l(port)), messages };
    },
    setIdleState: (state) => onIdle.listeners.forEach(l => l(state)),
    isAuthenticated: async (accountId?: string) =>
      (await import('../background/signing-session')).signingSession.isAuthenticated(accountId),
    setupWallet: async () => {
      const r = await h.popup('IMPORT_ACCOUNT', { name: 'Test', mnemonic: TEST_MNEMONIC, password: TEST_PASSWORD, network: 'testnet' });
      if (!r?.success) throw new Error(`import failed: ${r?.error}`);
      const account = r.data.account;
      await h.popup('SELECT_ACCOUNT', { accountId: account.id });
      const a = await h.popup('AUTHENTICATE', { accountId: account.id, password: TEST_PASSWORD });
      if (!a?.success) throw new Error(`auth failed: ${a?.error}`);
      fund(account.addresses[0].address, 1000 * 1e8);
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
