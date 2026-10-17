import { describe, expect, it } from 'vitest';
import { hexToBytes } from '../lib/hex';
import { parseRawTx } from '../lib/rawtx';
import { walletCore } from './wallet-core';
import vectors from '../lib/__fixtures__/signraw-vectors.json';

const keyOf = (name: string) => hexToBytes(name === 'A' ? vectors.keys.A.priv : vectors.keys.B.priv);
const prevouts = vectors.prevouts.map((p) => ({ txid: p.txid, vout: p.vout, amount: p.amount, scriptPubKey: p.scriptPubKey }));

describe('walletCore.signRawTransaction', () => {
  // The tightest check available: the extension's own signer (hand-rolled RFC 6979, low-S)
  // must produce byte-identical scriptSigs to the reference library for every flag/input.
  for (const c of vectors.cases) {
    it(`${c.hashName} on input ${c.index} is byte-identical to the reference`, async () => {
      const out = await walletCore.signRawTransaction(
        vectors.unsignedHex,
        prevouts,
        [c.index],
        c.hashType,
        new Map([[c.index, keyOf(c.key)]]),
      );
      expect(out.signedIndexes).toEqual([c.index]);
      const tx = parseRawTx(out.hex);
      expect(Buffer.from(tx.inputs[c.index].scriptSig).toString('hex')).toBe(c.scriptSig);
      // every other input is left exactly as it came in (empty)
      tx.inputs.forEach((inp, i) => {
        if (i !== c.index) expect(inp.scriptSig.length).toBe(0);
      });
    });
  }

  it('signs several inputs in one call', async () => {
    const out = await walletCore.signRawTransaction(
      vectors.unsignedHex,
      prevouts,
      [0, 1, 2],
      1,
      new Map([[0, keyOf('A')], [1, keyOf('A')], [2, keyOf('B')]]),
    );
    expect(out.signedIndexes).toEqual([0, 1, 2]);
    const tx = parseRawTx(out.hex);
    expect(tx.inputs.every((i) => i.scriptSig.length > 0)).toBe(true);
  });

  it("preserves another party's signature already on the transaction (buyer completes a listing)", async () => {
    const out = await walletCore.signRawTransaction(
      vectors.listedHex,
      prevouts,
      [2],
      1,
      new Map([[2, keyOf('B')]]),
    );
    const tx = parseRawTx(out.hex);
    expect(Buffer.from(tx.inputs[0].scriptSig).toString('hex')).toBe(vectors.listedInput0ScriptSig);
    expect(Buffer.from(tx.inputs[2].scriptSig).toString('hex')).toBe(vectors.buyerInput2ScriptSig);
    expect(out.hex).toBe(vectors.buyerCompletedHex);
  });

  it('refuses to sign an input the supplied key does not own', async () => {
    await expect(
      walletCore.signRawTransaction(vectors.unsignedHex, prevouts, [2], 1, new Map([[2, keyOf('A')]])),
    ).rejects.toThrow(/does not own|not ours|owner/i);
  });

  it('refuses when no key is supplied for a requested input', async () => {
    await expect(walletCore.signRawTransaction(vectors.unsignedHex, prevouts, [0], 1, new Map())).rejects.toThrow(/key/i);
  });

  it('refuses hash types it does not support, before touching any key', async () => {
    for (const ht of [0, 2, 0x82, 0x04, 0x181]) {
      await expect(
        walletCore.signRawTransaction(vectors.unsignedHex, prevouts, [0], ht, new Map([[0, keyOf('A')]])),
      ).rejects.toThrow(/hash type/i);
    }
  });

  it('refuses SIGHASH_SINGLE on an input with no matching output (signs the constant 1)', async () => {
    await expect(
      walletCore.signRawTransaction(vectors.unsigned2OutHex, prevouts, [2], 0x83, new Map([[2, keyOf('B')]])),
    ).rejects.toThrow(/single|no output/i);
  });

  it('never broadcasts: the result is hex only', async () => {
    const out = await walletCore.signRawTransaction(vectors.unsignedHex, prevouts, [0], 1, new Map([[0, keyOf('A')]]));
    expect(Object.keys(out).sort()).toEqual(['hex', 'signedIndexes']);
  });
});
