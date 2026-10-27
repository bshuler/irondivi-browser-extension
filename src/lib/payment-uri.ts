/**
 * Divi payment requests: the text a payment QR code carries.
 *
 * Format (BIP21 style, shared with the IronDivi web UI; keep both identical):
 *
 *   divi:<address>?amount=<DIVI>&label=<text>&message=<text>&memo=<text>
 *
 * - Every parameter is optional; values are percent-encoded (encodeURIComponent).
 *   "+" is a literal plus, not a space.
 * - amount: a positive decimal number of DIVI with at most 8 decimal places.
 * - label: who is asking; message: what for. Shown to the payer, never on chain.
 * - memo: put on chain in the payment's OP_RETURN (OP_META) output: UTF-8,
 *   1 to 512 bytes, as in irondivi-connect SPEC.md.
 * - Formatting writes the parameters in the order amount, label, message, memo
 *   and leaves out the ones that are not set; with none set it is the bare
 *   address, which is what the receive QR showed before payment requests.
 *
 * Parsing accepts "divi:" in any case and a bare address, refuses any
 * parameter starting "req-" that it does not know (BIP21), ignores other
 * unknown parameters, refuses a repeated parameter, and refuses an address
 * that is not a pay-to-public-key-hash address of the wallet's network.
 */

import { Address } from './address';
import { MAX_OP_RETURN_BYTES, utf8Exact } from './transaction';
import { NETWORKS, type NetworkType } from '../shared/constants';

// A payment request's memo is an IronDivi Connect memo, 1 to 512 bytes
// (irondivi-connect SPEC.md), smaller than the most one OP_RETURN carries
export const PAYMENT_MEMO_BYTES = 512;

export interface PaymentRequest {
  address: string;
  // Decimal DIVI text, exactly as it will be sent
  amount?: string;
  label?: string;
  message?: string;
  memo?: string;
}

export type ParseResult =
  | { ok: true; request: PaymentRequest }
  | { ok: false; error: string };

const SCHEME = /^divi:/i;
const AMOUNT = /^(\d{1,12})(?:\.(\d{1,8}))?$/;
const KNOWN = ['amount', 'label', 'message', 'memo'] as const;

/** Why an amount is not a payment amount, or null when it is one */
export function amountProblem(amount: string): string | null {
  const m = AMOUNT.exec(amount);
  if (!m) return 'The amount must be a number of DIVI with at most 8 decimal places';
  if (/^0*$/.test(m[1]) && /^0*$/.test(m[2] ?? '')) return 'The amount must be more than zero';
  return null;
}

/** Why a memo cannot go on chain, or null when it can */
export function memoProblem(memo: string, max: number = MAX_OP_RETURN_BYTES): string | null {
  const bytes = utf8Exact(memo);
  if (!bytes) return 'The memo must be plain text';
  if (bytes.length === 0) return 'The memo is empty';
  if (bytes.length > max) return `The memo is ${bytes.length} bytes; at most ${max} fit`;
  return null;
}

/** Why an address cannot be paid on this network, or null when it can */
export function addressProblem(address: string, network: NetworkType): string | null {
  if (Address.validate(address, network)) return null;
  let version: number;
  try {
    version = Address.decode(address).version;
  } catch {
    return 'That is not a valid Divi address';
  }
  for (const [other, params] of Object.entries(NETWORKS) as [NetworkType, typeof NETWORKS[NetworkType]][]) {
    if (other !== network && (version === params.addressPrefix || version === params.scriptPrefix)) {
      return `That is a ${params.name} address; this wallet is on ${NETWORKS[network].name}`;
    }
  }
  return 'That is not a valid Divi address';
}

/**
 * The payment request text for an address. Throws if a field could not be
 * paid, so a QR code never asks for something a wallet must refuse.
 */
export function formatPaymentUri(request: PaymentRequest): string {
  const params: string[] = [];
  for (const key of KNOWN) {
    const value = request[key];
    if (value === undefined || value === '') continue;
    if (key === 'amount') {
      const problem = amountProblem(value);
      if (problem) throw new Error(problem);
    }
    if (key === 'memo') {
      const problem = memoProblem(value, PAYMENT_MEMO_BYTES);
      if (problem) throw new Error(problem);
    }
    params.push(`${key}=${encodeURIComponent(value)}`);
  }
  if (params.length === 0) return request.address;
  return `divi:${request.address}?${params.join('&')}`;
}

/** The payment request in text a QR code held or the owner pasted */
export function parsePaymentUri(text: string, network: NetworkType): ParseResult {
  const raw = String(text ?? '').trim();
  const hasScheme = SCHEME.test(raw);
  const body = hasScheme ? raw.slice('divi:'.length) : raw;
  const q = body.indexOf('?');
  const address = q === -1 ? body : body.slice(0, q);
  const query = q === -1 ? '' : body.slice(q + 1);

  if (!hasScheme && q !== -1) return { ok: false, error: 'That is not a Divi payment request' };
  if (!address) return { ok: false, error: 'The payment request has no address' };
  const problem = addressProblem(address, network);
  if (problem) return { ok: false, error: problem };

  const request: PaymentRequest = { address };
  const seen = new Set<string>();
  for (const pair of query ? query.split('&') : []) {
    if (pair === '') continue;
    const eq = pair.indexOf('=');
    let key: string;
    let value: string;
    try {
      key = decodeURIComponent(eq === -1 ? pair : pair.slice(0, eq));
      value = eq === -1 ? '' : decodeURIComponent(pair.slice(eq + 1));
    } catch {
      return { ok: false, error: 'The payment request is not encoded correctly' };
    }
    if (seen.has(key)) return { ok: false, error: `The payment request gives "${key}" twice` };
    seen.add(key);

    if (!(KNOWN as readonly string[]).includes(key)) {
      if (key.startsWith('req-')) return { ok: false, error: `The payment request needs "${key}", which this wallet does not support` };
      continue;
    }
    if (key === 'amount') {
      const bad = amountProblem(value);
      if (bad) return { ok: false, error: bad };
      request.amount = value;
    } else if (key === 'memo') {
      if (value === '') continue;
      const bad = memoProblem(value, PAYMENT_MEMO_BYTES);
      if (bad) return { ok: false, error: bad };
      request.memo = value;
    } else if (value !== '') {
      request[key as 'label' | 'message'] = value;
    }
  }
  return { ok: true, request };
}
