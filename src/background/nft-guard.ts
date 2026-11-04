/**
 * Keeps Divi NFT coins out of ordinary sends.
 *
 * A DT/1 colored coin (divi-nft docs/DIVI-ASSET-STANDARD.md) looks like any
 * other coin to getaddressutxos and listunspent. Spending it as a plain input
 * burns the NFT; §10 says a wallet must not use one to fund a payment or pay a
 * fee.
 *
 * Color is created or moved only by a transaction with an OP_META output whose
 * one push starts with "DIVA". The outputs that payload names are the colored
 * ones; every other output of it (payment, change) is plain DIVI, and so is
 * every output of a transaction without one (spending a colored coin any other
 * way burns it). So each coin is checked against the transaction that made
 * it: one level, no indexer or marketplace API, and it works on any network
 * and server.
 *
 * Fail-safe: a coin whose parent cannot be fetched, does not hash to its txid
 * or cannot be read is held for this send (status unknown) and that miss is
 * never cached. A "DIVA" payload that does not decode, or two of them, holds
 * every output of that transaction.
 *
 * The same logic as divi-wallet/lib/nft-guard.js (web wallet) and
 * services/telegram-wallet-app/src/core/nftGuard.js in divi-infrastructure;
 * fixtures/nft-vectors.json was made with divi-nft's own encoder and is shared
 * by all three.
 */

import { storage } from '../shared/browser-polyfill';
import type { NetworkType } from '../shared/constants';
import { Transaction } from '../lib/transaction';
import { bytesToHex, hexToBytes } from '../lib/hex';

const MAGIC = '44495641'; // "DIVA"
const OP = { ISSUE: 1, TRANSFER: 2, CERTIFY: 3, BURN: 4, REVOKE: 5 };
const CACHE_LIMIT = 5000;
const CONCURRENCY = 8;

// The data of `OP_META <one push>`, or null for any other shape
function opMetaPush(script: Uint8Array): Uint8Array | null {
  if (script.length < 1 || script[0] !== 0x6a) return null;
  let i = 1;
  const op = script[i++];
  let len: number | undefined;
  if (op > 0 && op < 0x4c) len = op;
  else if (op === 0x4c) len = script[i++];
  else if (op === 0x4d) { len = script[i] | (script[i + 1] << 8); i += 2; }
  else return null;
  if (len === undefined || Number.isNaN(len) || i + len !== script.length) return null;
  return script.slice(i, i + len);
}

// CompactSize reader over a payload; throws on truncation or a non-minimal varint
function reader(b: Uint8Array) {
  let pos = 0;
  const take = (n: number): Uint8Array => {
    if (pos + n > b.length) throw new Error('truncated');
    const out = b.slice(pos, pos + n);
    pos += n;
    return out;
  };
  const u8 = (): number => take(1)[0];
  const varint = (): number => {
    const first = u8();
    if (first < 0xfd) return first;
    const w = first === 0xfd ? 2 : first === 0xfe ? 4 : 8;
    const x = take(w);
    let v = 0;
    for (let k = w - 1; k >= 0; k--) v = v * 256 + x[k];
    if (v < (w === 2 ? 0xfd : w === 4 ? 0x10000 : 0x100000000)) throw new Error('non-minimal varint');
    if (!Number.isSafeInteger(v)) throw new Error('varint too large');
    return v;
  };
  return { take, u8, varint, end: () => { if (pos !== b.length) throw new Error('trailing bytes'); } };
}

// Output indexes a DT/1 payload colors. Throws on anything the standard rejects.
function payloadVouts(payload: Uint8Array): number[] {
  const r = reader(payload);
  r.take(4); // magic, already matched
  if (r.u8() !== 1) throw new Error('unsupported version');
  const op = r.u8();
  const vouts: number[] = [];
  switch (op) {
    case OP.ISSUE: {
      const kind = r.u8();
      if (kind > 1) throw new Error('bad kind');
      const flags = r.u8();
      if (flags & ~3) throw new Error('unknown flags');
      r.varint(); // supply
      vouts.push(r.varint());
      r.take(32); // content hash
      r.take(r.varint()); // metadata CID
      if (flags & 1) { r.take(32); vouts.push(r.varint()); } // collection token
      if (flags & 2) r.take(22); // royalty bps + pkh
      break;
    }
    case OP.TRANSFER: {
      const groups = r.varint();
      if (groups === 0) throw new Error('empty transfer');
      for (let g = 0; g < groups; g++) {
        r.take(32); // asset id
        const outs = r.varint();
        if (outs === 0) throw new Error('empty transfer group');
        for (let o = 0; o < outs; o++) { vouts.push(r.varint()); r.varint(); }
      }
      break;
    }
    case OP.CERTIFY:
      r.take(32);
      r.take(r.varint());
      r.take(5); // provider, checkedAt
      vouts.push(r.varint());
      break;
    case OP.BURN:
      r.take(32);
      r.varint();
      break;
    case OP.REVOKE:
      r.take(33);
      break;
    default:
      throw new Error('unknown op');
  }
  r.end();
  return vouts;
}

