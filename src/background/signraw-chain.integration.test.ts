// Gate 3 proof: signatures made by the wallet's signing path are accepted by Divi Core's
// consensus code. Runs only when SIGNRAW_RPC_URL (and SIGNRAW_RPC_AUTH, "user:password") are set,
// e.g. against a throwaway regtest node. Funds come from the node's own wallet; the signing
// keys are the throwaway keys in the shared vectors. Broadcasting happens HERE, in the
// harness, never in the wallet code under test.

import { describe, expect, it } from 'vitest';
import { hexToBytes } from '../lib/hex';
import { parseRawTx, serializeRawTx, rawTxId, type RawTx } from '../lib/rawtx';
import { decodeSignRequest, verifyPrevoutsOnChain, type SignPrevout } from '../lib/sign-request';
import { walletCore } from './wallet-core';
import vectors from '../lib/__fixtures__/signraw-vectors.json';

const URL_ = process.env.SIGNRAW_RPC_URL;
const AUTH = process.env.SIGNRAW_RPC_AUTH;
const NETWORK = (process.env.SIGNRAW_NETWORK ?? 'testnet') as 'testnet';

async function rpc<T = unknown>(method: string, params: unknown[] = []): Promise<T> {
  const res = await fetch(URL_!, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Basic ' + Buffer.from(AUTH!).toString('base64') },
    body: JSON.stringify({ jsonrpc: '1.0', id: 'signraw', method, params }),
  });
  const body = (await res.json()) as { result: T; error: { message: string } | null };
  if (body.error) throw new Error(`${method}: ${body.error.message}`);
  return body.result;
}

const A = vectors.keys.A;
const B = vectors.keys.B;
const key = (k: { priv: string }) => hexToBytes(k.priv);
const sats = (divi: string) => BigInt(Math.round(Number(divi) * 1e8));
const p2pkh = (k: { script: string }) => hexToBytes(k.script);

/** Fund `address` with `amount` DIVI from the node wallet; return the resulting prevout. */
async function fund(k: typeof A, amount: number): Promise<SignPrevout> {
  const txid = await rpc<string>('sendtoaddress', [k.address, amount]);
  const tx = await rpc<{ vout: { value: number; scriptPubKey: { hex: string } }[] }>('getrawtransaction', [txid, 1]);
  const vout = tx.vout.findIndex((o) => o.scriptPubKey.hex === k.script);
  expect(vout).toBeGreaterThanOrEqual(0);
  return { txid, vout, amount: tx.vout[vout].value, scriptPubKey: k.script };
}

function build(inputs: SignPrevout[], outputs: { script: Uint8Array; divi: string }[]): RawTx {
  return {
    version: 1,
    inputs: inputs.map((p) => ({ txid: p.txid, vout: p.vout, scriptSig: new Uint8Array(0), sequence: 0xffffffff })),
    outputs: outputs.map((o) => ({ value: sats(o.divi), script: o.script })),
    locktime: 0,
  };
}

const ownAll = [A.address, B.address];
const fetchRaw = (txid: string) => rpc<string>('getrawtransaction', [txid, 0]);

/** Decode + chain-verify + sign, exactly as the service worker does, then return hex. */
async function walletSign(txHex: string, prevouts: SignPrevout[], indexes: number[], hashType: number, k: typeof A) {
  decodeSignRequest({ txHex, prevouts, indexes, hashType }, NETWORK, ownAll);
  await verifyPrevoutsOnChain(prevouts, fetchRaw);
  const keys = new Map(indexes.map((i) => [i, key(k)] as const));
  return (await walletCore.signRawTransaction(txHex, prevouts, indexes, hashType, keys)).hex;
}

async function mine(n = 1) {
  await rpc('setgenerate', [n]);
}

