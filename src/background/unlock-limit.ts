import { storage } from '../shared/browser-polyfill';
import { getDecryptedSecret, getSecrets } from '../shared/storage';

/**
 * The limit on wrong passwords. Every way of opening an account's phrase with
 * a password goes through unlockSecret, so unlocking, signing, exporting the
 * phrase, deleting the account and deriving addresses all count towards the
 * same lockout. The count is kept in local storage, so restarting the browser
 * or the worker does not reset it.
 */

interface RateLimitEntry {
  count: number;
  lockedUntil: number;
  // Which lockout duration the next lockout uses (0-3)
  lockoutTier: number;
  lastFailureAt: number;
}

const RATE_LIMIT_STATE_KEY = 'rate_limit_state';

export const MAX_ATTEMPTS = 5;
// Exponential backoff lockout durations (5 min, 15 min, 1 hour, 24 hours)
export const LOCKOUT_DURATIONS_MS = [
  5 * 60 * 1000,
  15 * 60 * 1000,
  60 * 60 * 1000,
  24 * 60 * 60 * 1000,
];
// Failures and the tier they earned are forgotten this long after the last
// wrong password, so a correct password alone does not reset the backoff
export const FAILURE_MEMORY_MS = 24 * 60 * 60 * 1000;

// Attempts run one after another. Otherwise many wrong passwords sent at once
// would all pass the check before the first of them was counted.
let queue: Promise<unknown> = Promise.resolve();

function oneAtATime<T>(fn: () => Promise<T>): Promise<T> {
  const run = queue.then(fn, fn);
  queue = run.catch(() => {});
  return run;
}

function isEntry(v: unknown): v is RateLimitEntry {
  const e = v as RateLimitEntry;
  return typeof e === 'object' && e !== null
    && Number.isFinite(e.count) && Number.isFinite(e.lockedUntil) && Number.isFinite(e.lockoutTier);
}

// The stricter of two entries for one account
function stricter(a: RateLimitEntry | undefined, b: RateLimitEntry): RateLimitEntry {
  if (!a) return b;
  return {
    count: Math.max(a.count, b.count),
    lockedUntil: Math.max(a.lockedUntil, b.lockedUntil),
    lockoutTier: Math.max(a.lockoutTier, b.lockoutTier),
    lastFailureAt: Math.max(a.lastFailureAt, b.lastFailureAt),
  };
}

async function loadState(): Promise<Map<string, RateLimitEntry>> {
  const now = Date.now();
  const state = new Map<string, RateLimitEntry>();
  const add = (stored: unknown) => {
    if (typeof stored !== 'object' || stored === null) return;
    for (const [accountId, entry] of Object.entries(stored)) {
      if (!isEntry(entry)) continue;
      // Entries from before lastFailureAt was kept count from now
      const lastFailureAt = Number.isFinite(entry.lastFailureAt) ? entry.lastFailureAt : now;
      const tier = Math.min(Math.max(0, Math.floor(entry.lockoutTier)), LOCKOUT_DURATIONS_MS.length - 1);
      // A clock set back must not stretch a lockout past its own length
      const lockedUntil = Math.min(entry.lockedUntil, now + LOCKOUT_DURATIONS_MS[LOCKOUT_DURATIONS_MS.length - 1]);
      state.set(accountId, stricter(state.get(accountId), {
        count: Math.max(0, entry.count), lockedUntil, lockoutTier: tier, lastFailureAt,
      }));
    }
  };

  const local = await storage.local.get<Record<string, unknown>>(RATE_LIMIT_STATE_KEY);
  add(local[RATE_LIMIT_STATE_KEY]);
  // 0.0.3 and earlier kept the count in session storage, which the browser
  // clears when it closes
  try {
    const session = await storage.session.get<Record<string, unknown>>(RATE_LIMIT_STATE_KEY);
    if (session[RATE_LIMIT_STATE_KEY] !== undefined) {
      add(session[RATE_LIMIT_STATE_KEY]);
      await saveState(state);
      await storage.session.remove(RATE_LIMIT_STATE_KEY);
    }
  } catch {
    // No session storage: nothing to carry over
  }

  for (const [accountId, entry] of state) {
    if (entry.lockedUntil <= now && now - entry.lastFailureAt >= FAILURE_MEMORY_MS) state.delete(accountId);
  }
  return state;
}

async function saveState(state: Map<string, RateLimitEntry>): Promise<void> {
  await storage.local.set({ [RATE_LIMIT_STATE_KEY]: Object.fromEntries(state) });
}

export function isLockedError(error: unknown): boolean {
  return error instanceof Error && error.message.startsWith('Account locked');
}

/**
 * Decrypt an account's phrase, counting a wrong password towards the lockout.
 * Throws "Account locked. Try again in N seconds." while the account is
 * locked, without trying the password.
 */
export function unlockSecret(accountId: string, password: string): Promise<string> {
  return oneAtATime(async () => {
    // Only real accounts are counted, so made-up ids cannot fill storage
    if (typeof accountId !== 'string' || !Object.hasOwn(await getSecrets(), accountId)) {
      throw new Error('Account not found');
    }

    const state = await loadState();
    const entry = state.get(accountId);
    const now = Date.now();
    if (entry && now < entry.lockedUntil) {
      throw new Error(`Account locked. Try again in ${Math.ceil((entry.lockedUntil - now) / 1000)} seconds.`);
    }
    // A lockout that has run out starts a fresh count, at the next tier
    if (entry && entry.count >= MAX_ATTEMPTS) entry.count = 0;

    let mnemonic: string;
    try {
      mnemonic = await getDecryptedSecret(accountId, password);
    } catch (error) {
      const failed = entry ?? { count: 0, lockedUntil: 0, lockoutTier: 0, lastFailureAt: now };
      failed.count++;
      failed.lastFailureAt = Date.now();
      if (failed.count >= MAX_ATTEMPTS) {
        failed.lockedUntil = Date.now() + LOCKOUT_DURATIONS_MS[failed.lockoutTier];
        failed.lockoutTier = Math.min(failed.lockoutTier + 1, LOCKOUT_DURATIONS_MS.length - 1);
      }
      state.set(accountId, failed);
      await saveState(state);
      throw error;
    }

    // The right password clears the count, but a tier already earned stays
    // until FAILURE_MEMORY_MS after the last wrong password
    if (entry && entry.lockoutTier > 0) {
      entry.count = 0;
      entry.lockedUntil = 0;
    } else {
      state.delete(accountId);
    }
    await saveState(state);
    return mnemonic;
  });
}
