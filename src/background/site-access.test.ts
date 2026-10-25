import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createHarness, TEST_PASSWORD, type Harness } from '../test-support/harness';
import {
  accessStatus, cleanReason, DEFAULT_SITES, MAX_REASON, migrateAllowedSites, NOT_NOW_MS, type SiteAccess,
} from '../shared/site-access';
import { OLD_DEFAULT_PATTERNS } from '../shared/origin';
import { ERR } from '../shared/provider-errors';

// Which sites may use the wallet: the compiled default list, a site asking
// with requestAccess (Allow, Not now, Never), the denylist and the user's own
// blocks. Each rule is one test.

vi.setConfig({ testTimeout: 30000 });

const SHOP = 'https://shop.example';
const none = (): SiteAccess => ({ grants: {}, blocked: {} });

let h: Harness;

async function ask(reason?: string) {
  return h.provider().requestAccess(reason === undefined ? undefined : { reason });
}

async function answer(choice: 'allowed' | 'not_now' | 'denied') {
  const req = await h.waitForPending('access');
  const r = await h.approvalWindow('ANSWER_ACCESS_REQUEST', { requestId: req.id, choice });
  expect(r.success).toBe(true);
  return req;
}

async function shop(siteAccess?: SiteAccess) {
  vi.resetModules();
  h = await createHarness(`${SHOP}/`, siteAccess ? { siteAccess } : {});
  await h.setupWallet();
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('the rules, as accessStatus decides them', () => {
  it('a default site is default on both networks', () => {
    for (const o of DEFAULT_SITES) {
      expect(accessStatus(o, 'mainnet', none())).toBe('default');
      expect(accessStatus(o, 'testnet', none())).toBe('default');
    }
  });

  it('the default list is exact origins: no subdomain, other port or http', () => {
    for (const o of ['https://x.divi.cx', 'https://games.divi.domains:8443', 'http://games.divi.domains', 'https://evil.divi.domains']) {
      expect(accessStatus(o, 'testnet', none())).not.toBe('default');
    }
  });

  it('a user block overrides the default list and a grant', () => {
    const access: SiteAccess = {
      grants: { [SHOP]: { testnet: { state: 'allowed', at: 1 } } },
      blocked: { [SHOP]: 1, 'https://games.divi.domains': 1 },
    };
    expect(accessStatus(SHOP, 'testnet', access)).toBe('blocked');
    expect(accessStatus('https://games.divi.domains', 'testnet', access)).toBe('blocked');
  });

  it('a choice holds on its own network only', () => {
    const access: SiteAccess = { grants: { [SHOP]: { testnet: { state: 'allowed', at: 1 } } }, blocked: {} };
    expect(accessStatus(SHOP, 'testnet', access)).toBe('allowed');
    expect(accessStatus(SHOP, 'mainnet', access)).toBe('not_allowed');
  });

  it('the reason is cut to 200 characters', () => {
    expect(MAX_REASON).toBe(200);
    expect([...cleanReason('x'.repeat(500))]).toHaveLength(201); // 200 and the ellipsis
    expect(cleanReason({ toString: () => 'x' })).toBe('');
  });

  it('an install from before 0.0.5 keeps its own sites, and is told which patterns could not be kept', () => {
    const { access, dropped } = migrateAllowedSites(
      ['games.divi.domains', 'my.site', 'localhost:3000', '*.other.site', 'host:*'], OLD_DEFAULT_PATTERNS);
    expect(access.grants['https://my.site']).toEqual({ mainnet: { state: 'allowed', at: 0 }, testnet: { state: 'allowed', at: 0 } });
    expect(access.grants['http://localhost:3000']).toBeDefined();
    expect(access.grants['https://games.divi.domains']).toBeUndefined();
    expect(dropped.sort()).toEqual(['*.other.site', 'host:*']);
  });
});

describe('the compiled denylist', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.doMock('../../site-access/blocked-sites.json', () => ({ default: [SHOP, 'https://games.divi.domains'] }));
  });
  afterEach(() => {
    vi.doUnmock('../../site-access/blocked-sites.json');
  });

  it('overrides the default list and a grant, and the site can never open a window', async () => {
    const grant: SiteAccess = { grants: { [SHOP]: { testnet: { state: 'allowed', at: 1 } } }, blocked: {} };
    h = await createHarness(`${SHOP}/`, { siteAccess: grant });
    await h.setupWallet();
    const sa = await import('../shared/site-access');
    expect(sa.accessStatus('https://games.divi.domains', 'testnet', none())).toBe('blocked');
    expect(await h.provider().getAccessStatus()).toBe('blocked');
    expect(await ask('please')).toBe('blocked');
    await expect(h.provider().connect()).rejects.toMatchObject({ code: ERR.BLOCKED });
    expect(h.createdWindows).toHaveLength(0);
  });
});

