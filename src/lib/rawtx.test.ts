import { describe, expect, it } from 'vitest';
import { hexToBytes, bytesToHex } from './hex';
import { parseRawTx, serializeRawTx, signatureHash, SIGHASH } from './rawtx';
import vectors from './__fixtures__/signraw-vectors.json';

// Vectors were produced by the divi-assets reference (signatureHash / signP2pkhInput in
// divi-nft/packages/divi-assets/src/tx.ts) with throwaway test keys. That library signs
// the listing / buy / offer / accept transactions the marketplace has relayed on testnet,
// so a hash that matches it is a hash Divi Core accepts.

describe('raw transaction codec', () => {
  it('round-trips the unsigned vector byte for byte', () => {
    const tx = parseRawTx(vectors.unsignedHex);
    expect(tx.inputs).toHaveLength(3);
    expect(tx.outputs).toHaveLength(3);
    expect(serializeRawTx(tx)).toBe(vectors.unsignedHex);
  });

  it('keeps 64-bit output values exact (above 2^53)', () => {
    const tx = parseRawTx(vectors.unsignedHex);
    tx.outputs[0].value = (1n << 60n) + 12345n;
    const again = parseRawTx(serializeRawTx(tx));
    expect(again.outputs[0].value).toBe((1n << 60n) + 12345n);
  });

  it('rejects trailing bytes, truncation and non-hex', () => {
    expect(() => parseRawTx(vectors.unsignedHex + '00')).toThrow(/trailing/i);
    expect(() => parseRawTx(vectors.unsignedHex.slice(0, -2))).toThrow();
    expect(() => parseRawTx('zz' + vectors.unsignedHex.slice(2))).toThrow();
    expect(() => parseRawTx('')).toThrow();
  });
});

describe('signatureHash matches the reference implementation', () => {
  const tx = parseRawTx(vectors.unsignedHex);
  for (const c of vectors.cases) {
    it(`${c.hashName} on input ${c.index}`, () => {
      const script = hexToBytes(vectors.prevouts[c.index].scriptPubKey);
      expect(bytesToHex(signatureHash(tx, c.index, script, c.hashType))).toBe(c.sighash);
    });
  }

  it('SIGHASH_SINGLE with no matching output hashes to the constant 1 (the historic bug)', () => {
    const two = parseRawTx(vectors.unsigned2OutHex);
    const script = hexToBytes(vectors.prevouts[2].scriptPubKey);
    expect(bytesToHex(signatureHash(two, 2, script, SIGHASH.SINGLE | SIGHASH.ANYONECANPAY))).toBe(vectors.singleBugSighash);
  });

  it('exposes the flag constants', () => {
    expect(SIGHASH.ALL).toBe(1);
    expect(SIGHASH.SINGLE).toBe(3);
    expect(SIGHASH.ANYONECANPAY).toBe(0x80);
  });
});
