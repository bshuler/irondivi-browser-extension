import { beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { createHarness, TEST_MNEMONIC, TEST_PASSWORD, type Harness } from '../test-support/harness';

// Regression tests for the security review's L10: the wrong-password count
// lived in session storage, so restarting the browser reset it, and exporting
// the phrase, deleting the account and deriving addresses never counted at all

vi.setConfig({ testTimeout: 60000 });

const WRONG = 'wrong-password-1';

let h: Harness;
let accountId: string;

beforeEach(async () => {
  vi.resetModules();
  h = await createHarness();
  accountId = (await h.setupWallet()).id;
});

const auth = (password: string) => h.popup('AUTHENTICATE', { accountId, password });

async function failTimes(n: number) {
  for (let i = 0; i < n; i++) {
    const r = await auth(WRONG);
    expect(r.success).toBe(false);
  }
}

describe('L10 the lockout is kept across restarts', () => {
  it('five wrong passwords lock the account, even against the right one', async () => {
    await failTimes(5);
    const r = await auth(TEST_PASSWORD);
    expect(r.success).toBe(false);
    expect(r.error).toMatch(/Account locked/);
  });

  it('the count is in local storage, not session storage', async () => {
    await failTimes(2);
    expect(h.storage.rate_limit_state[accountId].count).toBe(2);
    expect(h.sessionStorage.rate_limit_state).toBeUndefined();
  });

  it('the lock survives a worker restart with session storage cleared', async () => {
    await failTimes(5);
    for (const k of Object.keys(h.sessionStorage)) delete h.sessionStorage[k];
    await h.restartWorker();
    const r = await auth(TEST_PASSWORD);
    expect(r.error).toMatch(/Account locked/);
  });

  it('a partial count survives a restart too', async () => {
    await failTimes(4);
    await h.restartWorker();
    await failTimes(1);
    expect((await auth(TEST_PASSWORD)).error).toMatch(/Account locked/);
  });

  it('after a lockout runs out the next one is longer', async () => {
    await failTimes(5);
    const first = h.storage.rate_limit_state[accountId];
    expect(first.lockedUntil - Date.now()).toBeLessThanOrEqual(5 * 60 * 1000);
    first.lockedUntil = Date.now() - 1;
    await failTimes(5);
    const second = h.storage.rate_limit_state[accountId];
    expect(second.lockedUntil - Date.now()).toBeGreaterThan(14 * 60 * 1000);
  });

  it('the right password clears the count but keeps an earned tier', async () => {
    await failTimes(5);
    h.storage.rate_limit_state[accountId].lockedUntil = Date.now() - 1;
    expect((await auth(TEST_PASSWORD)).success).toBe(true);
    const entry = h.storage.rate_limit_state[accountId];
    expect(entry.count).toBe(0);
    expect(entry.lockoutTier).toBe(1);
  });

  it('a right password with no earlier lockout leaves nothing stored', async () => {
    await failTimes(2);
    expect((await auth(TEST_PASSWORD)).success).toBe(true);
    expect(h.storage.rate_limit_state[accountId]).toBeUndefined();
  });

  it('a count left in session storage by 0.0.3 is carried over', async () => {
    h.sessionStorage.rate_limit_state = { [accountId]: { count: 4, lockedUntil: 0, lockoutTier: 0 } };
    await failTimes(1);
    expect((await auth(TEST_PASSWORD)).error).toMatch(/Account locked/);
    expect(h.sessionStorage.rate_limit_state).toBeUndefined();
  });

  it('a lockout set far in the future is cut to the longest lockout', async () => {
    h.storage.rate_limit_state = { [accountId]: { count: 5, lockedUntil: Date.now() + 365 * 86400000, lockoutTier: 3, lastFailureAt: Date.now() } };
    const r = await auth(TEST_PASSWORD);
    const seconds = Number(/(\d+) seconds/.exec(r.error)![1]);
    expect(seconds).toBeLessThanOrEqual(24 * 3600);
  });

  it('an unknown account id is not counted', async () => {
    for (const id of ['no-such-account', '__proto__', 'constructor']) {
      const r = await h.popup('AUTHENTICATE', { accountId: id, password: WRONG });
      expect(r.success).toBe(false);
    }
    expect(Object.keys(h.storage.rate_limit_state ?? {})).toEqual([]);
  });

  it('wrong passwords sent at once cannot get past five', async () => {
    const results = await Promise.all(Array.from({ length: 12 }, () => auth(WRONG)));
    expect(results.filter(r => /Account locked/.test(r.error ?? ''))).toHaveLength(7);
    expect(h.storage.rate_limit_state[accountId].count).toBe(5);
  });
});

describe('L10 every password path counts', () => {
  const paths: Array<[string, (password: string) => Promise<any>]> = [
    ['EXPORT_MNEMONIC', password => h.popup('EXPORT_MNEMONIC', { accountId, password })],
    ['DELETE_ACCOUNT', password => h.popup('DELETE_ACCOUNT', { accountId, password })],
    ['GENERATE_NEW_ADDRESS', password => h.popup('GENERATE_NEW_ADDRESS', { accountId, password })],
  ];

  for (const [type, call] of paths) {
    it(`wrong passwords to ${type} lock the account`, async () => {
      for (let i = 0; i < 5; i++) expect((await call(WRONG)).success).toBe(false);
      expect((await auth(TEST_PASSWORD)).error).toMatch(/Account locked/);
    });

    it(`${type} is refused while locked, even with the right password`, async () => {
      await failTimes(5);
      const r = await call(TEST_PASSWORD);
      expect(r.success).toBe(false);
      expect(r.error).toMatch(/Account locked/);
      expect(Object.hasOwn(h.storage.secrets, accountId)).toBe(true);
    });
  }

  it('the phrase is still exported with the right password', async () => {
    const r = await h.popup('EXPORT_MNEMONIC', { accountId, password: TEST_PASSWORD });
    expect(r.data.mnemonic).toBe(TEST_MNEMONIC);
  });

  it('only unlock-limit.ts decrypts a secret', () => {
    for (const file of ['account-manager.ts', 'signing-session.ts', 'service-worker.ts']) {
      const src = readFileSync(new URL(`./${file}`, import.meta.url), 'utf8')
        .replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
      expect(src, file).not.toMatch(/getDecryptedSecret/);
    }
  });
});