describe('a site that is not on the default list', () => {
  beforeEach(async () => {
    await shop();
  });

  it('is told not_allowed, and getAccessStatus never opens a window', async () => {
    expect(await h.provider().getAccessStatus()).toBe('not_allowed');
    expect(await h.provider().getAccessStatus()).toBe('not_allowed');
    expect(h.createdWindows).toHaveLength(0);
  });

  it('gets 4300 for everything else, with no window', async () => {
    for (const call of [() => h.provider().connect(), () => h.provider().getAccounts(), () => h.provider().signMessage('hi')]) {
      await expect(call()).rejects.toMatchObject({ code: ERR.ACCESS_REQUIRED });
    }
    expect(h.createdWindows).toHaveLength(0);
  });

  it('can ask once: the window shows the origin and the capped reason, and Allow lets it connect', async () => {
    const asked = ask('x'.repeat(300));
    const req = await h.waitForPending('access');
    expect(req.origin).toBe(SHOP);
    expect(req.data.reason).toBe(cleanReason('x'.repeat(300)));
    expect(h.createdWindows).toHaveLength(1);
    await h.approvalWindow('ANSWER_ACCESS_REQUEST', { requestId: req.id, choice: 'allowed' });
    expect(await asked).toBe('allowed');
    expect(await h.provider().getAccessStatus()).toBe('allowed');
    await h.connectPage();
  });

  it('only one request per origin is open at a time', async () => {
    const first = ask();
    await h.waitForPending('access');
    await expect(ask()).rejects.toThrow(/already has a request/);
    expect(h.createdWindows).toHaveLength(1);
    await answer('denied');
    expect(await first).toBe('denied');
  });

  it('Not now: no window for 24 hours, then it may ask again', async () => {
    const t0 = Date.now();
    const first = ask();
    await answer('not_now');
    expect(await first).toBe('not_allowed');
    expect(await ask()).toBe('not_allowed');
    expect(h.createdWindows).toHaveLength(1);

    vi.spyOn(Date, 'now').mockReturnValue(t0 + NOT_NOW_MS - 1000);
    expect(await ask()).toBe('not_allowed');
    expect(h.createdWindows).toHaveLength(1);

    vi.spyOn(Date, 'now').mockReturnValue(t0 + NOT_NOW_MS + 1000);
    const again = ask();
    await answer('allowed');
    expect(await again).toBe('allowed');
    expect(h.createdWindows).toHaveLength(2);
  });

  it('closing the window counts as Not now', async () => {
    const first = ask();
    await h.waitForPending('access');
    h.closeWindow(h.createdWindows[0].id);
    expect(await first).toBe('not_allowed');
    expect(await ask()).toBe('not_allowed');
    expect(h.createdWindows).toHaveLength(1);
  });

  it('Never: requestAccess resolves denied from then on, with no window', async () => {
    const first = ask();
    await answer('denied');
    expect(await first).toBe('denied');
    expect(await ask()).toBe('denied');
    expect(await h.provider().getAccessStatus()).toBe('denied');
    await expect(h.provider().connect()).rejects.toMatchObject({ code: ERR.ACCESS_REQUIRED });
    expect(h.createdWindows).toHaveLength(1);
  });

  it('the choice is per network', async () => {
    const first = ask();
    await answer('allowed');
    expect(await first).toBe('allowed');
    expect((await h.popup('UPDATE_SETTINGS', { network: 'mainnet', password: TEST_PASSWORD })).error).toBeUndefined();
    expect(await h.provider().getAccessStatus()).toBe('not_allowed');
  });
});

describe('from settings, the user', () => {
  const allowed: SiteAccess = { grants: { [SHOP]: { testnet: { state: 'allowed', at: 1 } } }, blocked: {} };

  it('revokes a site: its connection is dropped and it must ask again', async () => {
    await shop(allowed);
    await h.connectPage();
    expect((await h.popup('SET_SITE_ACCESS', { action: 'revoke', origin: SHOP })).success).toBe(true);
    expect(await h.provider().getAccessStatus()).toBe('not_allowed');
    expect((await h.fromTab('IS_CONNECTED')).code).toBe(ERR.ACCESS_REQUIRED);
    expect(h.storage.connections && JSON.stringify(h.storage.connections)).not.toContain(SHOP);
  });

  it('blocks a site, even a default one: blocked everywhere, 4301, no window', async () => {
    await shop(allowed);
    await h.connectPage();
    const windows = h.createdWindows.length;
    expect((await h.popup('SET_SITE_ACCESS', { action: 'block', origin: SHOP })).success).toBe(true);
    expect(await h.provider().getAccessStatus()).toBe('blocked');
    expect(await ask()).toBe('blocked');
    await expect(h.provider().getAccounts()).rejects.toMatchObject({ code: ERR.BLOCKED });
    expect(h.createdWindows).toHaveLength(windows);

    expect((await h.popup('SET_SITE_ACCESS', { action: 'block', origin: 'games.divi.domains' })).success).toBe(true);
    const settings = h.storage.settings;
    expect(accessStatus('https://games.divi.domains', 'testnet', settings.siteAccess)).toBe('blocked');
  });

  it('a block drops a request the site has open', async () => {
    await shop();
    const asked = ask();
    await h.waitForPending('access');
    expect((await h.popup('SET_SITE_ACCESS', { action: 'block', origin: SHOP })).success).toBe(true);
    expect(await asked).toBe('blocked');
  });

  it('only the popup may change site access', async () => {
    await shop();
    const r = await h.fromTab('SET_SITE_ACCESS', { action: 'unblock', origin: SHOP });
    expect(r.success).toBe(false);
    const w = await h.fromTab('ANSWER_ACCESS_REQUEST', { requestId: 'x', choice: 'allowed' });
    expect(w.success).toBe(false);
  });
});
