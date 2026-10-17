// Gate 1 for signRawTransaction: decode and verify a dApp-supplied transaction BEFORE it
// is shown for approval or signed. Everything the user is asked to approve (addresses,
// amounts, fee) is derived here from the bytes that will actually be signed.

import { Base58 } from './base58';
import { Hash } from './hash';
import { bytesToHex, hexToBytes } from './hex';
import { parseRawTx, rawTxId, SIGHASH, type RawTx } from './rawtx';
import { NETWORKS, type NetworkType } from '../shared/constants';

export interface SignPrevout {
  txid: string;
  vout: number;
  /** Amount in DIVI, as legacy RPC does. Cross-checked against the chain before signing. */
  amount: number;
  scriptPubKey: string;
}

export interface SignRawRequest {
  txHex: string;
  prevouts: SignPrevout[];
  indexes: number[];
  hashType: number;
}

export class SignRequestError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SignRequestError';
  }
}

export type OutputKind = 'p2pkh' | 'p2sh' | 'data' | 'other';

export interface DecodedInput {
  index: number;
  txid: string;
  vout: number;
  address: string | null;
  amountSats: bigint;
  /** Input already carries a scriptSig (someone else signed it). */
  alreadySigned: boolean;
  /** This wallet will overwrite the scriptSig of this input. */
  willSign: boolean;
  /** Prevout pays one of this account's addresses. */
  mine: boolean;
}

export interface DecodedOutput {
  index: number;
  kind: OutputKind;
  address: string | null;
  amountSats: bigint;
  /** For data outputs: the payload after OP_RETURN, as hex. */
  dataHex: string | null;
  mine: boolean;
}

export interface DecodedSignRequest {
  hashType: number;
  hashTypeName: string;
  inputs: DecodedInput[];
  outputs: DecodedOutput[];
  totalInSats: bigint;
  totalOutSats: bigint;
  /** Inputs minus outputs. Negative only for partial signatures another party will fund. */
  feeSats: bigint;
  complete: boolean;
  warnings: string[];
}

const SUPPORTED_HASH_TYPES: Record<number, string> = {
  [SIGHASH.ALL]: 'ALL',
  [SIGHASH.SINGLE | SIGHASH.ANYONECANPAY]: 'SINGLE|ANYONECANPAY',
  [SIGHASH.ALL | SIGHASH.ANYONECANPAY]: 'ALL|ANYONECANPAY',
};

const COIN = 100000000n;
// A complete (SIGHASH_ALL) transaction paying more than this to miners is almost certainly a mistake.
const MAX_FEE_SATS = 10n * COIN;

export function hashTypeName(hashType: number): string {
  return SUPPORTED_HASH_TYPES[hashType] ?? `0x${hashType.toString(16)}`;
}

export function isSupportedHashType(hashType: number): boolean {
  return Number.isInteger(hashType) && Object.prototype.hasOwnProperty.call(SUPPORTED_HASH_TYPES, hashType);
}

/** P2PKH scriptPubKey: OP_DUP OP_HASH160 <20> OP_EQUALVERIFY OP_CHECKSIG. Returns the hash or null. */
export function p2pkhHash(script: Uint8Array): Uint8Array | null {
  if (script.length === 25 && script[0] === 0x76 && script[1] === 0xa9 && script[2] === 0x14 && script[23] === 0x88 && script[24] === 0xac) {
    return script.slice(3, 23);
  }
  return null;
}

function p2shHash(script: Uint8Array): Uint8Array | null {
  if (script.length === 23 && script[0] === 0xa9 && script[1] === 0x14 && script[22] === 0x87) return script.slice(2, 22);
  return null;
}

function encodeAddress(version: number, hash: Uint8Array): string {
  const payload = new Uint8Array(21);
  payload[0] = version;
  payload.set(hash, 1);
  const out = new Uint8Array(25);
  out.set(payload);
  out.set(Hash.doubleSha256(payload).slice(0, 4), 21);
  return Base58.encode(out);
}

function scriptAddress(script: Uint8Array, network: NetworkType): string | null {
  const pkh = p2pkhHash(script);
  if (pkh) return encodeAddress(NETWORKS[network].addressPrefix, pkh);
  const sh = p2shHash(script);
  if (sh) return encodeAddress(NETWORKS[network].scriptPrefix, sh);
  return null;
}

/** DIVI as a JS number -> satoshis, refusing anything that is not an exact 8-decimal amount. */
function toSats(amount: unknown, what: string): bigint {
  if (typeof amount !== 'number' || !Number.isFinite(amount) || amount < 0 || amount > 21e9) {
    throw new SignRequestError(`Invalid amount for ${what}`);
  }
  const fixed = amount.toFixed(8);
  if (Number(fixed) !== amount) throw new SignRequestError(`Invalid amount for ${what}: more than 8 decimal places`);
  return BigInt(fixed.replace('.', ''));
}

