/**
 * What each account has sent in the last 24 hours, per network, so the daily
 * transaction limits can be enforced. Kept in local storage so closing the
 * browser or restarting the service worker does not reset it.
 */

import { storage } from '../shared/browser-polyfill';
import type { NetworkType } from '../shared/constants';

const WINDOW_MS = 24 * 60 * 60 * 1000;

interface Spend {
  time: number;
  sats: string; // bigint as a decimal string; storage cannot hold a bigint
}

function key(accountId: string, network: NetworkType): string {
  return `spendLedger:${accountId}:${network}`;
}

async function load(accountId: string, network: NetworkType): Promise<Spend[]> {
  const k = key(accountId, network);
  const result = await storage.local.get<Record<string, Spend[]>>(k);
  const list = result[k];
  if (!Array.isArray(list)) return [];
  const now = Date.now();
  return list.filter(s =>
    s && typeof s.time === 'number' && now - s.time < WINDOW_MS && now >= s.time &&
    typeof s.sats === 'string' && /^\d+$/.test(s.sats));
}

/**
 * Satoshis sent (amount plus fee) by this account on this network in the last 24 hours
 */
export async function spentToday(accountId: string, network: NetworkType): Promise<bigint> {
  const list = await load(accountId, network);
  return list.reduce((sum, s) => sum + BigInt(s.sats), 0n);
}

export async function recordSpend(accountId: string, network: NetworkType, sats: bigint): Promise<void> {
  const list = await load(accountId, network);
  list.push({ time: Date.now(), sats: sats.toString() });
  await storage.local.set({ [key(accountId, network)]: list });
}