/**
 * scripts: each output's scriptPubKey hex, in order. Returns the indexes that
 * may carry an NFT ([] for an ordinary transaction).
 */
export function coloredVouts(scripts: string[]): number[] {
  const all = scripts.map((_, i) => i);
  const payloads: Uint8Array[] = [];
  for (const hex of scripts) {
    if (!/^6a/i.test(hex)) continue;
    let push: Uint8Array | null;
    try { push = opMetaPush(hexToBytes(hex)); } catch { return all; }
    if (push && push.length >= 4 && push[0] === 0x44 && push[1] === 0x49 && push[2] === 0x56 && push[3] === 0x41) {
      payloads.push(push);
    } else if (!push && hex.toLowerCase().includes(MAGIC)) {
      return all; // OP_META of an odd shape mentioning DIVA: do not guess
    }
  }
  if (payloads.length === 0) return [];
  if (payloads.length > 1) return all;
  let vouts: number[];
  try { vouts = payloadVouts(payloads[0]); } catch { return all; }
  return [...new Set(vouts)].filter(v => v < scripts.length);
}

/** Output script hexes of a parsed transaction */
export function outputScripts(tx: Transaction): string[] {
  return tx.outputs.map(o => (o.script instanceof Uint8Array ? bytesToHex(o.script) : String(o.script)).toLowerCase());
}

/** Whether output `vout` of a transaction may carry an NFT */
export function isColored(tx: Transaction, vout: number): boolean {
  return coloredVouts(outputScripts(tx)).includes(vout);
}

export type HeldReason = 'nft' | 'unknown';
export interface NftFilterResult<C> {
  spendable: C[];
  held: Array<{ coin: C; reason: HeldReason }>;
}
type Coin = { txid: string; vout?: number; outputIndex?: number };
type Entry = number[]; // [outputCount, ...coloredVouts]

// txid -> entry, per network; a transaction never changes, so a result once
// read holds for good. Loaded from storage.local on first use.
const caches = new Map<NetworkType, Promise<Map<string, Entry>>>();
const storageKey = (network: NetworkType) => `nftGuard:${network}`;

function cacheFor(network: NetworkType): Promise<Map<string, Entry>> {
  let c = caches.get(network);
  if (!c) {
    c = (async () => {
      const cache = new Map<string, Entry>();
      try {
        const k = storageKey(network);
        const saved = (await storage.local.get<Record<string, unknown>>(k))[k];
        for (const [txid, v] of Object.entries((saved as Record<string, unknown>) || {})) {
          if (/^[0-9a-f]{64}$/.test(txid) && Array.isArray(v) && v.length > 0 && v.every(Number.isInteger)) {
            cache.set(txid, v as Entry);
          }
        }
      } catch { /* unreadable cache: start empty */ }
      return cache;
    })();
    caches.set(network, c);
  }
  return c;
}

/** Forget the in-memory caches (tests; a restarted worker starts this way) */
export function resetNftGuardMemory(): void {
  caches.clear();
}

/**
 * Split coins into those a send may spend and those it must not.
 * fetchRawTx(txid): the raw transaction hex; it must hash to txid or the coin
 * is held as unknown.
 */
export async function filterNftCoins<C extends Coin>(
  network: NetworkType,
  coins: C[],
  fetchRawTx: (txid: string) => Promise<string>,
): Promise<NftFilterResult<C>> {
  const cache = await cacheFor(network);
  const txids = [...new Set(coins.map(c => c.txid.toLowerCase()))];
  const found = new Map<string, Entry | null>();
  let added = false;
  let next = 0;
  async function lookup(txid: string): Promise<Entry> {
    const hit = cache.get(txid);
    if (hit) return hit;
    const tx = Transaction.fromHex(await fetchRawTx(txid));
    if (tx.txid() !== txid) throw new Error('not the transaction asked for');
    const scripts = outputScripts(tx);
    const entry = [scripts.length, ...coloredVouts(scripts)];
    cache.set(txid, entry);
    added = true;
    return entry;
  }
  async function worker(): Promise<void> {
    while (next < txids.length) {
      const txid = txids[next++];
      try { found.set(txid, await lookup(txid)); } catch { found.set(txid, null); }
    }
  }
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, txids.length) }, worker));
  if (added) {
    while (cache.size > CACHE_LIMIT) cache.delete(cache.keys().next().value as string);
    try { await storage.local.set({ [storageKey(network)]: Object.fromEntries(cache) }); } catch { /* full */ }
  }

  const spendable: C[] = [];
  const held: Array<{ coin: C; reason: HeldReason }> = [];
  for (const coin of coins) {
    const vout = coin.outputIndex !== undefined ? coin.outputIndex : coin.vout;
    const entry = found.get(coin.txid.toLowerCase());
    if (!entry || !Number.isInteger(vout) || (vout as number) < 0 || (vout as number) >= entry[0]) {
      held.push({ coin, reason: 'unknown' });
    } else if (entry.indexOf(vout as number, 1) > 0) held.push({ coin, reason: 'nft' });
    else spendable.push(coin);
  }
  return { spendable, held };
}