function isHex(s: unknown): s is string {
  return typeof s === 'string' && s.length % 2 === 0 && /^[0-9a-fA-F]*$/.test(s);
}

export function formatDivi(sats: bigint): string {
  const neg = sats < 0n;
  const abs = neg ? -sats : sats;
  const whole = abs / COIN;
  const frac = (abs % COIN).toString().padStart(8, '0').replace(/0+$/, '');
  return `${neg ? '-' : ''}${whole}${frac ? '.' + frac : ''}`;
}

/**
 * Decode and validate a sign request. Throws SignRequestError on anything that must not be
 * signed. `ownAddresses` are the addresses of the signing account on `network`.
 */
export function decodeSignRequest(req: SignRawRequest, network: NetworkType, ownAddresses: string[]): DecodedSignRequest {
  if (!req || typeof req !== 'object') throw new SignRequestError('Invalid sign request');
  if (!isSupportedHashType(req.hashType)) {
    throw new SignRequestError(
      `Unsupported hash type ${String(req.hashType)}: only ALL (0x01), SINGLE|ANYONECANPAY (0x83) and ALL|ANYONECANPAY (0x81) are allowed`,
    );
  }
  const hashType = req.hashType;

  let tx: RawTx;
  try {
    tx = parseRawTx(req.txHex);
  } catch (e) {
    throw new SignRequestError(`Cannot decode transaction: ${(e as Error).message}`);
  }
  if (tx.inputs.length === 0) throw new SignRequestError('Transaction has no inputs');

  // indexes
  if (!Array.isArray(req.indexes) || req.indexes.length === 0) throw new SignRequestError('No input index given to sign');
  const seen = new Set<number>();
  for (const i of req.indexes) {
    if (!Number.isInteger(i)) throw new SignRequestError(`Invalid input index ${String(i)}`);
    if (i < 0 || i >= tx.inputs.length) throw new SignRequestError(`Input index ${i} is out of range (transaction has ${tx.inputs.length} inputs)`);
    if (seen.has(i)) throw new SignRequestError(`Duplicate input index ${i}`);
    seen.add(i);
    if ((hashType & 0x1f) === SIGHASH.SINGLE && i >= tx.outputs.length) {
      throw new SignRequestError(`SIGHASH_SINGLE on input ${i} but the transaction has no output ${i}; refusing (the signature would be meaningless)`);
    }
  }

  // prevouts: exactly one per input, in input order, matching txid and vout
  if (!Array.isArray(req.prevouts) || req.prevouts.length !== tx.inputs.length) {
    throw new SignRequestError(`Expected one prevout per input (${tx.inputs.length}), got ${Array.isArray(req.prevouts) ? req.prevouts.length : 0}`);
  }

  const own = new Set(ownAddresses);
  const inputs: DecodedInput[] = [];
  let totalIn = 0n;
  tx.inputs.forEach((inp, i) => {
    const p = req.prevouts[i];
    if (!p || typeof p.txid !== 'string' || p.txid.toLowerCase() !== inp.txid || p.vout !== inp.vout) {
      throw new SignRequestError(`Prevout ${i} does not match input ${i} (txid/vout)`);
    }
    if (!isHex(p.scriptPubKey)) throw new SignRequestError(`Prevout ${i} has an invalid scriptPubKey`);
    const amountSats = toSats(p.amount, `prevout ${i}`);
    const script = hexToBytes(p.scriptPubKey);
    const address = scriptAddress(script, network);
    const willSign = seen.has(i);
    if (willSign) {
      if (!p2pkhHash(script)) throw new SignRequestError(`Input ${i} is not a pay-to-pubkey-hash (P2PKH) output; only P2PKH inputs can be signed`);
      if (!address || !own.has(address)) throw new SignRequestError(`Input ${i} pays ${address ?? 'an unknown script'}, which this wallet does not own`);
    }
    totalIn += amountSats;
    inputs.push({
      index: i,
      txid: inp.txid,
      vout: inp.vout,
      address,
      amountSats,
      alreadySigned: inp.scriptSig.length > 0,
      willSign,
      mine: address !== null && own.has(address),
    });
  });

  const outputs: DecodedOutput[] = [];
  let totalOut = 0n;
  tx.outputs.forEach((o, i) => {
    let kind: OutputKind = 'other';
    let dataHex: string | null = null;
    const address = scriptAddress(o.script, network);
    if (p2pkhHash(o.script)) kind = 'p2pkh';
    else if (p2shHash(o.script)) kind = 'p2sh';
    else if (o.script.length > 0 && o.script[0] === 0x6a) {
      kind = 'data';
      dataHex = bytesToHex(o.script.slice(1));
    }
    totalOut += o.value;
    outputs.push({ index: i, kind, address, amountSats: o.value, dataHex, mine: address !== null && own.has(address) });
  });

  const feeSats = totalIn - totalOut;
  const warnings: string[] = [];
  const partial = (hashType & SIGHASH.ANYONECANPAY) !== 0;

  if (!partial) {
    if (feeSats < 0n) {
      throw new SignRequestError(`Outputs (${formatDivi(totalOut)}) exceed inputs (${formatDivi(totalIn)}) by ${formatDivi(-feeSats)} DIVI`);
    }
    if (feeSats > MAX_FEE_SATS) {
      throw new SignRequestError(`Fee of ${formatDivi(feeSats)} DIVI is far above normal; refusing`);
    }
  }

  const list = [...seen].sort((a, b) => a - b);
  if ((hashType & 0x1f) === SIGHASH.SINGLE) {
    for (const i of list) warnings.push(`Signs only input ${i} and output ${i}; other inputs and outputs can still be changed by anyone.`);
  } else if (partial) {
    warnings.push(`Signs the listed inputs and ALL outputs, but other inputs can still be added by anyone.`);
  }
  if (feeSats < 0n) warnings.push(`Incomplete: outputs exceed these inputs by ${formatDivi(-feeSats)} DIVI; another party must fund the rest.`);

  return {
    hashType,
    hashTypeName: hashTypeName(hashType),
    inputs,
    outputs,
    totalInSats: totalIn,
    totalOutSats: totalOut,
    feeSats,
    complete: feeSats >= 0n,
    warnings,
  };
}

