// The published Chrome package against the real sites. Skipped unless
// LIVE_RELEASE=<path to an unpacked irondivi-wallet-chrome zip> is set, since
// it needs the network:
//   unzip packages/irondivi-wallet-chrome-v0.0.6.zip -d /tmp/x
//   LIVE_RELEASE=/tmp/x npx playwright test tests/live-release.spec.ts
// It creates a throwaway wallet (the recovery phrase is never read, printed
// or captured), connects it to games.divi.domains, and checks that a site off
// the default list (example.com) is told not_allowed and gets 4300 with no
// window opening.
import { test as base, expect, BrowserContext } from '@playwright/test';
import fs from 'fs';
import path from 'path';
import { launchWithExtension } from './browser';

const PKG = process.env.LIVE_RELEASE || '';
const PASSWORD = 'LiveCheck-' + Math.random().toString(36).slice(2) + '!A1';

const test = base.extend<{ context: BrowserContext; extensionId: string }>({
  context: async ({}, use) => {
    const context = await launchWithExtension(PKG);
    await use(context);
    await context.close();
  },
  extensionId: async ({ context }, use) => {
    let [sw] = context.serviceWorkers();
    if (!sw) sw = await context.waitForEvent('serviceworker');
    await use(sw.url().split('/')[2]);
  },
});

test.skip(!PKG, 'set LIVE_RELEASE to an unpacked release package');

test('the release: create a wallet, connect on games.divi.domains, example.com is refused', async ({ context, extensionId }) => {
  test.setTimeout(180000);
  const manifest = JSON.parse(fs.readFileSync(path.join(PKG, 'manifest.json'), 'utf8'));
  console.log('package version', manifest.version);

  // Create a wallet. The phrase modal is confirmed without reading it.
  const popup = await context.newPage();
  await popup.goto(`chrome-extension://${extensionId}/popup.html`);
  await popup.click('#onboard-create-btn');
  await popup.fill('#create-name', 'Live check');
  await popup.fill('#create-password', PASSWORD);
  await popup.fill('#create-password-confirm', PASSWORD);
  await popup.click('#create-submit-btn');
  await expect(popup.locator('#mnemonic-modal')).toBeVisible({ timeout: 15000 });
  await popup.click('#mnemonic-confirm-btn');
  await expect(popup.locator('#loading')).not.toBeVisible({ timeout: 15000 });
  await expect(popup.locator('#toast.error')).not.toBeVisible();
  await popup.close();

  // A default site: the provider is there, and connect goes through approval
  const games = await context.newPage();
  await games.goto('https://games.divi.domains/', { waitUntil: 'domcontentloaded' });
  await games.waitForFunction(() => !!(window as any).irondivi, null, { timeout: 15000 });
  expect(await games.evaluate(() => (window as any).irondivi.getAccessStatus())).toBe('default');
  // The site may ask on load as well; requests share one approval window, so
  // take any approval window, whether it was already open or opens now
  const win = (async () => {
    for (const end = Date.now() + 20000; Date.now() < end; await new Promise(r => setTimeout(r, 250))) {
      const p = context.pages().find(x => /approve=/.test(x.url()));
      if (p) { await p.waitForLoadState('domcontentloaded'); return p; }
    }
    throw new Error('no approval window opened; pages: ' + context.pages().map(x => x.url()).join(' '));
  })();
  const connected = games.evaluate(() => (window as any).irondivi.connect());
  const w = await win;
  await w.click('#approve-request-btn');
  const result = await connected;
  console.log('games.divi.domains connect ->', JSON.stringify({ ...result, address: result?.address ? 'present' : result?.address }));
  expect(result?.address).toMatch(/^[DyY]/);

  // A site off the list: told only its status; nothing opens
  const ex = await context.newPage();
  await ex.goto('https://example.com/', { waitUntil: 'domcontentloaded' });
  const opened: string[] = [];
  context.on('page', p => opened.push(p.url()));
  await ex.waitForFunction(() => !!(window as any).irondivi, null, { timeout: 15000 });
  expect(await ex.evaluate(() => (window as any).irondivi.getAccessStatus())).toBe('not_allowed');
  const code = await ex.evaluate(() => (window as any).irondivi.connect().then(() => 'connected', (e: any) => e?.code));
  console.log('example.com connect ->', code);
  expect(code).toBe(4300);
  const accounts = await ex.evaluate(() => (window as any).irondivi.getAccounts().then(() => 'answered', (e: any) => e?.code));
  expect(accounts).toBe(4300);
  await ex.waitForTimeout(2000);
  expect(opened).toEqual([]);
});
