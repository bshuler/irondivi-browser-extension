import { afterEach, describe, expect, it, vi } from 'vitest';
import { retryAfterUnlock, setUnlockDeps, needsUnlock } from './unlock-retry';

// EXT-3: a records change that needs the password after a browser restart
// asks for it once and is sent again

const NEEDED = { success: false, error: 'UNLOCK_NEEDED: Enter your password to save this change' };

function deps(password: string | null, authOk = true) {
  const d = {
    ask: vi.fn(async () => password),
    currentAccountId: () => 'acct-1',
    authenticate: vi.fn(async () => (authOk ? { success: true } : { success: false, error: 'Invalid password' })),
  };
  setUnlockDeps(d);
  return d;
}

afterEach(() => setUnlockDeps(null));

describe('EXT-3 the popup unlocks and retries a change that needs the password', () => {
  it('asks once, unlocks the named account and sends again', async () => {
    const d = deps('pw');
    const send = vi.fn().mockResolvedValueOnce(NEEDED).mockResolvedValueOnce({ success: true, data: 1 });
    const r = await retryAfterUnlock(send, 'acct-2');
    expect(r).toEqual({ success: true, data: 1 });
    expect(d.ask).toHaveBeenCalledWith('Enter your password to save this change');
    expect(d.authenticate).toHaveBeenCalledWith('acct-2', 'pw');
    expect(send).toHaveBeenCalledTimes(2);
  });

  it('uses the current account when none is named', async () => {
    const d = deps('pw');
    const send = vi.fn().mockResolvedValueOnce(NEEDED).mockResolvedValueOnce({ success: true });
    await retryAfterUnlock(send);
    expect(d.authenticate).toHaveBeenCalledWith('acct-1', 'pw');
  });

  it('a cancelled prompt saves nothing and does not resend', async () => {
    deps(null);
    const send = vi.fn().mockResolvedValue(NEEDED);
    const r = await retryAfterUnlock(send);
    expect(r.success).toBe(false);
    expect(send).toHaveBeenCalledTimes(1);
  });

  it('a wrong password is reported and the change is not resent', async () => {
    deps('bad', false);
    const send = vi.fn().mockResolvedValue(NEEDED);
    const r = await retryAfterUnlock(send);
    expect(r).toEqual({ success: false, error: 'Invalid password' });
    expect(send).toHaveBeenCalledTimes(1);
  });

  it('a second UNLOCK_NEEDED is returned, never a loop', async () => {
    const d = deps('pw');
    const send = vi.fn().mockResolvedValue(NEEDED);
    const r = await retryAfterUnlock(send);
    expect(needsUnlock(r)).toBe(true);
    expect(d.ask).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledTimes(2);
  });

  it('any other reply passes through untouched', async () => {
    const d = deps('pw');
    const reply = { success: false, error: 'Contact not found' };
    expect(await retryAfterUnlock(async () => reply)).toBe(reply);
    expect(d.ask).not.toHaveBeenCalled();
  });
});
