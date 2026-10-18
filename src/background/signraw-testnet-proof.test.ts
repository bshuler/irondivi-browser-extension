// Live PUBLIC TESTNET proof of walletCore.signRawTransaction (the NEW raw signer under test).
//
// Gated behind SIGNRAW_TESTNET_PROOF=1 so it never runs in normal unit/CI runs. It:
//   1. Resolves the autogen "CV NFT proof (Divi TESTNET) autogen key" seed EXACTLY ONCE via `secret get`.
//   2. Derives the key IN-PROCESS through the extension's own Mnemonic -> HDKey -> Address path
//      (m/44'/1'/0'/0/i, testnet coinType 1) -- never a hand-rolled signer.
//   3. Funds from the wallet's existing testnet UTXOs (faucet only if empty).
//   4. Signs through decodeSignRequest + verifyPrevoutsOnChain + walletCore.signRawTransaction.
//   5. Broadcasts to PUBLIC TESTNET via the nft api (which independently re-verifies signatures).
//
// SAFETY: the seed phrase, the BIP39 seed, and the 32-byte private key are NEVER printed, logged,
// returned, put in an expect(), or written to disk. Only derived public testnet addresses, txids,
// booleans and confirmation counts ever appear in output. Testnet is hardcoded; mainnet is
// impossible here (address asserted testnet-only before any network call).
//
// Run:  SIGNRAW_TESTNET_PROOF=1 npx vitest run --bail 1 src/background/signraw-testnet-proof.test.ts

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { hexToBytes } from '../lib/hex';
import { parseRawTx, serializeRawTx, rawTxId, type RawTx } from '../lib/rawtx';
import { decodeSignRequest, verifyPrevoutsOnChain, type SignPrevout } from '../lib/sign-request';
import { Mnemonic } from '../lib/mnemonic';
import { HDKey } from '../lib/hdkey';
import { Address } from '../lib/address';
import { walletCore } from './wallet-core';

const RUN = !!process.env.SIGNRAW_TESTNET_PROOF;
const NETWORK = 'testnet' as const;
const BASE = 'https://services.divi.domains/testnet';
const RPC = 'https://services.divi.domains/api/testnet/rpc/';
const EXPLORER = 'https://services.divi.domains/testnet/explorer/tx/';
const FEE_SATS = 1_000_000n; // 0.01 DIVI per tx
const DUST_SATS = 10_000n; // 0.0001 DIVI

// ---- secret plumbing: resolve exactly once, never echo the value --------------------------------

/** The autogen testnet-proof key seed note, resolved once. Returns raw token words; never logged. */
function resolveSeedWords(): string[] {
  let note: string;
  try {
    note = execFileSync(
      'secret',
      ['get', '--name', 'cv-nft-proof-testnet-autogen', '--op-ref', 'op://ptah-divi/smwakzwa6zy3ukgekkvywhnsvm/notesPlain'],
      { encoding: 'utf8', timeout: 90_000, stdio: ['ignore', 'pipe', 'ignore'] }
    );
  } catch (err) {
    const e = err as { killed?: boolean; status?: number };
    if (e && e.killed) throw new Error('secret get timed out (likely a 1Password prompt with no human present) — PAUSED, not retrying');
    throw new Error('secret get failed, exit ' + (e?.status ?? '?'));
  }
  // Tokenize defensively: a SECURE_NOTE body may carry labels, numbering, an address line, etc.
  const words = note
    .toLowerCase()
    .split(/\s+/)
    .map((w) => w.replace(/[^a-z]/g, ''))
    .filter((w) => w.length > 0);
  return words;
}

/** Find the BIP39 phrase inside the note tokens. Tries the whole list, then fixed-length windows. */
function findMnemonic(words: string[]): string {
  const sizes = [24, 21, 18, 15, 12];
  const whole = words.join(' ');
  if (Mnemonic.validate(whole)) return whole;
  for (const n of sizes) {
    for (let i = 0; i + n <= words.length; i++) {
      const cand = words.slice(i, i + n).join(' ');
      if (Mnemonic.validate(cand)) return cand;
    }
  }
  throw new Error('seed format unrecognized (not a BIP39 mnemonic in the note) — PAUSED for Bert');
}

/** Derive {priv, address} at an index. Copies priv out before wiping the HD material. */
async function deriveAt(phrase: string, index: number): Promise<{ priv: Uint8Array; address: string }> {
  const seed = await Mnemonic.toSeed(phrase);
  const hd = await HDKey.fromMasterSeed(seed);
  try {
    const d = await hd.derive(`m/44'/1'/0'/0/${index}`);
    try {
      if (!d.privateKey || !d.publicKey) throw new Error('derivation produced no key');
      const priv = d.privateKey.slice(); // copy before wipe
      const address = Address.fromPublicKey(d.publicKey, NETWORK);
      return { priv, address };
    } finally {
      d.wipe();
    }
  } finally {
    hd.wipe();
  }
}

// ---- chain access (all PUBLIC testnet) ----------------------------------------------------------

