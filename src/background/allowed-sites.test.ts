import { beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { createHarness } from '../test-support/harness';
import {
  DEV_SITES, LEGACY_DEFAULT_SITES, PRODUCTION_SITES,
  defaultAllowedSites, effectiveAllowedSites, isAllowedDappOrigin,
} from '../shared/origin';

// Regression tests for the security review's M6: the default allowedSites
// admitted every host under *.divi.domains, and localhost, in release builds

vi.setConfig({ testTimeout: 30000 });

beforeEach(() => {
  vi.resetModules();
});

describe('M6 the default list names the production hosts exactly', () => {
  it('a release build allows only the named production hosts', () => {
    const sites = defaultAllowedSites(false);
    expect(sites).toEqual(PRODUCTION_SITES);
    expect(sites.every(s => !s.includes('*') && !s.includes('?'))).toBe(true);
    for (const origin of ['https://games.divi.domains', 'https://services.divi.domains']) {
      expect(isAllowedDappOrigin(origin, sites)).toBe(true);
    }
  });

  it('a release build refuses other divi.domains hosts and local pages', () => {
    const sites = defaultAllowedSites(false);
    for (const origin of [
      'https://evil.divi.domains', 'https://app.divi.domains', 'https://divi.domains',
      'https://games.divi.domains.evil.example', 'http://localhost:8080', 'http://127.0.0.1:8080',
    ]) {
      expect({ origin, allowed: isAllowedDappOrigin(origin, sites) }).toEqual({ origin, allowed: false });
    }
  });

  it('a development build adds localhost and 127.0.0.1 and nothing else', () => {
    expect(defaultAllowedSites(true)).toEqual([...PRODUCTION_SITES, ...DEV_SITES]);
    expect(isAllowedDappOrigin('http://127.0.0.1:8080', defaultAllowedSites(true))).toBe(true);
  });

  it('the unit tests run as a release build', async () => {
    (globalThis as any).chrome ??= { runtime: {} };
    const { DEFAULT_SETTINGS } = await import('../shared/storage');
    expect(DEFAULT_SETTINGS.allowedSites).toEqual(PRODUCTION_SITES);
  });

  it('only the build turns development on', () => {
    const cfg = readFileSync(new URL('../../esbuild.config.js', import.meta.url), 'utf8');
    expect(cfg).toMatch(/const isDev = isWatch \|\| process\.env\.IRONDIVI_DEV === '1';/);
    expect(cfg).toMatch(/define: \{ __IRONDIVI_DEV__: String\(isDev\) \}/);
    const pkg = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8'));
    for (const [name, cmd] of Object.entries<string>(pkg.scripts)) {
      if (/^(build|build:all|build:firefox|build:edge|build:safari|package:release)$/.test(name)) {
        expect({ name, dev: cmd.includes('IRONDIVI_DEV') }).toEqual({ name, dev: false });
      }
    }
  });
});

describe('M6 a stored list from an earlier version', () => {
  it('the old default is replaced by the new one', () => {
    expect(effectiveAllowedSites([...LEGACY_DEFAULT_SITES], false)).toEqual(PRODUCTION_SITES);
  });

  it('a list the user changed is kept as it is', () => {
    const mine = ['*.divi.domains', 'localhost'];
    expect(effectiveAllowedSites(mine, false)).toBe(mine);
    expect(effectiveAllowedSites(['games.divi.domains', 'my.dapp.example'], false))
      .toEqual(['games.divi.domains', 'my.dapp.example']);
  });

  it('nothing stored gives the default', () => {
    expect(effectiveAllowedSites(undefined, false)).toEqual(PRODUCTION_SITES);
  });

  it('a wallet that stored the old default no longer serves other divi.domains hosts', async () => {
    const h = await createHarness('https://evil.divi.domains/', { allowedSites: [...LEGACY_DEFAULT_SITES] });
    const r = await h.fromTab('SITE_ALLOWED');
    expect(r).toEqual({ success: true, data: { allowed: false } });
    expect(h.provider()).toBeUndefined();
    const s = await h.popup('GET_SETTINGS');
    expect(s.data.settings.allowedSites).toEqual(PRODUCTION_SITES);
  });

  it('and still serves the production hosts', async () => {
    const h = await createHarness('https://games.divi.domains/', { allowedSites: [...LEGACY_DEFAULT_SITES] });
    expect(await h.fromTab('SITE_ALLOWED')).toEqual({ success: true, data: { allowed: true } });
    expect(h.provider()).toBeDefined();
  });
});

describe('M6 no default list is written out anywhere else', () => {
  it('the popup and storage take the default from one place', () => {
    for (const f of ['../popup/settings-ui.ts', '../shared/storage.ts']) {
      const src = readFileSync(new URL(f, import.meta.url), 'utf8')
        .replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
      expect({ f, wildcard: src.includes("'*.divi.domains'") }).toEqual({ f, wildcard: false });
    }
  });
});
