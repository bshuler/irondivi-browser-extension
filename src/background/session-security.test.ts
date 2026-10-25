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

  it('after the browser restarts the service worker, the phrase is gone from memory', async () => {
    expect(await h.isAuthenticated(account.id)).toBe(true);
    await h.restartWorker();
    expect(await h.isAuthenticated(account.id)).toBe(false);
  });

  it('the session ends at its timeout even if the alarm never fires', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(Date.now() + 6 * 60 * 1000); // default timeout is 5 minutes
    expect(await h.isAuthenticated(account.id)).toBe(false);
  });

  it('within the timeout the popup can still sign, with the password', async () => {
    const r = await h.popup('SIGN_MESSAGE', { password: TEST_PASSWORD, message: 'hello', accountId: account.id, addressIndex: 0 });
    expect(r.success).toBe(true);
    expect(r.data.signature).toBeTruthy();
  });
});

describe('EXT-2 every send and signature from the popup needs the password', () => {
  it('a send without the password is refused while the session is open', async () => {
    expect(await h.isAuthenticated(account.id)).toBe(true);
    const r = await h.popup('SEND_TRANSACTION', { to: await foreignTestnetAddress(), amount: 1 });
    expect(r.success).toBe(false);
    expect(r.error).toMatch(/password/i);
    expect(h.broadcasts).toHaveLength(0);
  });

  it('a send with a wrong password is refused and counts as a failed unlock', async () => {
    const r = await h.popup('SEND_TRANSACTION', { password: 'wrong-password-1', to: await foreignTestnetAddress(), amount: 1 });
    expect(r.success).toBe(false);
    expect(h.broadcasts).toHaveLength(0);
    expect(h.storage.rate_limit_state).toBeTruthy();
  });

  it('a signature without the password is refused while the session is open', async () => {
    const r = await h.popup('SIGN_MESSAGE', { message: 'hello', accountId: account.id, addressIndex: 0 });
    expect(r.success).toBe(false);
    expect(r.error).toMatch(/password/i);
  });

  it('the popup sends the password with each send, not a separate unlock', () => {
    const src = readFileSync(new URL('../popup/send-ui.ts', import.meta.url), 'utf8');
    expect(src).not.toMatch(/MSG\.AUTHENTICATE/);
    expect(src).toMatch(/SEND_TRANSACTION, \{\s*password,/);
  });
});

describe('EXT-2 the wallet locks when its windows close or the screen locks', () => {
  it('locks when the last wallet window closes, not before', async () => {
    const popup = h.openUiPort();
    const approval = h.openUiPort(`chrome-extension://testextensionid/popup.html?approve=connect&requestId=x`);
    expect(await h.isAuthenticated(account.id)).toBe(true);
    popup.disconnect();
    expect(await h.isAuthenticated(account.id)).toBe(true);
    approval.disconnect();
    expect(await h.isAuthenticated(account.id)).toBe(false);
  });

  it('ignores a port from a web page', async () => {
    const page = h.openUiPort('https://evil.example/');
    page.disconnect();
    // A page's port never counted as a wallet window, so closing it locks nothing
    expect(await h.isAuthenticated(account.id)).toBe(true);
  });

  it('locks when the screen locks', async () => {
    h.setIdleState('idle');
    expect(await h.isAuthenticated(account.id)).toBe(true);
    h.setIdleState('locked');
    expect(await h.isAuthenticated(account.id)).toBe(false);
  });

  it('asks for the idle permission and the popup holds the port', () => {
    const manifest = JSON.parse(readFileSync('manifest.json', 'utf8'));
    expect(manifest.permissions).toContain('idle');
    expect(readFileSync('src/popup/popup.ts', 'utf8')).toMatch(/runtime\.connect\(\{ name: UI_PORT \}\)/);
  });
});

describe('M2 (code)', () => {
  it('the signing session has no code that stores or wraps the phrase', () => {
    const src = readFileSync(new URL('./signing-session.ts', import.meta.url), 'utf8');
    expect(src).not.toMatch(/wrapSessionKey|unwrapSessionKey|encryptWithKey|set\(\{\s*(signingSession|\[LEGACY)/);
  });
});
