// IronDivi Connect v1, the wallet end (irondivi-connect SPEC.md). A page that
// is not open in this browser pairs with the wallet by a code (QR or text);
// both ends then talk through a relay that sees only sealed envelopes.
//
// A port of the wallet half of irondivi-connect src/irondivi-connect.js
// (353eb2f), kept to the same bytes on the wire: fixtures/irondivi-connect-v1.json
// holds envelopes that library sealed, and the tests open them. The steps are
// separate methods, not one loop, so the service worker can drive them and
// store the session between wake-ups.

export const VERSION = 'v1';
const SCHEME = 'irondivi-connect:';
export const MAX_MEMO_BYTES = 512;
export const CLOCK_SKEW_MS = 15 * 60 * 1000;
export const POLL_WAIT_SEC = 25;

export const IDC_ERR = {
  USER_REJECTED: 4001,
  UNAUTHORIZED: 4100,
  UNSUPPORTED: 4200,
  UNAVAILABLE: 4900,
  WRONG_NETWORK: 4901,
  INVALID_PARAMS: -32602,
  INTERNAL: -32603,
} as const;

export type Network = 'mainnet' | 'testnet';
type Dir = 'd' | 'w';

export class ConnectError extends Error {
  constructor(public code: number, message: string) {
    super(message);
    this.name = 'IronDiviConnectError';
  }
}

const enc = new TextEncoder();
const dec = new TextDecoder();

// ── encoding ────────────────────────────────────────────────

export function b64u(bytes: Uint8Array): string {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function unb64u(text: unknown): Uint8Array<ArrayBuffer> {
  if (typeof text !== 'string' || !/^[A-Za-z0-9_-]*$/.test(text)) throw new Error('not base64url');
  let s = text.replace(/-/g, '+').replace(/_/g, '/');
  while (s.length % 4) s += '=';
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function hex(bytes: Uint8Array): string {
  return Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('');
}

// ── keys and envelope (SPEC §2–3) ───────────────────────────

export interface Keys { topic: string; d: CryptoKey; w: CryptoKey }
export interface Envelope { v: 1; d: Dir; n: string; c: string }

async function hkdf(base: CryptoKey, info: string): Promise<Uint8Array<ArrayBuffer>> {
  const bits = await crypto.subtle.deriveBits(
    { name: 'HKDF', hash: 'SHA-256', salt: new Uint8Array(0), info: enc.encode(info) }, base, 256);
  return new Uint8Array(bits);
}

export async function deriveKeys(k: Uint8Array<ArrayBuffer>): Promise<Keys> {
  const base = await crypto.subtle.importKey('raw', k, 'HKDF', false, ['deriveBits']);
  const topic = hex(await hkdf(base, 'irondivi-connect/v1 topic'));
  const aes = async (info: string) => crypto.subtle.importKey('raw', await hkdf(base, info), 'AES-GCM', false, ['encrypt', 'decrypt']);
  return { topic, d: await aes('irondivi-connect/v1 dapp->wallet'), w: await aes('irondivi-connect/v1 wallet->dapp') };
}

function aad(topic: string, dir: Dir): Uint8Array<ArrayBuffer> {
  return enc.encode('irondivi-connect/v1|' + topic + '|' + dir);
}

export async function seal(keys: Keys, dir: Dir, payload: unknown): Promise<Envelope> {
  const nonce = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv: nonce, additionalData: aad(keys.topic, dir) },
    keys[dir], enc.encode(JSON.stringify(payload)));
  return { v: 1, d: dir, n: b64u(nonce), c: b64u(new Uint8Array(ct)) };
}

export async function open(keys: Keys, envelope: Envelope): Promise<any> {
  const pt = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: unb64u(envelope.n), additionalData: aad(keys.topic, envelope.d) },
    keys[envelope.d], unb64u(envelope.c));
  return JSON.parse(dec.decode(pt));
}

// ── pairing URI (SPEC §1) ───────────────────────────────────

export interface Pairing { key: Uint8Array<ArrayBuffer>; relay: string; origin: string; network: Network; expires: number }

function isLocal(host: string): boolean {
  return host === 'localhost' || host === '127.0.0.1' || host === '[::1]';
}

export function checkRelay(relay: string): string {
  let u: URL;
  try { u = new URL(relay); } catch { throw new ConnectError(IDC_ERR.INVALID_PARAMS, 'The relay is not a URL'); }
  if (u.protocol !== 'https:' && !(u.protocol === 'http:' && isLocal(u.hostname))) {
    throw new ConnectError(IDC_ERR.INVALID_PARAMS, 'The relay must use https: ' + relay);
  }
  return relay.replace(/\/+$/, '');
}

