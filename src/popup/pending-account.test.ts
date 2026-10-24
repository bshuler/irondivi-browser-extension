import { beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { savePending, pendingState, unlockPending, clearPending, PENDING_ACCOUNT_KEY } from './pending-account';

// Regression tests for the security review's M3: a wallet being created kept
// its recovery phrase and password in plain text in session storage

vi.setConfig({ testTimeout: 30000 });

const MNEMONIC = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
const PASSWORD = 'correct horse battery staple';

let session: Record<string, any>;

beforeEach(() => {
  session = {};
  (globalThis as any).chrome = {
    storage: {
      session: {
        get: async (k: string) => (k in session ? { [k]: structuredClone(session[k]) } : {}),
        set: async (items: Record<string, any>) => { Object.assign(session, structuredClone(items)); },
        remove: async (k: string) => { delete session[k]; },
      },
    },
  };
});

describe('M3 a wallet being created is kept encrypted', () => {
  it('session storage holds neither the phrase nor the password', async () => {
    await savePending('Main', MNEMONIC, PASSWORD);
    const stored = JSON.stringify(session);
    expect(stored).not.toContain('abandon');
    expect(stored).not.toContain(PASSWORD);
    expect(Object.keys(session[PENDING_ACCOUNT_KEY]).sort()).toEqual(['name', 'vault']);
    expect(await pendingState()).toEqual({ kind: 'encrypted', name: 'Main' });
  });

  it('the right password gets the phrase back', async () => {
    await savePending('Main', MNEMONIC, PASSWORD);
    expect(await unlockPending(PASSWORD)).toEqual({ name: 'Main', mnemonic: MNEMONIC });
  });

  it('a wrong password gets nothing, and the setup is kept for a retry', async () => {
    await savePending('Main', MNEMONIC, PASSWORD);
    expect(await unlockPending('wrong')).toBeNull();
    expect(await pendingState()).toEqual({ kind: 'encrypted', name: 'Main' });
  });

  it('a plain-text record from an earlier version is reported as legacy and never unlocked', async () => {
    session[PENDING_ACCOUNT_KEY] = { name: 'Old', password: PASSWORD, mnemonic: MNEMONIC };
    expect(await pendingState()).toEqual({ kind: 'legacy' });
    expect(await unlockPending(PASSWORD)).toBeNull();
    await clearPending();
    expect(session[PENDING_ACCOUNT_KEY]).toBeUndefined();
  });

  it('nothing pending reads as none', async () => {
    expect(await pendingState()).toEqual({ kind: 'none' });
  });

  it('the popup no longer stores a phrase or password itself', () => {
    const src = readFileSync(new URL('./account-ui.ts', import.meta.url), 'utf8');
    expect(src).not.toMatch(/storage\.session|PendingAccount\s*\{|savePendingAccount|getPendingAccount/);
    expect(src).not.toMatch(/savePending\([^)]*\{/);
  });

  it('an approval window never resumes a wallet setup', () => {
    const src = readFileSync(new URL('./popup.ts', import.meta.url), 'utf8');
    const approval = src.indexOf('const approvalParams = checkApprovalParams()');
    const resume = src.indexOf('await checkPendingAccountCreation()');
    expect(approval).toBeGreaterThan(-1);
    expect(resume).toBeGreaterThan(approval);
    expect(src.slice(approval, resume)).toMatch(/if \(!approvalParams\)/);
  });
});
