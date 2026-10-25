import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createHarness, TEST_PASSWORD } from '../test-support/harness';
import { patternsFor } from '../shared/site-patterns';

const CONTENT_SCRIPT_ID = 'irondivi-content';
const PROVIDER_SCRIPT_ID = 'irondivi-provider';

// EXT-20/21: the wallet's scripts run only on the allowed sites. Nothing is
// declared for every page; the background registers them for the allowed
// sites the browser has granted, and re-registers them when the list changes.

async function settle(ms = 50) {
  await new Promise(r => setTimeout(r, ms));
}

beforeEach(() => { vi.resetModules(); });
afterEach(() => { vi.restoreAllMocks(); });

describe('patternsFor', () => {
  it('drops ports, folds **. into *., and serves local hosts over http', () => {
    expect(patternsFor(['games.divi.domains', '**.example.org', '*.foo.test:8443', '127.0.0.1:*', 'localhost:3000']))
      .toEqual(['https://games.divi.domains/*', 'https://*.example.org/*', 'https://*.foo.test/*', 'http://127.0.0.1/*', 'http://localhost/*']);
  });

  it('leaves out anything that is not a host pattern', () => {
    expect(patternsFor(['*', 'a b.com', '.x.com', 'x.com.', 'https://x.com', 'x.com/path', 42 as any])).toEqual([]);
  });

  it('lists a host once', () => {
    expect(patternsFor(['x.com', 'x.com:443', 'X.COM'])).toEqual(['https://x.com/*']);
  });
});

describe('the background registers the scripts for allowed sites only', () => {
  it('registers the content script and the provider, in the page world, for the granted sites', async () => {
    const h = await createHarness();
    const ids = h.registeredScripts.map(s => s.id).sort();
    expect(ids).toEqual([CONTENT_SCRIPT_ID, PROVIDER_SCRIPT_ID].sort());
    const provider = h.registeredScripts.find(s => s.id === PROVIDER_SCRIPT_ID);
    expect(provider.world).toBe('MAIN');
    expect(provider.js).toEqual(['provider.js']);
    expect(provider.runAt).toBe('document_start');
    for (const s of h.registeredScripts) {
      expect(s.matches).toContain('https://games.divi.domains/*');
      expect(s.matches.every((m: string) => m.startsWith('https://'))).toBe(true);
    }
  });

  it('example.com gets neither script nor window.irondivi', async () => {
    const h = await createHarness('https://example.com/');
    expect(h.provider()).toBeUndefined();
    expect((globalThis as any).window.irondivi).toBeUndefined();
  });

  it('a site the browser has not granted is not registered, even when allowed', async () => {
    const h = await createHarness('https://example.org/', { allowedSites: ['games.divi.domains', 'example.org'] });
    for (const s of h.registeredScripts) expect(s.matches).not.toContain('https://example.org/*');
    expect(h.provider()).toBeUndefined();
  });

  it('changing the allowed sites in Settings re-registers the scripts', async () => {
    const h = await createHarness('https://games.divi.domains/', { grantedOrigins: ['https://example.org/*'] });
    await h.setupWallet();
    const r = await h.popup('UPDATE_SETTINGS', { allowedSites: ['games.divi.domains', 'example.org', 'not-granted.example'], password: TEST_PASSWORD });
    expect(r.success).toBe(true);
    await settle();
    for (const s of h.registeredScripts) {
      expect(s.matches).toEqual(['https://games.divi.domains/*', 'https://example.org/*']);
    }
    expect(h.registeredScripts).toHaveLength(2);

    expect((await h.popup('UPDATE_SETTINGS', { allowedSites: [], password: TEST_PASSWORD })).success).toBe(true);
    await settle();
    expect(h.registeredScripts).toHaveLength(0);
  });
});

describe('EXT-3 a failure to restrict local storage is not hidden', () => {
  it('warns when the browser cannot keep content scripts out of local storage', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await createHarness();
    expect(warn.mock.calls.some(c => String(c[0]).includes('cannot keep content scripts out of local storage'))).toBe(true);
  });
});
