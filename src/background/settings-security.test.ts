import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createHarness, TEST_PASSWORD, type Harness } from '../test-support/harness';

// Regression tests for the security review's L2: UPDATE_SETTINGS saved any
// keys and values, and loosening limits or allowed sites needed no password

vi.setConfig({ testTimeout: 30000 });

let h: Harness;

beforeEach(async () => {
  vi.resetModules();
  h = await createHarness();
  await h.setupWallet();
});

const saved = () => h.storage.settings ?? {};

describe('L2 UPDATE_SETTINGS refuses what it does not know', () => {
  it.each([
    [{ evil: 1 }, /unknown setting/i],
    [{ network: 'regtest' }, /unknown network/i],
    [{ network: '__proto__' }, /unknown network/i],
    [{ authTimeoutMinutes: 100000 }, /lock time/i],
    [{ currency: '<b>' }, /currency/i],
    [{ hideBalance: 'yes' }, /hide balance/i],
    [{ transactionLimits: { maxAmountPercent: -1 } }, /limits/i],
    [{ transactionLimits: { maxAmountPercent: 101 } }, /limits/i],
    [{ transactionLimits: { maxAmountAbsolute: Infinity } }, /limits/i],
    [{ transactionLimits: { other: 1 } }, /limits/i],
    [{ allowedSites: ['*'] }, /./],
    [{ allowedSites: 'games.divi.domains' }, /./],
  ])('%j', async (updates, error) => {
    const before = JSON.stringify(saved());
    const r = await h.popup('UPDATE_SETTINGS', { ...updates, password: TEST_PASSWORD });
    expect(r.success).toBe(false);
    expect(r.error).toMatch(error);
    expect(JSON.stringify(saved())).toBe(before);
  });
});

describe('L2 loosening a protection needs the password', () => {
  it('allowing a new site without the password is refused', async () => {
    const r = await h.popup('UPDATE_SETTINGS', { allowedSites: ['games.divi.domains', 'evil.example'] });
    expect(r.success).toBe(false);
    expect(r.error).toMatch(/password/i);
    expect(saved().allowedSites ?? []).not.toContain('evil.example');
  });

  it('a wrong password is refused', async () => {
    const r = await h.popup('UPDATE_SETTINGS', { allowedSites: ['evil.example'], password: 'wrong' });
    expect(r.success).toBe(false);
    expect(r.error).toMatch(/invalid password/i);
  });

  it('with the password the site is saved, lowercased, and the password is not', async () => {
    const r = await h.popup('UPDATE_SETTINGS', { allowedSites: ['Games.Divi.Domains', 'New.Example'], password: TEST_PASSWORD });
    expect(r.success).toBe(true);
    expect(saved().allowedSites).toEqual(['games.divi.domains', 'new.example']);
    expect(JSON.stringify(h.storage)).not.toContain(TEST_PASSWORD);
  });

  it('removing a site needs no password', async () => {
    await h.popup('UPDATE_SETTINGS', { allowedSites: ['games.divi.domains', 'a.example'], password: TEST_PASSWORD });
    const r = await h.popup('UPDATE_SETTINGS', { allowedSites: ['games.divi.domains'] });
    expect(r.success).toBe(true);
    expect(saved().allowedSites).toEqual(['games.divi.domains']);
  });

  it('lowering a limit needs no password; raising it or setting it to 0 does', async () => {
    expect((await h.popup('UPDATE_SETTINGS', { transactionLimits: { maxAmountPercent: 5 } })).success).toBe(true);
    expect(saved().transactionLimits.maxAmountPercent).toBe(5);
    expect(saved().transactionLimits.dailyLimitPercent).toBe(25);

    const raise = await h.popup('UPDATE_SETTINGS', { transactionLimits: { maxAmountPercent: 50 } });
    expect(raise.success).toBe(false);
    const off = await h.popup('UPDATE_SETTINGS', { transactionLimits: { maxAmountPercent: 0 } });
    expect(off.success).toBe(false);
    expect(saved().transactionLimits.maxAmountPercent).toBe(5);

    expect((await h.popup('UPDATE_SETTINGS', { transactionLimits: { maxAmountPercent: 0 }, password: TEST_PASSWORD })).success).toBe(true);
    expect(saved().transactionLimits.maxAmountPercent).toBe(0);
  });

  it('a longer lock time needs the password; a shorter one does not', async () => {
    expect((await h.popup('UPDATE_SETTINGS', { authTimeoutMinutes: 30 })).success).toBe(false);
    expect((await h.popup('UPDATE_SETTINGS', { authTimeoutMinutes: 1 })).success).toBe(true);
    expect((await h.popup('UPDATE_SETTINGS', { authTimeoutMinutes: 30, password: TEST_PASSWORD })).success).toBe(true);
    expect(saved().authTimeoutMinutes).toBe(30);
  });

  it('hiding the balance or changing currency needs no password', async () => {
    expect((await h.popup('UPDATE_SETTINGS', { hideBalance: true, currency: 'EUR' })).success).toBe(true);
    expect(saved().hideBalance).toBe(true);
  });

  it('a web page cannot change settings at all', async () => {
    await h.connectPage();
    const r = await h.fromTab('UPDATE_SETTINGS', { allowedSites: ['evil.example'], password: TEST_PASSWORD });
    expect(r.success).toBe(false);
  });
});

describe('L2 before there is a wallet', () => {
  it('no password is needed, as there is nothing to protect', async () => {
    vi.resetModules();
    const fresh = await createHarness();
    const r = await fresh.popup('UPDATE_SETTINGS', { allowedSites: ['games.divi.domains', 'x.example'] });
    expect(r.success).toBe(true);
  });
});

describe('L2 the rule itself', () => {
  it('a limit already off stays loose either way, and equal values loosen nothing', async () => {
    const { checkSettingsUpdate } = await import('../shared/settings-check');
    const { DEFAULT_SETTINGS } = await import('../shared/storage');
    const current = { ...DEFAULT_SETTINGS, allowedSites: ['a.example'] };
    const same = checkSettingsUpdate({ transactionLimits: { maxAmountPercent: 10 }, allowedSites: ['A.example '] }, current);
    expect(same).toMatchObject({ ok: true, loosens: false });
    const tighten = checkSettingsUpdate({ transactionLimits: { maxAmountAbsolute: 5 } }, current);
    expect(tighten).toMatchObject({ ok: true, loosens: false });
  });

  it('refuses a non-object', async () => {
    const { checkSettingsUpdate } = await import('../shared/settings-check');
    const { DEFAULT_SETTINGS } = await import('../shared/storage');
    expect(checkSettingsUpdate(null, DEFAULT_SETTINGS).ok).toBe(false);
    expect(checkSettingsUpdate([], DEFAULT_SETTINGS).ok).toBe(false);
  });
});
