import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { createHarness, TEST_MNEMONIC, TEST_PASSWORD, type Harness } from '../test-support/harness';
import { Mnemonic } from '../lib/mnemonic';
import { deriveAddresses } from '../lib/derivation';

// Regression tests for the security review's M2: the unlocked phrase was kept
// in session storage, encrypted with a key anyone could derive from a stored id

vi.setConfig({ testTimeout: 30000 });

async function foreignTestnetAddress(): Promise<string> {
  const seed = await Mnemonic.toSeed(TEST_MNEMONIC, 'other-account');
  const [a] = await deriveAddresses(seed, 'testnet', 0, 1);
  return a.address;
}

let h: Harness;
let account: any;

beforeEach(async () => {
  vi.resetModules();
  h = await createHarness();
  account = await h.setupWallet();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('M2 the unlocked wallet lives only in the background\'s memory', () => {
  it('nothing about the unlocked session is written to any storage area', () => {
    expect(Object.keys(h.sessionStorage)).not.toContain('signingSession');
    const stored = JSON.stringify({ local: h.storage, session: h.sessionStorage });
    expect(stored).not.toMatch(/wrappedKey|"encrypted"\s*:\s*"[^"]*"\s*,\s*"iv"[^}]*"expiresAt"/);
    expect(Object.keys(h.storage)).not.toContain('installation_id');
  });

  it('an unlock removes what earlier versions stored', async () => {
    h.sessionStorage.signingSession = { accountId: 'x', encrypted: 'e', iv: 'i', expiresAt: 1, wrappedKey: 'w' };
    h.storage.installation_id = 'old';
    const r = await h.popup('AUTHENTICATE', { accountId: account.id, password: TEST_PASSWORD });
    expect(r.success).toBe(true);
    expect(h.sessionStorage.signingSession).toBeUndefined();
    expect(h.storage.installation_id).toBeUndefined();
  });

  it('after the browser restarts the service worker, the popup cannot send without a new unlock', async () => {
    const to = await foreignTestnetAddress();
    expect((await h.popup('SEND_TRANSACTION', { to, amount: 1 })).success).toBe(true);
    await h.restartWorker();
    const r = await h.popup('SEND_TRANSACTION', { to, amount: 1 });
    expect(r.success).toBe(false);
    expect(r.error).toMatch(/not authenticated/i);
    expect(h.broadcasts).toHaveLength(1);
  });

  it('the session ends at its timeout even if the alarm never fires', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(Date.now() + 6 * 60 * 1000); // default timeout is 5 minutes
    const r = await h.popup('SIGN_MESSAGE', { message: 'hello', accountId: account.id, addressIndex: 0 });
    expect(r.success).toBe(false);
    expect(r.error).toMatch(/not authenticated/i);
  });

  it('within the timeout the popup can still sign', async () => {
    const r = await h.popup('SIGN_MESSAGE', { message: 'hello', accountId: account.id, addressIndex: 0 });
    expect(r.success).toBe(true);
    expect(r.data.signature).toBeTruthy();
  });

  it('the signing session has no code that stores or wraps the phrase', () => {
    const src = readFileSync(new URL('./signing-session.ts', import.meta.url), 'utf8');
    expect(src).not.toMatch(/wrapSessionKey|unwrapSessionKey|encryptWithKey|set\(\{\s*(signingSession|\[LEGACY)/);
  });
});
