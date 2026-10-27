/**
 * Divi Name Service (DVNS) client: names that stand for Divi addresses.
 *
 * Protocol: divi-name-service SPEC.md. §1 says what a name is, §7 how a
 * wallet pays a record (POST build, send `send.amount` to `send.to` with
 * `send.memo` as the OP_RETURN text from `send.from`, then POST notify), and
 * §8 how it sends to a name (GET resolve; show the name and the address; a
 * 404 is "not registered", never a fallback).
 *
 * The API is https://name.divi.cx/api/v1 for both networks (`?network=`).
 * A dev build (IRONDIVI_DEV=1) may point it elsewhere with IRONDIVI_DVNS_API,
 * e.g. a tunnel to the dev server; a release build cannot.
 */

import type { NetworkType } from '../shared/constants';

declare const __IRONDIVI_DEV__: boolean | undefined;
declare const __IRONDIVI_DVNS_API__: string | undefined;

export const DVNS_API = 'https://name.divi.cx/api/v1';

export function dvnsApiBase(): string {
  const dev = typeof __IRONDIVI_DEV__ !== 'undefined' && __IRONDIVI_DEV__;
  const override = typeof __IRONDIVI_DVNS_API__ !== 'undefined' ? __IRONDIVI_DVNS_API__ : '';
  return (dev && override ? override : DVNS_API).replace(/\/+$/, '');
}

export type DvnsOp = 'register' | 'update' | 'delete';

const LABEL = /^[a-z0-9](?:[a-z0-9_-]{0,30}[a-z0-9])?$/;

/**
 * The name the user meant, lowercased, with `@handle` read as
 * `handle@telegram`; null when the text is not a name (SPEC §1). Nothing this
 * accepts is 34 characters of mixed case, so it is never a Divi address.
 */
export function normalizeName(input: string): string | null {
  let text = input.trim().toLowerCase();
  if (text.startsWith('@')) text = `${text.slice(1)}@telegram`;
  const parts = text.split('@');
  if (parts.length > 2 || !parts.every(p => LABEL.test(p))) return null;
  const top = parts[parts.length - 1];
  if (top.length < 3) return null;
  return text;
}

/**
 * What the To box holds might be a name. The caller asks first whether it is
 * a valid address; only text that is not one is taken as a name.
 */
export function looksLikeName(input: string): boolean {
  return normalizeName(input) !== null;
}

export interface DvnsRecord {
  name: string;
  network: string;
  divi: string;
  owner: string;
  fields: Record<string, string>;
}

export type Resolution =
  | { status: 'found'; record: DvnsRecord }
  | { status: 'not-registered'; name: string };

export interface DvnsFee {
  name: string;
  op: DvnsOp;
  fee: string;
  available?: boolean;
  registered?: boolean;
  reserved?: boolean;
}

export interface DvnsSend {
  to: string;
  amount: string;
  amount_sat: number;
  memo: string;
  from: string;
}

export interface DvnsBuild {
  name: string;
  op: DvnsOp;
  fee: string;
  send: DvnsSend;
  warnings: string[];
}

type Fetch = (url: string, init?: RequestInit) => Promise<Response>;

const TIMEOUT_MS = 15_000;

async function call(fetchImpl: Fetch, url: string, init?: RequestInit): Promise<{ status: number; body: any }> {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), TIMEOUT_MS);
  let res: Response;
  try {
    res = await fetchImpl(url, { ...init, signal: ctl.signal });
  } catch {
    throw new Error('The Divi Name Service could not be reached');
  } finally {
    clearTimeout(timer);
  }
  let body: any = null;
  try {
    body = await res.json();
  } catch {
    body = null;
  }
  return { status: res.status, body };
}

function apiError(status: number, body: any): Error {
  const why = typeof body?.error === 'string' ? body.error : `HTTP ${status}`;
  return new Error(`Divi Name Service: ${why}`);
}

function post(fetchImpl: Fetch, path: string, data: unknown) {
  return call(fetchImpl, `${dvnsApiBase()}/${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(data),
  });
}

/**
 * The address a name points to. Only 200 (found) and 404 (not registered)
 * are answers; anything else, or an answer for another name or network, is
 * an error and nothing may be sent.
 */
export async function resolveName(name: string, network: NetworkType, fetchImpl: Fetch = fetch): Promise<Resolution> {
  const wanted = normalizeName(name);
  if (!wanted) throw new Error(`"${name}" is not a name`);
  const url = `${dvnsApiBase()}/resolve/${encodeURIComponent(wanted)}?network=${network}`;
  const { status, body } = await call(fetchImpl, url);
  if (status === 404) return { status: 'not-registered', name: wanted };
  if (status !== 200 || !body) throw apiError(status, body);
  if (body.name !== wanted || body.network !== network || typeof body.divi !== 'string' || !body.divi) {
    throw new Error('Divi Name Service: the answer was not for this name and network');
  }
  return {
    status: 'found',
    record: {
      name: body.name,
      network: body.network,
      divi: body.divi,
      owner: typeof body.owner === 'string' ? body.owner : '',
      fields: body.fields && typeof body.fields === 'object' ? body.fields : {},
    },
  };
}

export async function nameFee(name: string, op: DvnsOp, network: NetworkType, fetchImpl: Fetch = fetch): Promise<DvnsFee> {
  const url = `${dvnsApiBase()}/fee?name=${encodeURIComponent(name)}&op=${op}&network=${network}`;
  const { status, body } = await call(fetchImpl, url);
  if (status !== 200 || !body || typeof body.fee !== 'string') throw apiError(status, body);
  return body as DvnsFee;
}

export interface BuildRequest {
  network: NetworkType;
  op: DvnsOp;
  name: string;
  payer: string;
  divi?: string;
  fields?: Record<string, string>;
}

/**
 * The payment that makes a record (SPEC §7), checked before it is shown: it
 * comes from the payer, and its record is the operation on the name that
 * was asked for. The owner still sees the record text before signing.
 */
export async function buildRecord(req: BuildRequest, fetchImpl: Fetch = fetch): Promise<DvnsBuild> {
  const { status, body } = await post(fetchImpl, 'build', req);
  if (status !== 200 || !body?.send) throw apiError(status, body);
  const send = body.send as DvnsSend;
  const lines = typeof send.memo === 'string' ? send.memo.split('\n') : [];
  if (send.from !== req.payer || lines[0] !== 'DVNS1' ||
      !lines.includes(`op=${req.op}`) || !lines.includes(`name=${req.name}`) ||
      typeof send.to !== 'string' || !/^\d+(\.\d{1,8})?$/.test(String(send.amount))) {
    throw new Error('Divi Name Service: the payment it built is not the one asked for');
  }
  return {
    name: req.name,
    op: req.op,
    fee: String(body.fee ?? send.amount),
    send: { ...send, amount: String(send.amount) },
    warnings: Array.isArray(body.warnings) ? body.warnings.map(String) : [],
  };
}

/** Tell the service about a record just sent, so it shows as pending */
export async function notifyRecord(network: NetworkType, txid: string, fetchImpl: Fetch = fetch): Promise<void> {
  const { status, body } = await post(fetchImpl, 'notify', { network, txid });
  if (status < 200 || status >= 300) throw apiError(status, body);
}
