import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createHarness, TEST_PASSWORD } from '../test-support/harness';
import { DEFAULT_SITES, emptyAccess, siteMatchPatterns, withChoice } from '../shared/site-access';
import { ERR } from '../shared/provider-errors';

const CONTENT_SCRIPT_ID = 'irondivi-content';
const PROVIDER_SCRIPT_ID = 'irondivi-provider';

// The wallet's scripts run on every https page the browser has granted, so a
// site off the default list can find window.irondivi to ask with
// requestAccess. Such a page is told its status and nothing else.

beforeEach(() => { vi.resetModules(); });
afterEach(() => { vi.restoreAllMocks(); });

describe('siteMatchPatterns', () => {
  it('is every https page and the default sites, and adds the local hosts in a development build', () => {
    const release = siteMatchPatterns(emptyAccess(), false);
    expect(release[0]).toBe('https://*/*');
    expect(release).toEqual(['https://*/*', ...DEFAULT_SITES.map(o => `${o}/*`)]);
    expect(siteMatchPatterns(emptyAccess(), true)).toEqual([...release, 'http://localhost/*', 'http://127.0.0.1/*']);
  });

  it('keeps a site the user allowed, so it still works if every-site access is withheld', () => {
    const access = withChoice(emptyAccess(), 'https://shop.example', 'testnet', 'allowed', 1);
    expect(siteMatchPatterns(access, false)).toContain('https://shop.example/*');
    const denied = withChoice(emptyAccess(), 'https://shop.example', 'testnet', 'denied', 1);
    expect(siteMatchPatterns(denied, false)).not.toContain('https://shop.example/*');
  });
});

describe('the background registers the scripts', () => {
  it('registers the content script and the provider, in the page world, for every https page', async () => {
    const h = await createHarness();
    const ids = h.registeredScripts.map(s => s.id).sort();
    expect(ids).toEqual([CONTENT_SCRIPT_ID, PROVIDER_SCRIPT_ID].sort());
    const provider = h.registeredScripts.find(s => s.id === PROVIDER_SCRIPT_ID);
    expect(provider.world).toBe('MAIN');
    expect(provider.js).toEqual(['provider.js']);
    expect(provider.runAt).toBe('document_start');
    for (const s of h.registeredScripts) expect(s.matches[0]).toBe('https://*/*');
  });

  it('example.com finds window.irondivi, but is told only that it is not allowed', async () => {
    const h = await createHarness('https://example.com/');
    await h.setupWallet();
    const windows = h.createdWindows.length;
    expect(await h.provider().getAccessStatus()).toBe('not_allowed');
    await expect(h.provider().connect()).rejects.toMatchObject({ code: ERR.ACCESS_REQUIRED });
    await expect(h.provider().getAccounts()).rejects.toMatchObject({ code: ERR.ACCESS_REQUIRED });
    await expect(h.provider().getBalance()).rejects.toMatchObject({ code: ERR.ACCESS_REQUIRED });
    expect(h.createdWindows).toHaveLength(windows);
  });

  it('when the user withholds every-site access, only the granted default sites are registered', async () => {
    const h = await createHarness('https://example.org/', { withheldOrigins: ['https://*/*'] });
    for (const s of h.registeredScripts) expect(s.matches).toEqual(['https://games.divi.domains/*', 'https://services.divi.domains/*']);
    expect(h.provider()).toBeUndefined();
    vi.resetModules();
    const game = await createHarness('https://games.divi.domains/', { withheldOrigins: ['https://*/*'] });
    expect(game.provider()).toBeDefined();
  });

  it('a change of site access in Settings registers the scripts again', async () => {
    const h = await createHarness();
    await h.setupWallet();
    const register = vi.spyOn((globalThis as any).chrome.scripting, 'registerContentScripts');
    expect((await h.popup('SET_SITE_ACCESS', { origin: 'https://shop.example', action: 'block', password: TEST_PASSWORD })).success).toBe(true);
    await vi.waitFor(() => expect(register).toHaveBeenCalled());
    expect(h.registeredScripts).toHaveLength(2);
  });
});

describe('EXT-3 a failure to restrict local storage is not hidden', () => {
  it('warns when the browser cannot keep content scripts out of local storage', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await createHarness();
    expect(warn.mock.calls.some(c => String(c[0]).includes('cannot keep content scripts out of local storage'))).toBe(true);
  });
});