interface Utxo {
  txid: string;
  vout: number;
  value: string;
  script: string;
  height: number;
}

async function rpc<T>(method: string, params: unknown[]): Promise<T> {
  const r = await fetch(RPC, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '1.0', id: 'proof', method, params }),
  });
  const b = (await r.json()) as { result: T; error: { message: string } | null };
  if (b.error) throw new Error(`${method}: ${b.error.message}`);
  return b.result;
}

const fetchRaw = (txid: string) => rpc<string>('getrawtransaction', [txid, 0]);

async function listUtxos(addr: string): Promise<Utxo[]> {
  const r = await fetch(`${BASE}/nft/api/address/${addr}/utxos`);
  if (!r.ok) throw new Error('utxos http ' + r.status);
  return (await r.json()) as Utxo[];
}

/** Build a chain-verified SignPrevout from the proxy (amount + scriptPubKey come from the chain). */
async function prevoutOf(txid: string, vout: number): Promise<SignPrevout> {
  const tx = await rpc<{ vout: { value: number; scriptPubKey: { hex: string } }[] }>('getrawtransaction', [txid, 1]);
  const out = tx.vout[vout];
  if (!out) throw new Error(`no vout ${vout} on ${txid}`);
  return { txid, vout, amount: out.value, scriptPubKey: out.scriptPubKey.hex };
}

async function broadcast(hex: string): Promise<string> {
  const r = await fetch(`${BASE}/nft/api/tx/broadcast`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ hex }),
  });
  const b = (await r.json().catch(() => ({}))) as { txid?: string; error?: string; message?: string };
  if (!r.ok || !b.txid) throw new Error('broadcast rejected: ' + (b.error || b.message || 'http ' + r.status));
  return b.txid;
}

async function waitConfirm(txid: string, timeoutMs = 600_000): Promise<number> {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    try {
      const t = await rpc<{ confirmations?: number }>('getrawtransaction', [txid, 1]);
      if ((t.confirmations ?? 0) >= 1) return t.confirmations as number;
    } catch {
      /* not yet retrievable; keep polling */
    }
    await new Promise((r) => setTimeout(r, 15_000));
  }
  return 0;
}

async function tryFaucet(addr: string): Promise<void> {
  try {
    await fetch(`${BASE}/faucet/api/request`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ address: addr }),
    });
  } catch {
    /* best effort */
  }
}

// ---- tx construction (mirrors the regtest integration harness) ----------------------------------

const satsOf = (divi: number) => BigInt(Math.round(divi * 1e8));

function build(inputs: SignPrevout[], outputs: { script: Uint8Array; valueSats: bigint }[]): RawTx {
  return {
    version: 1,
    inputs: inputs.map((p) => ({ txid: p.txid, vout: p.vout, scriptSig: new Uint8Array(0), sequence: 0xffffffff })),
    outputs: outputs.map((o) => ({ value: o.valueSats, script: o.script })),
    locktime: 0,
  };
}

// ---- shared state resolved once in beforeAll ----------------------------------------------------

let PHRASE = '';
let PRIV: Uint8Array = new Uint8Array(0);
let ADDRESS = '';
let SCRIPT = new Uint8Array(0); // the wallet's own P2PKH scriptPubKey (for self-send outputs)
const REPORT: Record<string, unknown> = { legA: {}, legB: {} };

/** Decode + chain-verify + sign through the NEW signer, exactly as the service worker would. */
async function walletSign(txHex: string, prevouts: SignPrevout[], indexes: number[], hashType: number): Promise<string> {
  decodeSignRequest({ txHex, prevouts, indexes, hashType }, NETWORK, [ADDRESS]);
  await verifyPrevoutsOnChain(prevouts, fetchRaw);
  const keys = new Map(indexes.map((i) => [i, PRIV] as const));
  return (await walletCore.signRawTransaction(txHex, prevouts, indexes, hashType, keys)).hex;
}

