/**
 * The largest balance the wallet has seen for each account in the last week,
 * per network. The percentage limits are measured against the larger of this
 * and what the node reports now, so a node that hides coins cannot shrink the
 * limits until nothing can be sent. A node that reports more than there is
 * still loosens them; the absolute limits are the control for that.
 */

import { storage } from '../shared/browser-polyfill';
import type { NetworkType } from '../shared/constants';

const WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

interface Seen {
  time: number;
  sats: string; // bigint as a decimal string
}

function key(accountId: string, network: NetworkType): string {
  return `balanceRecord:${accountId}:${network}`;
}

async function load(accountId: string, network: NetworkType): Promise<Seen[]> {
  const k = key(accountId, network);
  const list = (await storage.local.get<Record<string, Seen[]>>(k))[k];
  if (!Array.isArray(list)) return [];
  const now = Date.now();
  return list.filter(s =>
    s && typeof s.time === 'number' && now - s.time < WINDOW_MS && now >= s.time &&
    typeof s.sats === 'string' && /^\d{1,30}$/.test(s.sats));
}

/** The largest balance seen in the last week, or 0n */
export async function highWaterBalance(accountId: string, network: NetworkType): Promise<bigint> {
  const list = await load(accountId, network);
  return list.reduce((max, s) => (BigInt(s.sats) > max ? BigInt(s.sats) : max), 0n);
}

/** Note a balance the node reported. One entry a day is kept: that day's largest. */
export async function recordBalance(accountId: string, network: NetworkType, sats: bigint): Promise<void> {
  if (sats <= 0n) return;
  const list = await load(accountId, network);
  const day = Math.floor(Date.now() / 86_400_000);
  const today = list.find(s => Math.floor(s.time / 86_400_000) === day);
  if (today) {
    if (BigInt(today.sats) >= sats) return;
    today.sats = sats.toString();
  } else {
    list.push({ time: Date.now(), sats: sats.toString() });
  }
  await storage.local.set({ [key(accountId, network)]: list });
}
