import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createHarness, TEST_PASSWORD, type Harness } from '../test-support/harness';

// Regression tests for the security review's EXT-26: the session kept the
// phrase and turned it into a new string, which cannot be wiped, on every
// signature and send

vi.setConfig({ testTimeout: 30000 });

let h: Harness;
let account: any;

beforeEach(async () => {
  vi.resetModules();
  h = await createHarness();
  account = await h.setupWallet();
});

describe('EXT-26 the session holds the seed, not the phrase', () => {
  it('signing and sending do not turn a phrase into text again', async () => {
    const { signingSession } = await import('./signing-session');
    const { Mnemonic } = await import('../lib/mnemonic');
    expect(await signingSession.isAuthenticated(account.id)).toBe(true);
    const toSeed = vi.spyOn(Mnemonic, 'toSeed');
    await signingSession.signMessage('hello', 0, 'testnet', account.id);
    const seed = await signingSession.getSeed();
    expect(seed).toBeInstanceOf(Uint8Array);
    expect(seed).toHaveLength(64);
    expect(toSeed).not.toHaveBeenCalled();
  });

  it('nothing in the session is a string or a SecureString', async () => {
    const { signingSession } = await import('./signing-session');
    const { SecureString } = await import('../shared/crypto-utils');
    for (const [key, value] of Object.entries(signingSession)) {
      if (key === 'currentAccountId') continue;
      expect(typeof value).not.toBe('string');
      expect(value).not.toBeInstanceOf(SecureString);
    }
  });

  it('getSeed hands out a copy, and locking zeroes the seed held', async () => {
    const { signingSession } = await import('./signing-session');
    const copy = (await signingSession.getSeed())!;
    copy.fill(0);
    const again = (await signingSession.getSeed())!;
    expect(again.some(b => b !== 0)).toBe(true);
    const held = (signingSession as any).seed as Uint8Array;
    await signingSession.clearSession();
    expect(held.every(b => b === 0)).toBe(true);
    expect(await signingSession.getSeed()).toBeNull();
  });

  it('a signature made from the held seed is the one the phrase gives', async () => {
    const { signingSession } = await import('./signing-session');
    const before = await signingSession.signMessage('hello', 0, 'testnet', account.id);
    await signingSession.clearSession();
    expect((await h.popup('AUTHENTICATE', { accountId: account.id, password: TEST_PASSWORD })).success).toBe(true);
    expect(await signingSession.signMessage('hello', 0, 'testnet', account.id)).toBe(before);
  });
});