export function checkNetwork(network: unknown): Network {
  if (network !== 'mainnet' && network !== 'testnet') {
    throw new ConnectError(IDC_ERR.INVALID_PARAMS, 'The network must be mainnet or testnet, not ' + String(network));
  }
  return network;
}

export function parseUri(uri: unknown, nowSec = Math.floor(Date.now() / 1000)): Pairing {
  if (typeof uri !== 'string') throw new ConnectError(IDC_ERR.INVALID_PARAMS, 'Not an IronDivi Connect URI');
  const text = uri.trim();
  const prefix = SCHEME + VERSION + '?';
  if (!text.startsWith(SCHEME)) throw new ConnectError(IDC_ERR.INVALID_PARAMS, 'Not an IronDivi Connect URI');
  if (!text.startsWith(prefix)) throw new ConnectError(IDC_ERR.UNSUPPORTED, 'Unsupported IronDivi Connect version');
  const q = new URLSearchParams(text.slice(prefix.length));
  let key: Uint8Array<ArrayBuffer> | null;
  try { key = unb64u(q.get('k') || ''); } catch { key = null; }
  if (!key || key.length !== 32) throw new ConnectError(IDC_ERR.INVALID_PARAMS, 'The pairing key is not 32 bytes');
  const origin = q.get('o') || '';
  let parsed: string | null;
  try { parsed = new URL(origin).origin; } catch { parsed = null; }
  if (!parsed || parsed !== origin) throw new ConnectError(IDC_ERR.INVALID_PARAMS, 'The origin is not a valid origin: ' + origin);
  const expires = Number(q.get('e'));
  if (!Number.isSafeInteger(expires)) throw new ConnectError(IDC_ERR.INVALID_PARAMS, 'The expiry is missing');
  if (expires <= nowSec) throw new ConnectError(IDC_ERR.INVALID_PARAMS, 'This pairing code has expired. Ask the page for a new one.');
  return { key, relay: checkRelay(q.get('r') || ''), origin, network: checkNetwork(q.get('n')), expires };
}

// ── params (SPEC §6) ────────────────────────────────────────

const ADDRESS_RE = /^[1-9A-HJ-NP-Za-km-z]{25,40}$/;
const AMOUNT_RE = /^(0|[1-9][0-9]{0,10})(\.[0-9]{1,8})?$/;

export function toAmount(value: unknown): string {
  const s = typeof value === 'number'
    ? (Number.isFinite(value) ? value.toFixed(8).replace(/\.?0+$/, '') : '')
    : String(value);
  if (!AMOUNT_RE.test(s) || Number(s) <= 0) throw new ConnectError(IDC_ERR.INVALID_PARAMS, 'Invalid DIVI amount: ' + String(value));
  return s;
}

export function validateParams(method: string, params: any): void {
  const p = params || {};
  const bad = (why: string): never => { throw new ConnectError(IDC_ERR.INVALID_PARAMS, why); };
  switch (method) {
    case 'irondivi_connect':
      if (typeof p.origin !== 'string' || typeof p.name !== 'string') bad('connect needs origin and name');
      checkNetwork(p.network);
      return;
    case 'irondivi_signMessage':
      if (typeof p.message !== 'string' || !p.message.length || p.message.length > 4096) bad('message must be 1 to 4096 characters');
      if (typeof p.address !== 'string' || !ADDRESS_RE.test(p.address)) bad('address is not a Divi address');
      return;
    case 'irondivi_sendTransaction':
      if (typeof p.to !== 'string' || !ADDRESS_RE.test(p.to)) bad('to is not a Divi address');
      if (typeof p.amount !== 'string' || toAmount(p.amount) !== p.amount) bad('amount must be a DIVI decimal string');
      if (p.memo !== undefined && (typeof p.memo !== 'string' || !p.memo.length || enc.encode(p.memo).length > MAX_MEMO_BYTES)) {
        bad('memo must be 1 to ' + MAX_MEMO_BYTES + ' bytes of UTF-8');
      }
      return;
    default:
      return;
  }
}

// ── the wallet's session ────────────────────────────────────

// What is kept between service-worker wake-ups; the same shape as the
// reference library's toJSON(), so either can restore the other's
export interface StoredSession {
  v: 1; role: 'wallet'; k: string; relay: string; origin: string; name: string;
  network: Network; expires: number; after: number; seqOut: number; seqIn: number;
  nextId: number; account: string | null; connected: boolean;
}

