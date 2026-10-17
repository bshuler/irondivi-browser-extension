import { describe, expect, it } from 'vitest';
import { bytesToHex } from './hex';
import { Hash } from './hash';
import { parseRawTx } from './rawtx';
import { decodeSignRequest, verifyPrevoutsOnChain, SignRequestError, type SignRawRequest } from './sign-request';
import vectors from './__fixtures__/signraw-vectors.json';

const ALL = 1;
const SINGLE_ACP = 0x83;
const ALL_ACP = 0x81;
const ownAddresses = [vectors.keys.A.address, vectors.keys.B.address];

function req(over: Partial<SignRawRequest> = {}): SignRawRequest {
  return {
    txHex: vectors.unsignedHex,
    prevouts: vectors.prevouts.map((p) => ({ txid: p.txid, vout: p.vout, amount: p.amount, scriptPubKey: p.scriptPubKey })),
    indexes: [0, 1, 2],
    hashType: ALL,
    ...over,
  };
}

describe('decodeSignRequest (gate 1: decode and verify before signing)', () => {
  it('decodes inputs, outputs, addresses, amounts and the fee', () => {
    const d = decodeSignRequest(req(), 'testnet', ownAddresses);
    expect(d.hashTypeName).toBe('ALL');
    expect(d.inputs).toHaveLength(3);
    expect(d.inputs[0]).toMatchObject({ index: 0, address: vectors.keys.A.address, amountSats: 5000000000n, willSign: true, alreadySigned: false, mine: true });
    expect(d.inputs[2]).toMatchObject({ address: vectors.keys.B.address, amountSats: 700000000n });
    expect(d.outputs[0]).toMatchObject({ index: 0, kind: 'p2pkh', address: vectors.keys.C.address, amountSats: 1000000000n, mine: false });
    expect(d.outputs[1]).toMatchObject({ index: 1, kind: 'data', address: null, amountSats: 0n });
    expect(d.outputs[2]).toMatchObject({ kind: 'p2pkh', address: vectors.keys.B.address, mine: true });
    expect(d.totalInSats).toBe(7700000000n);
    expect(d.totalOutSats).toBe(7699990000n);
    expect(d.feeSats).toBe(10000n);
    expect(d.complete).toBe(true);
    expect(d.warnings).toEqual([]);
  });

  it('marks inputs that are not being signed, and inputs that already carry a signature', () => {
    const d = decodeSignRequest(req({ txHex: vectors.listedHex, indexes: [1, 2] }), 'testnet', ownAddresses);
    expect(d.inputs[0]).toMatchObject({ willSign: false, alreadySigned: true });
    expect(d.inputs[1]).toMatchObject({ willSign: true, alreadySigned: false });
  });

  it('describes partial hash types in words and warns what they commit to', () => {
    const single = decodeSignRequest(req({ hashType: SINGLE_ACP, indexes: [0] }), 'testnet', ownAddresses);
    expect(single.hashTypeName).toBe('SINGLE|ANYONECANPAY');
    expect(single.warnings.join(' ')).toMatch(/only input 0 and output 0/i);
    const acp = decodeSignRequest(req({ hashType: ALL_ACP, indexes: [1] }), 'testnet', ownAddresses);
    expect(acp.hashTypeName).toBe('ALL|ANYONECANPAY');
    expect(acp.warnings.join(' ')).toMatch(/other inputs/i);
  });

  it('allows outputs above inputs for a partial signature (the other party funds it) but flags it', () => {
    // Listing shape: one 0.01 DIVI input signed, output 0 asks 10 DIVI.
    const d = decodeSignRequest(
      req({ hashType: SINGLE_ACP, indexes: [0], prevouts: req().prevouts.map((p, i) => (i === 0 ? { ...p, amount: 0.01 } : p)) }),
      'testnet',
      ownAddresses,
    );
    expect(d.complete).toBe(false);
  });

  it('refuses a SIGHASH_ALL request whose outputs exceed its inputs', () => {
    const prevouts = req().prevouts.map((p, i) => (i === 0 ? { ...p, amount: 1 } : p));
    expect(() => decodeSignRequest(req({ prevouts }), 'testnet', ownAddresses)).toThrow(/exceed/i);
  });

  it('refuses an absurd fee on a complete transaction', () => {
    const prevouts = req().prevouts.map((p, i) => (i === 0 ? { ...p, amount: 5000 } : p));
    expect(() => decodeSignRequest(req({ prevouts }), 'testnet', ownAddresses)).toThrow(/fee/i);
  });

  const bad: Array<[string, Partial<SignRawRequest>, RegExp]> = [
    ['empty indexes', { indexes: [] }, /index/i],
    ['duplicate index', { indexes: [1, 1] }, /duplicate/i],
    ['index out of range', { indexes: [3] }, /range/i],
    ['negative index', { indexes: [-1] }, /range|index/i],
    ['non-integer index', { indexes: [0.5] }, /index/i],
    ['SIGHASH_NONE', { hashType: 0x02 }, /hash type/i],
    ['NONE|ANYONECANPAY', { hashType: 0x82 }, /hash type/i],
    ['unknown hash type 0', { hashType: 0 }, /hash type/i],
    ['hash type above a byte', { hashType: 0x101 }, /hash type/i],
    ['SINGLE with no matching output', { txHex: vectors.unsigned2OutHex, hashType: SINGLE_ACP, indexes: [2] }, /no output|single/i],
    ['garbage hex', { txHex: 'nothex' }, /hex|transaction/i],
  ];
  for (const [name, over, re] of bad) {
    it(`refuses: ${name}`, () => {
      expect(() => decodeSignRequest(req(over), 'testnet', ownAddresses)).toThrow(re);
      try {
        decodeSignRequest(req(over), 'testnet', ownAddresses);
      } catch (e) {
        expect(e).toBeInstanceOf(SignRequestError);
      }
    });
  }

  it('refuses when prevouts do not line up with the inputs, one per input', () => {
    expect(() => decodeSignRequest(req({ prevouts: req().prevouts.slice(0, 2) }), 'testnet', ownAddresses)).toThrow(/prevout/i);
    const swapped = req().prevouts.slice();
    [swapped[0], swapped[1]] = [swapped[1], swapped[0]];
    expect(() => decodeSignRequest(req({ prevouts: swapped }), 'testnet', ownAddresses)).toThrow(/does not match/i);
  });

  it('refuses a signed input whose prevout is not pay-to-pubkey-hash', () => {
    const p2sh = 'a914' + '11'.repeat(20) + '87';
    const prevouts = req().prevouts.map((p, i) => (i === 0 ? { ...p, scriptPubKey: p2sh } : p));
    expect(() => decodeSignRequest(req({ prevouts, indexes: [0] }), 'testnet', ownAddresses)).toThrow(/p2pkh|pay-to-pubkey-hash/i);
  });

  it('refuses an amount with more than 8 decimals or a negative amount', () => {
    const lots = req().prevouts.map((p, i) => (i === 0 ? { ...p, amount: 1.123456789 } : p));
    expect(() => decodeSignRequest(req({ prevouts: lots }), 'testnet', ownAddresses)).toThrow(/amount/i);
    const neg = req().prevouts.map((p, i) => (i === 0 ? { ...p, amount: -1 } : p));
    expect(() => decodeSignRequest(req({ prevouts: neg }), 'testnet', ownAddresses)).toThrow(/amount/i);
  });
});

