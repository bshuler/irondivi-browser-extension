/**
 * What UPDATE_SETTINGS accepts, and which changes loosen a protection and so
 * need the wallet's password: allowing a new site, raising or removing a
 * transaction limit, or keeping the wallet unlocked longer. The background
 * enforces it; the popup uses the same rule to know when to ask.
 */

import { NETWORKS } from './constants';
import { checkSitePatterns } from './origin';
import type { Settings, TransactionLimits } from './storage';

const LIMIT_KEYS: (keyof TransactionLimits)[] = [
  'maxAmountAbsolute', 'maxAmountPercent', 'dailyLimitAbsolute', 'dailyLimitPercent',
];
const PERCENT_KEYS = new Set<keyof TransactionLimits>(['maxAmountPercent', 'dailyLimitPercent']);
export const AUTH_TIMEOUTS = [1, 5, 15, 30];
export const MAX_SECURITY_PHRASE = 40;

export type SettingsCheck =
  | { ok: false; error: string }
  | { ok: true; updates: Partial<Settings>; loosens: boolean };

function isLimit(v: unknown, percent: boolean): v is number {
  return typeof v === 'number' && Number.isFinite(v) && v >= 0 && (!percent || v <= 100);
}

// 0 means no limit, so the loosest value; otherwise a bigger number is looser
export function looser(next: number, current: number): boolean {
  if (next === current) return false;
  if (next === 0) return true;
  return current !== 0 && next > current;
}

export function checkSettingsUpdate(raw: unknown, current: Settings): SettingsCheck {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { ok: false, error: 'Invalid settings' };
  const input = raw as Record<string, unknown>;
  const updates: Partial<Settings> = {};
  let loosens = false;

  for (const key of Object.keys(input)) {
    const value = input[key];
    switch (key) {
      case 'network':
        if (typeof value !== 'string' || !Object.prototype.hasOwnProperty.call(NETWORKS, value)) {
          return { ok: false, error: 'Unknown network' };
        }
        updates.network = value as Settings['network'];
        break;
      case 'authTimeoutMinutes':
        if (!AUTH_TIMEOUTS.includes(value as number)) return { ok: false, error: 'Invalid lock time' };
        if ((value as number) > current.authTimeoutMinutes) loosens = true;
        updates.authTimeoutMinutes = value as number;
        break;
      case 'currency':
        if (typeof value !== 'string' || !/^[A-Z]{3}$/.test(value)) return { ok: false, error: 'Invalid currency' };
        updates.currency = value;
        break;
      case 'hideBalance':
        if (typeof value !== 'boolean') return { ok: false, error: 'Invalid hide balance setting' };
        updates.hideBalance = value;
        break;
      case 'allowedSites': {
        const problem = checkSitePatterns(value);
        if (problem) return { ok: false, error: problem };
        const sites = (value as string[]).map(s => s.trim().toLowerCase());
        const known = new Set(current.allowedSites.map(s => s.trim().toLowerCase()));
        if (sites.some(s => !known.has(s))) loosens = true;
        updates.allowedSites = sites;
        break;
      }
      case 'transactionLimits': {
        if (!value || typeof value !== 'object' || Array.isArray(value)) return { ok: false, error: 'Invalid limits' };
        const v = value as Record<string, unknown>;
        if (Object.keys(v).some(k => !LIMIT_KEYS.includes(k as keyof TransactionLimits))) {
          return { ok: false, error: 'Invalid limits' };
        }
        const limits = { ...current.transactionLimits };
        for (const k of LIMIT_KEYS) {
          if (!(k in v)) continue;
          if (!isLimit(v[k], PERCENT_KEYS.has(k))) return { ok: false, error: 'Invalid limits' };
          if (looser(v[k] as number, current.transactionLimits[k])) loosens = true;
          limits[k] = v[k] as number;
        }
        updates.transactionLimits = limits;
        break;
      }
      case 'securityPhrase': {
        // Shown on every approval window (EXT-18); changing it needs the
        // password, so a page cannot learn or set it
        if (typeof value !== 'string') return { ok: false, error: 'Invalid security phrase' };
        const phrase = value.trim();
        if (phrase.length > MAX_SECURITY_PHRASE || /[\p{C}]/u.test(phrase)) {
          return { ok: false, error: `The security phrase must be plain text of ${MAX_SECURITY_PHRASE} characters at most` };
        }
        if (phrase !== (current.securityPhrase ?? '')) loosens = true;
        updates.securityPhrase = phrase;
        break;
      }
      default:
        return { ok: false, error: `Unknown setting: ${key.slice(0, 40)}` };
    }
  }
  return { ok: true, updates, loosens };
}
