/**
 * Transactions this wallet sent or asked the faucet for, remembered per network
 * until they confirm. The address index only lists mined transactions, so these
 * txids (plus the node's mempool) let the history show them straight away.
 */

import { storage } from '../shared/browser-polyfill';
import type { NetworkType } from '../shared/constants';

const KEY = 'pendingTxs';
// Forget a txid that never confirmed after this long (dropped from the mempool).
const MAX_AGE_MS = 24 * 60 * 60 * 1000;

interface PendingTx {
  txid: string;
  addedAt: number;
  // The coins it spends, as "txid:vout". The node still lists them as unspent
  // until it is mined, so they are left out of the next send (EXT-27)
  spends?: string[];
}

type PendingTxs = Partial<Record<NetworkType, PendingTx[]>>;

async function load(): Promise<PendingTxs> {
  const result = await storage.local.get<{ [KEY]: PendingTxs }>(KEY);
  return result[KEY] || {};
}

export async function addPendingTx(
  network: NetworkType,
  txid: string,
  spends: Array<{ txid: string; vout: number }> = [],
): Promise<void> {
  const all = await load();
  const list = (all[network] || []).filter(p => p.txid !== txid);
  const entry: PendingTx = { txid, addedAt: Date.now() };
  if (spends.length) entry.spends = spends.map(outpoint);
  list.push(entry);
  all[network] = list;
  await storage.local.set({ [KEY]: all });
}

export async function getPendingTxids(network: NetworkType): Promise<string[]> {
  const all = await load();
  return (all[network] || []).map(p => p.txid);
}

export function outpoint(coin: { txid: string; vout: number }): string {
  return `${coin.txid.toLowerCase()}:${coin.vout}`;
}

/**
 * The coins spent by this wallet's sends that are not yet mined
 */
export async function getPendingSpends(network: NetworkType): Promise<Set<string>> {
  const all = await load();
  const now = Date.now();
  return new Set((all[network] || [])
    .filter(p => now - p.addedAt < MAX_AGE_MS)
    .flatMap(p => p.spends ?? []));
}

/**
 * Drop txids that have been mined (the address index lists them now) or are too old.
 */
export async function prunePendingTxs(network: NetworkType, confirmed: Set<string>): Promise<void> {
  const all = await load();
  const list = all[network];
  if (!list?.length) return;
  const now = Date.now();
  const kept = list.filter(p => !confirmed.has(p.txid) && now - p.addedAt < MAX_AGE_MS);
  if (kept.length === list.length) return;
  all[network] = kept;
  await storage.local.set({ [KEY]: all });
}