export interface Rpc { jsonrpc: '2.0'; id?: number | string; method?: string; params?: any; result?: unknown; error?: { code: number; message: string } }

export type RequestHandler = (method: string, params: any, session: WalletSession) => Promise<unknown>;

export class WalletSession {
  readonly out: Dir = 'w';
  readonly in: Dir = 'd';
  closed = false;
  private constructor(public state: StoredSession, private keys: Keys) {}

  static async pair(uri: string, nowSec?: number): Promise<WalletSession> {
    const p = parseUri(uri, nowSec);
    return WalletSession.restore({
      v: 1, role: 'wallet', k: b64u(p.key), relay: p.relay, origin: p.origin, name: '',
      network: p.network, expires: p.expires, after: 0, seqOut: 0, seqIn: 0, nextId: 1,
      account: null, connected: false,
    });
  }

  static async restore(json: StoredSession): Promise<WalletSession> {
    if (!json || json.v !== 1 || json.role !== 'wallet') throw new ConnectError(IDC_ERR.INVALID_PARAMS, 'Not a stored IronDivi Connect session');
    const key = unb64u(json.k);
    if (key.length !== 32) throw new ConnectError(IDC_ERR.INVALID_PARAMS, 'The pairing key is not 32 bytes');
    const state: StoredSession = {
      ...json, relay: checkRelay(json.relay), network: checkNetwork(json.network),
      after: json.after || 0, seqOut: json.seqOut || 0, seqIn: json.seqIn || 0, nextId: json.nextId || 1,
      account: json.account ?? null, connected: !!json.connected, name: json.name || '',
    };
    return new WalletSession(state, await deriveKeys(key));
  }

  get topic(): string { return this.keys.topic; }
  toJSON(): StoredSession { return { ...this.state }; }

  url(): string { return this.state.relay + '/v1/topics/' + this.keys.topic + '/messages'; }
  pollUrl(): string { return this.url() + '?dir=' + this.in + '&after=' + this.state.after + '&wait=' + POLL_WAIT_SEC; }

  // The envelope for one message to the page. The sequence number is taken
  // even if the post then fails, as the reference library does
  async sealOut(rpc: Rpc, now = Date.now()): Promise<Envelope> {
    return seal(this.keys, this.out, { seq: ++this.state.seqOut, ts: now, rpc });
  }

  // A message from the page, or null for one to drop: the other direction,
  // not ours or tampered, a replay, too old or from the future, not JSON-RPC
  async receive(envelope: Envelope, now = Date.now()): Promise<Rpc | null> {
    if (!envelope || envelope.d !== this.in) return null;
    let msg: any;
    try { msg = await open(this.keys, envelope); } catch { return null; }
    if (!msg || !Number.isSafeInteger(msg.seq) || msg.seq <= this.state.seqIn) return null;
    if (typeof msg.ts !== 'number' || Math.abs(now - msg.ts) > CLOCK_SKEW_MS) return null;
    this.state.seqIn = msg.seq;
    const rpc = msg.rpc;
    if (!rpc || rpc.jsonrpc !== '2.0') return null;
    return rpc;
  }

  // The reply to a request from the page (null for a notification). The
  // rules the protocol fixes are applied here; what the wallet does is the
  // handler's
  async answer(rpc: Rpc, handler: RequestHandler): Promise<Rpc | null> {
    if (typeof rpc.method !== 'string' || rpc.id === undefined) return null;
    const reply: Rpc = { jsonrpc: '2.0', id: rpc.id };
    try {
      if (rpc.method !== 'irondivi_connect' && !this.state.connected) {
        throw new ConnectError(IDC_ERR.UNAUTHORIZED, 'Connect first');
      }
      validateParams(rpc.method, rpc.params);
      if (rpc.method === 'irondivi_connect' && rpc.params.network !== this.state.network) {
        throw new ConnectError(IDC_ERR.WRONG_NETWORK, 'The page asked for ' + rpc.params.network + ' but the pairing code says ' + this.state.network);
      }
      const result: any = await handler(rpc.method, rpc.params || {}, this);
      if (rpc.method === 'irondivi_connect') {
        this.state.connected = true;
        this.state.account = result?.address ?? null;
        this.state.name = String(rpc.params.name).slice(0, 100);
      }
      reply.result = result;
    } catch (err: any) {
      reply.error = { code: typeof err?.code === 'number' ? err.code : IDC_ERR.INTERNAL, message: err?.message || String(err) };
    }
    return reply;
  }

  static disconnectRpc(): Rpc { return { jsonrpc: '2.0', method: 'irondivi_disconnect' }; }
}
