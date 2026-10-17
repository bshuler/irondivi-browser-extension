// Raw transaction codec and legacy signature hash for signRawTransaction.
//
// Separate from transaction.ts on purpose: output values are bigint here, because a
// SIGHASH_SINGLE preimage carries 0xffffffffffffffff filler outputs that a JS number
// cannot represent, and amounts above 2^53 must survive a round trip exactly.

import { Hash } from './hash';
import { bytesToHex, hexToBytes } from './hex';

export const SIGHASH = {
  ALL: 0x01,
  NONE: 0x02,
  SINGLE: 0x03,
  ANYONECANPAY: 0x80,
} as const;

export interface RawTxIn {
  /** Previous txid, display (big-endian) hex. */
  txid: string;
  vout: number;
  scriptSig: Uint8Array;
  sequence: number;
}

export interface RawTxOut {
  value: bigint;
  script: Uint8Array;
}

export interface RawTx {
  version: number;
  inputs: RawTxIn[];
  outputs: RawTxOut[];
  locktime: number;
}

class Reader {
  private pos = 0;
  constructor(private readonly buf: Uint8Array) {}

  bytes(n: number): Uint8Array {
    if (n < 0 || this.pos + n > this.buf.length) throw new Error('Transaction is truncated');
    const out = this.buf.slice(this.pos, this.pos + n);
    this.pos += n;
    return out;
  }

  u32(): number {
    const b = this.bytes(4);
    return (b[0] | (b[1] << 8) | (b[2] << 16) | (b[3] << 24)) >>> 0;
  }

  u64(): bigint {
    const b = this.bytes(8);
    let v = 0n;
    for (let i = 7; i >= 0; i--) v = (v << 8n) | BigInt(b[i]);
    return v;
  }

  varint(): number {
    const first = this.bytes(1)[0];
    if (first < 0xfd) return first;
    if (first === 0xfd) {
      const b = this.bytes(2);
      return b[0] | (b[1] << 8);
    }
    if (first === 0xfe) return this.u32();
    const v = this.u64();
    if (v > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error('Transaction length is out of range');
    return Number(v);
  }

  varbytes(): Uint8Array {
    return this.bytes(this.varint());
  }

  end(): void {
    if (this.pos !== this.buf.length) throw new Error('Transaction has trailing bytes');
  }
}

class Writer {
  private parts: number[] = [];

  bytes(b: Uint8Array): this {
    for (const x of b) this.parts.push(x);
    return this;
  }

  u32(n: number): this {
    this.parts.push(n & 0xff, (n >>> 8) & 0xff, (n >>> 16) & 0xff, (n >>> 24) & 0xff);
    return this;
  }

  u64(v: bigint): this {
    if (v < 0n || v > 0xffffffffffffffffn) throw new Error('Amount is out of range');
    for (let i = 0; i < 8; i++) this.parts.push(Number((v >> BigInt(8 * i)) & 0xffn));
    return this;
  }

  varint(n: number): this {
    if (n < 0xfd) this.parts.push(n);
    else if (n <= 0xffff) this.parts.push(0xfd, n & 0xff, n >> 8);
    else {
      this.parts.push(0xfe);
      this.u32(n);
    }
    return this;
  }

  varbytes(b: Uint8Array): this {
    return this.varint(b.length).bytes(b);
  }

  finish(): Uint8Array {
    return Uint8Array.from(this.parts);
  }
}

function reverseBytes(b: Uint8Array): Uint8Array {
  return Uint8Array.from(b).reverse();
}

export function parseRawTx(hex: string): RawTx {
  if (typeof hex !== 'string' || hex.length === 0 || hex.length % 2 !== 0 || !/^[0-9a-fA-F]+$/.test(hex)) {
    throw new Error('Transaction is not valid hex');
  }
  const r = new Reader(hexToBytes(hex));
  const version = r.u32();
  const nIn = r.varint();
  const inputs: RawTxIn[] = [];
  for (let k = 0; k < nIn; k++) {
    const txid = bytesToHex(reverseBytes(r.bytes(32)));
    const vout = r.u32();
    const scriptSig = r.varbytes();
    const sequence = r.u32();
    inputs.push({ txid, vout, scriptSig, sequence });
  }
  const nOut = r.varint();
  const outputs: RawTxOut[] = [];
  for (let k = 0; k < nOut; k++) outputs.push({ value: r.u64(), script: r.varbytes() });
  const locktime = r.u32();
  r.end();
  return { version, inputs, outputs, locktime };
}

export function serializeRawTxBytes(tx: RawTx): Uint8Array {
  const w = new Writer();
  w.u32(tx.version).varint(tx.inputs.length);
  for (const i of tx.inputs) {
    w.bytes(reverseBytes(hexToBytes(i.txid))).u32(i.vout).varbytes(i.scriptSig).u32(i.sequence);
  }
  w.varint(tx.outputs.length);
  for (const o of tx.outputs) w.u64(o.value).varbytes(o.script);
  w.u32(tx.locktime);
  return w.finish();
}

export function serializeRawTx(tx: RawTx): string {
  return bytesToHex(serializeRawTxBytes(tx));
}

/** Transaction id (display hex) of a serialized transaction. */
export function rawTxId(hexOrBytes: string | Uint8Array): string {
  const bytes = typeof hexOrBytes === 'string' ? hexToBytes(hexOrBytes) : hexOrBytes;
  return bytesToHex(reverseBytes(Hash.doubleSha256(bytes)));
}

/**
 * Legacy (pre-segwit) signature hash, as Divi Core's SignatureHash().
 * `scriptCode` is the previous output's scriptPubKey (P2PKH only here).
 * SIGHASH_SINGLE with no output at `index` returns the historic constant 1; callers
 * that sign MUST refuse that case rather than sign it.
 */
export function signatureHash(tx: RawTx, index: number, scriptCode: Uint8Array, hashType: number): Uint8Array {
  if (!Number.isInteger(index) || index < 0 || index >= tx.inputs.length) throw new Error('Input index out of range');
  const base = hashType & 0x1f;
  if (base === SIGHASH.SINGLE && index >= tx.outputs.length) {
    const one = new Uint8Array(32);
    one[0] = 1;
    return one;
  }

  let inputs: RawTxIn[] = tx.inputs.map((i, k) => ({
    ...i,
    scriptSig: k === index ? scriptCode : new Uint8Array(0),
    sequence: (base === SIGHASH.NONE || base === SIGHASH.SINGLE) && k !== index ? 0 : i.sequence,
  }));
  let outputs: RawTxOut[] = tx.outputs;
  if (base === SIGHASH.NONE) {
    outputs = [];
  } else if (base === SIGHASH.SINGLE) {
    outputs = [];
    for (let k = 0; k < index; k++) outputs.push({ value: 0xffffffffffffffffn, script: new Uint8Array(0) });
    outputs.push(tx.outputs[index]);
  }
  if (hashType & SIGHASH.ANYONECANPAY) inputs = [inputs[index]];

  const pre = new Writer().bytes(serializeRawTxBytes({ ...tx, inputs, outputs })).u32(hashType >>> 0);
  return Hash.doubleSha256(pre.finish());
}