describe('verifyPrevoutsOnChain (do not trust the page for amounts or scripts)', () => {
  // Build a fake parent transaction paying `scriptHex` `sats` at output `vout`, then
  // return its real txid so the check that the node returned the right tx can pass.
  function parent(scriptHex: string, sats: bigint) {
    const hex =
      '01000000' + '01' + '00'.repeat(32) + '00000000' + '00' + 'ffffffff' + '01' +
      sats.toString(16).padStart(16, '0').match(/../g)!.reverse().join('') +
      (scriptHex.length / 2).toString(16).padStart(2, '0') + scriptHex + '00000000';
    const txid = bytesToHex(Hash.doubleSha256(Uint8Array.from(hex.match(/../g)!.map((b) => parseInt(b, 16)))).reverse());
    return { hex, txid };
  }
  void parseRawTx;

  it('accepts prevouts that match what the chain says', async () => {
    const p = parent(vectors.keys.A.script, 5000000000n);
    await expect(
      verifyPrevoutsOnChain([{ txid: p.txid, vout: 0, amount: 50, scriptPubKey: vectors.keys.A.script }], async () => p.hex),
    ).resolves.toBeUndefined();
  });

  it('refuses a lied-about amount', async () => {
    const p = parent(vectors.keys.A.script, 100000000n);
    await expect(
      verifyPrevoutsOnChain([{ txid: p.txid, vout: 0, amount: 50, scriptPubKey: vectors.keys.A.script }], async () => p.hex),
    ).rejects.toThrow(/amount/i);
  });

  it('refuses a lied-about script', async () => {
    const p = parent(vectors.keys.B.script, 5000000000n);
    await expect(
      verifyPrevoutsOnChain([{ txid: p.txid, vout: 0, amount: 50, scriptPubKey: vectors.keys.A.script }], async () => p.hex),
    ).rejects.toThrow(/script/i);
  });

  it('refuses when the node returns a different transaction than the one asked for', async () => {
    const p = parent(vectors.keys.A.script, 5000000000n);
    const other = parent(vectors.keys.A.script, 5000000001n);
    await expect(
      verifyPrevoutsOnChain([{ txid: p.txid, vout: 0, amount: 50, scriptPubKey: vectors.keys.A.script }], async () => other.hex),
    ).rejects.toThrow(/txid|different/i);
  });

  it('fails closed when the parent cannot be fetched', async () => {
    await expect(
      verifyPrevoutsOnChain([{ txid: 'aa'.repeat(32), vout: 0, amount: 1, scriptPubKey: vectors.keys.A.script }], async () => {
        throw new Error('not found');
      }),
    ).rejects.toThrow(/verify|fetch|not found/i);
  });

  it('refuses a vout that does not exist', async () => {
    const p = parent(vectors.keys.A.script, 5000000000n);
    await expect(
      verifyPrevoutsOnChain([{ txid: p.txid, vout: 5, amount: 50, scriptPubKey: vectors.keys.A.script }], async () => p.hex),
    ).rejects.toThrow(/vout|output/i);
  });
});
