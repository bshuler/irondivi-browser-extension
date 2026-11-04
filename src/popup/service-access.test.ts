import { afterEach, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { SERVICE_ORIGINS, hasServiceAccess, requestServiceAccess } from './service-access';
import { NETWORKS, FAUCET_URLS } from '../shared/constants';

// Safari grants host permissions one website at a time, so the background's
// RPC calls failed until the user allowed services.divi.domains: every new
// wallet showed "Failed to load balance" and its history never loaded

afterEach(() => { delete (globalThis as any).chrome; });

function fakePermissions(granted: boolean) {
  const asked: string[][] = [];
  (globalThis as any).chrome = {
    permissions: {
      contains: (p: { origins: string[] }, cb: (ok: boolean) => void) => { asked.push(p.origins); cb(granted); },
      request: (p: { origins: string[] }, cb: (ok: boolean) => void) => { asked.push(p.origins); cb(true); },
    },
  };
  return asked;
}

describe('Safari: the popup asks for the Divi services the background fetches from', () => {
  it('asks for every host the background calls', () => {
    const urls = [...Object.values(NETWORKS).map(n => n.rpcUrl), ...Object.values(FAUCET_URLS)];
    for (const url of urls) {
      expect(SERVICE_ORIGINS).toContain(`${new URL(url).origin}/*`);
    }
  });

  it('every one it asks for is declared in each manifest, or the browser refuses the request', () => {
    for (const name of ['manifest.json', 'manifest.firefox.json', 'manifest.safari.json']) {
      const m = { ...JSON.parse(readFileSync(new URL('../../manifest.json', import.meta.url), 'utf8')),
        ...JSON.parse(readFileSync(new URL(`../../${name}`, import.meta.url), 'utf8')) };
      const declared = [...(m.host_permissions ?? []), ...(m.optional_host_permissions ?? [])];
      for (const origin of SERVICE_ORIGINS) {
        expect(declared.some(d => d === origin || d === 'https://*/*'), `${name}: ${origin}`).toBe(true);
      }
    }
  });

  it('reports what the browser granted and asks for exactly those hosts', async () => {
    const asked = fakePermissions(false);
    expect(await hasServiceAccess()).toBe(false);
    expect(await requestServiceAccess()).toBe(true);
    expect(asked).toEqual([SERVICE_ORIGINS, SERVICE_ORIGINS]);
    fakePermissions(true);
    expect(await hasServiceAccess()).toBe(true);
  });

  it('a browser without the permissions API is taken as already granted, never nagged', async () => {
    (globalThis as any).chrome = {};
    expect(await hasServiceAccess()).toBe(true);
  });

  it('a failed balance or history load shows the banner instead of an error when access is missing', () => {
    const src = readFileSync(new URL('./wallet-ui.ts', import.meta.url), 'utf8');
    for (const what of ['balance', 'transactions']) {
      expect(src).toMatch(new RegExp(`explainedByMissingAccess\\(\\)\\) return;\\s*showToast\\('Failed to load ${what}`));
    }
    expect(readFileSync(new URL('./popup.html', import.meta.url), 'utf8')).toMatch(/id="service-access-allow"/);
  });
});