/**
 * Check dApp-supplied prevouts against the chain. `fetchRawTx(txid)` returns the parent
 * transaction hex (rpcClient.getRawTransaction(txid, false)). Fails closed.
 */
export async function verifyPrevoutsOnChain(prevouts: SignPrevout[], fetchRawTx: (txid: string) => Promise<string>): Promise<void> {
  const cache = new Map<string, RawTx>();
  for (const [i, p] of prevouts.entries()) {
    let parent = cache.get(p.txid);
    if (!parent) {
      let hex: string;
      try {
        hex = await fetchRawTx(p.txid);
      } catch (e) {
        throw new SignRequestError(`Cannot verify prevout ${i}: could not fetch ${p.txid} (${(e as Error).message})`);
      }
      if (typeof hex !== 'string' || !isHex(hex) || hex.length === 0) throw new SignRequestError(`Cannot verify prevout ${i}: node returned no transaction`);
      if (rawTxId(hex) !== p.txid.toLowerCase()) {
        throw new SignRequestError(`Cannot verify prevout ${i}: node returned a different transaction (txid mismatch)`);
      }
      try {
        parent = parseRawTx(hex);
      } catch (e) {
        throw new SignRequestError(`Cannot verify prevout ${i}: ${(e as Error).message}`);
      }
      cache.set(p.txid, parent);
    }
    const out = parent.outputs[p.vout];
    if (!out) throw new SignRequestError(`Prevout ${i}: ${p.txid} has no output ${p.vout} (vout)`);
    if (out.value !== toSats(p.amount, `prevout ${i}`)) {
      throw new SignRequestError(`Prevout ${i}: amount does not match the chain (chain says ${formatDivi(out.value)} DIVI)`);
    }
    if (bytesToHex(out.script) !== p.scriptPubKey.toLowerCase()) {
      throw new SignRequestError(`Prevout ${i}: script does not match the chain`);
    }
  }
}

/** Strings-only view of a decoded request, safe for runtime messaging and JSON. */
export function toReview(d: DecodedSignRequest) {
  return {
    hashTypeName: d.hashTypeName,
    inputs: d.inputs.map((i) => ({
      index: i.index,
      address: i.address,
      amount: formatDivi(i.amountSats),
      alreadySigned: i.alreadySigned,
      willSign: i.willSign,
      mine: i.mine,
    })),
    outputs: d.outputs.map((o) => ({
      index: o.index,
      kind: o.kind as string,
      address: o.address,
      amount: formatDivi(o.amountSats),
      dataHex: o.dataHex,
      mine: o.mine,
    })),
    totalIn: formatDivi(d.totalInSats),
    totalOut: formatDivi(d.totalOutSats),
    fee: formatDivi(d.feeSats),
    complete: d.complete,
    warnings: d.warnings,
  };
}