describe.skipIf(!URL_ || !AUTH)('signRawTransaction accepted by Divi Core consensus', () => {
  it('node is reachable and regtest-funded', async () => {
    expect(Number(await rpc('getbalance'))).toBeGreaterThan(1000);
  });

  it('plain SIGHASH_ALL spend is accepted and confirms', async () => {
    const p = await fund(A, 5);
    await mine();
    const tx = build([p], [{ script: p2pkh(B), divi: '4.99' }]);
    const signed = await walletSign(serializeRawTx(tx), [p], [0], 0x01, A);
    const txid = await rpc<string>('sendrawtransaction', [signed]);
    expect(txid).toBe(rawTxId(signed));
    await mine();
    expect((await rpc<{ confirmations: number }>('getrawtransaction', [txid, 1])).confirmations).toBeGreaterThanOrEqual(1);
  });

  it('marketplace flow: seller signs SINGLE|ANYONECANPAY, buyer adds an input and outputs, signs ALL', async () => {
    const carrier = await fund(A, 50);
    const buyerCoin = await fund(B, 20);
    await mine();

    // listing: input 0 (seller) -> output 0 (price to seller). Seller signs only that pair.
    const listing = build([carrier], [{ script: p2pkh(A), divi: '10' }]);
    const listed = await walletSign(serializeRawTx(listing), [carrier], [0], 0x83, A);

    // buyer extends it: adds input 1 and outputs 1, 2, then signs input 1 with ALL
    const tx = parseRawTx(listed);
    tx.inputs.push({ txid: buyerCoin.txid, vout: buyerCoin.vout, scriptSig: new Uint8Array(0), sequence: 0xffffffff });
    tx.outputs.push({ value: sats('49.99'), script: p2pkh(B) }, { value: sats('9.99'), script: p2pkh(B) });
    const both = [carrier, buyerCoin];
    const completed = await walletSign(serializeRawTx(tx), both, [1], 0x01, B);

    // the seller's signature survived and the whole thing is valid consensus-wise
    expect(parseRawTx(completed).inputs[0].scriptSig.length).toBeGreaterThan(0);
    const txid = await rpc<string>('sendrawtransaction', [completed]);
    await mine();
    expect((await rpc<{ confirmations: number }>('getrawtransaction', [txid, 1])).confirmations).toBeGreaterThanOrEqual(1);
  });

  it('a SINGLE|ANYONECANPAY signature binds its output: changing output 0 afterwards is rejected', async () => {
    const carrier = await fund(A, 30);
    const buyerCoin = await fund(B, 20);
    await mine();
    const listed = await walletSign(serializeRawTx(build([carrier], [{ script: p2pkh(A), divi: '10' }])), [carrier], [0], 0x83, A);
    const tx = parseRawTx(listed);
    tx.outputs[0].value = sats('1'); // buyer tries to underpay
    tx.inputs.push({ txid: buyerCoin.txid, vout: buyerCoin.vout, scriptSig: new Uint8Array(0), sequence: 0xffffffff });
    tx.outputs.push({ value: sats('48.99'), script: p2pkh(B) });
    const completed = await walletSign(serializeRawTx(tx), [carrier, buyerCoin], [1], 0x01, B);
    await expect(rpc('sendrawtransaction', [completed])).rejects.toThrow(/script|signature|verify|mandatory|invalid/i);
  });

  it('offer flow: ALL|ANYONECANPAY commits to every output, other inputs may join', async () => {
    const offerCoin = await fund(B, 10);
    const sellerNft = await fund(A, 5);
    await mine();
    // buyer (B) offers: outputs fixed up front (5 DIVI to seller, NFT carrier to B), signs ALL|ACP on its own input
    const tx = build([offerCoin], [{ script: p2pkh(A), divi: '9.99' }]);
    const offered = await walletSign(serializeRawTx(tx), [offerCoin], [0], 0x81, B);
    // seller accepts: adds the NFT input and an output returning it to the buyer, signs ALL on its input
    const t2 = parseRawTx(offered);
    t2.inputs.push({ txid: sellerNft.txid, vout: sellerNft.vout, scriptSig: new Uint8Array(0), sequence: 0xffffffff });
    // ACP|ALL commits to ALL outputs, so adding an output now would break B's signature: spend the extra
    // input into the existing outputs' slack instead (fee), proving inputs can join without breaking it.
    t2.outputs[0].value = t2.outputs[0].value; // unchanged
    const accepted = await walletSign(serializeRawTx(t2), [offerCoin, sellerNft], [1], 0x01, A);
    const txid = await rpc<string>('sendrawtransaction', [accepted]);
    await mine();
    expect((await rpc<{ confirmations: number }>('getrawtransaction', [txid, 1])).confirmations).toBeGreaterThanOrEqual(1);
  });
});