describe.skipIf(!RUN)('walletCore.signRawTransaction accepted by Divi public testnet', () => {
  beforeAll(async () => {
    PHRASE = findMnemonic(resolveSeedWords());

    // Find the funded index (0..4). index 0 is the wallet's one key, so try it first.
    let funded: { priv: Uint8Array; address: string; utxos: Utxo[] } | null = null;
    for (let i = 0; i <= 4; i++) {
      const { priv, address } = await deriveAt(PHRASE, i);
      // MAINNET GATE: the derived address must be a valid testnet address and NOT a mainnet one.
      if (!Address.validate(address, 'testnet') || Address.validate(address, 'mainnet')) {
        throw new Error(`derived address at index ${i} is not testnet-only — refusing (mainnet gate)`);
      }
      const u = await listUtxos(address);
      if (u.length > 0) {
        funded = { priv, address, utxos: u };
        REPORT.fundedIndex = i;
        break;
      }
      if (i === 0) {
        // not funded yet: ask the faucet once, wait, re-check index 0
        await tryFaucet(address);
        const end = Date.now() + 600_000;
        let again: Utxo[] = [];
        while (Date.now() < end) {
          again = await listUtxos(address);
          if (again.length > 0) break;
          await new Promise((r) => setTimeout(r, 15_000));
        }
        if (again.length > 0) {
          funded = { priv, address, utxos: again };
          REPORT.fundedIndex = 0;
          REPORT.faucetUsed = true;
          break;
        }
      }
    }
    if (!funded) throw new Error('no funded testnet UTXO on indexes 0..4 (faucet did not land) — PAUSED');

    PRIV = funded.priv;
    ADDRESS = funded.address;
    SCRIPT = hexToBytes(funded.utxos[0].script);
    REPORT.address = ADDRESS;
    REPORT.explorerBase = EXPLORER;
  }, 900_000);

  it(
    'Leg A: plain SIGHASH_ALL self-send signs and is accepted by the testnet node',
    async () => {
      const u = (await listUtxos(ADDRESS)).sort((a, b) => Number(BigInt(Math.round(Number(b.value) * 1e8)) - BigInt(Math.round(Number(a.value) * 1e8))));
      const prev = await prevoutOf(u[0].txid, u[0].vout);
      const totalSats = satsOf(prev.amount);
      expect(totalSats).toBeGreaterThan(FEE_SATS + 2n * DUST_SATS);

      // 1-in / 2-out self-send so Leg B has two spendable inputs.
      const spendable = totalSats - FEE_SATS;
      const out0 = spendable / 2n;
      const out1 = spendable - out0;
      const tx = build([prev], [
        { script: SCRIPT, valueSats: out0 },
        { script: SCRIPT, valueSats: out1 },
      ]);

      const signed = await walletSign(serializeRawTx(tx), [prev], [0], 0x01);
      const localTxid = rawTxId(signed);
      const txid = await broadcast(signed);
      expect(txid).toBe(localTxid); // node accepted exactly the tx the new signer produced

      (REPORT.legA as Record<string, unknown>).txid = txid;
      (REPORT.legA as Record<string, unknown>).explorer = EXPLORER + txid;
      (REPORT.legA as Record<string, unknown>).broadcastAccepted = true;

      const conf = await waitConfirm(txid);
      (REPORT.legA as Record<string, unknown>).confirmations = conf;
      (REPORT.legA as Record<string, unknown>).result = 'PASS';
    },
    900_000
  );

  it(
    'Leg B: SINGLE|ANYONECANPAY signature survives, second input added and signed ALL',
    async () => {
      const legA = REPORT.legA as { txid?: string; confirmations?: number };
      if (!legA.txid) {
        (REPORT.legB as Record<string, unknown>).result = 'SKIPPED (Leg A did not broadcast)';
        return;
      }
      // Need Leg A retrievable on the node for verifyPrevoutsOnChain. Wait if not yet confirmed.
      if ((legA.confirmations ?? 0) < 1) await waitConfirm(legA.txid);

      const p0 = await prevoutOf(legA.txid, 0);
      const p1 = await prevoutOf(legA.txid, 1);

      // listing: input 0 -> output 0, signed SINGLE|ANYONECANPAY (0x83). Only that pair is bound.
      const out0 = satsOf(p0.amount) - FEE_SATS;
      expect(out0).toBeGreaterThan(DUST_SATS);
      const listing = build([p0], [{ script: SCRIPT, valueSats: out0 }]);
      const listed = await walletSign(serializeRawTx(listing), [p0], [0], 0x83);

      // extend: add input 1 and output 1, sign input 1 with ALL (0x01). Same wallet is fine.
      const tx = parseRawTx(listed);
      tx.inputs.push({ txid: p1.txid, vout: p1.vout, scriptSig: new Uint8Array(0), sequence: 0xffffffff });
      tx.outputs.push({ value: satsOf(p1.amount), script: SCRIPT });
      const completed = await walletSign(serializeRawTx(tx), [p0, p1], [1], 0x01);

      // the SINGLE|ACP scriptSig from the first signing survived the extension
      expect(parseRawTx(completed).inputs[0].scriptSig.length).toBeGreaterThan(0);

      const localTxid = rawTxId(completed);
      const txid = await broadcast(completed);
      expect(txid).toBe(localTxid);

      (REPORT.legB as Record<string, unknown>).txid = txid;
      (REPORT.legB as Record<string, unknown>).explorer = EXPLORER + txid;
      (REPORT.legB as Record<string, unknown>).broadcastAccepted = true;
      (REPORT.legB as Record<string, unknown>).sighash = 'input0=SINGLE|ANYONECANPAY, input1=ALL';

      const conf = await waitConfirm(txid);
      (REPORT.legB as Record<string, unknown>).confirmations = conf;
      (REPORT.legB as Record<string, unknown>).result = 'PASS';
    },
    900_000
  );

  afterAll(() => {
    // Only safe fields (addresses, txids, booleans, counts) — never the seed/key.
    console.log('\n===== TESTNET SIGNRAW PROOF REPORT =====\n' + JSON.stringify(REPORT, null, 2) + '\n========================================\n');
  });
});
