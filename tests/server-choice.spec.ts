import { test as base, expect, BrowserContext } from '@playwright/test';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import { launchWithExtension } from './browser';
import { Address } from '../src/lib/address';
import { Mnemonic } from '../src/lib/mnemonic';
import { deriveAddresses } from '../src/lib/derivation';
import { Transaction } from '../src/lib/transaction';

// Settings -> Server in the real popup (design §6): the three choices, Test
// before Save, the label, and the banner when the chosen server is down, with
// no silent fallback. The Electrum conversation itself is tested against the
// fake server in src/background/server-choice.test.ts: a browser only opens
// wss:// to a trusted certificate, which a local fake cannot present.

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const EXTENSION_PATH = path.join(__dirname, '../dist', process.env.EXT_DIST || 'chrome');
const SHOTS = path.join(__dirname, '../docs/server-screen');
const MNEMONIC = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
const PASSWORD = 'ServerPassword123!';
// A wss:// address nothing listens on
const DEAD = 'wss://127.0.0.1:9';

const test = base.extend<{ context: BrowserContext; extensionId: string }>({
  context: async ({}, use) => {
    const context = await launchWithExtension(EXTENSION_PATH);
    await use(context);
    await context.close();
  },
  extensionId: async ({ context }, use) => {
    let [sw] = context.serviceWorkers();
    if (!sw) sw = await context.waitForEvent('serviceworker');
    await use(sw.url().split('/')[2]);
  },
});

test('Server setting: choices, test before save, label, banner, no silent fallback', async ({ context, extensionId }) => {
  test.setTimeout(180000);
  fs.mkdirSync(SHOTS, { recursive: true });
  const own = (await deriveAddresses(await Mnemonic.toSeed(MNEMONIC), 'testnet', 0, 1))[0].address;
  const hash = Array.from(Address.decode(own).hash, (b: number) => b.toString(16).padStart(2, '0')).join('');
  const funding = new Transaction();
  funding.inputs.push({ txid: '01'.repeat(32), vout: 0, script: '', sequence: 0xffffffff });
  funding.outputs.push({ value: 1250n * 100000000n, script: `76a914${hash}88ac` });
  const rpcCalls: string[] = [];
  await context.route('https://services.divi.domains/**', async (route) => {
    const body = route.request().postDataJSON() || {};
    rpcCalls.push(body.method);
    let result: unknown = null;
    switch (body.method) {
      case 'getblockcount': result = 1000; break;
      case 'getaddressbalance': result = { balance: body.params[0] === own ? 1250e8 : 0, received: 0 }; break;
      case 'getaddresstxids': result = []; break;
    }
    await route.fulfill({ contentType: 'application/json', body: JSON.stringify({ jsonrpc: '2.0', id: body.id, result }) });
  });

  const popup = await context.newPage();
  await popup.setViewportSize({ width: 360, height: 760 });
  await popup.goto(`chrome-extension://${extensionId}/popup.html`);
  await popup.click('#onboard-import-btn');
  await popup.fill('#import-name', 'Main wallet');
  await popup.fill('#import-mnemonic', MNEMONIC);
  await popup.fill('#import-password', PASSWORD);
  await popup.click('#import-submit-btn');
  await expect(popup.locator('#balance-section')).toContainText('1250', { timeout: 30000 });

  // Untouched: no label, no banner
  await expect(popup.locator('#server-label')).toBeHidden();
  await expect(popup.locator('#server-banner')).toBeHidden();

  await popup.click('#settings-btn');
  await expect(popup.locator('#server-heading')).toHaveText('Server for Testnet');
  await expect(popup.locator('input[name="server-mode"][value="default"]')).toBeChecked();
  await expect(popup.locator('#server-using')).toHaveText('Using: IronDivi (standard)');
  await expect(popup.locator('#server-save-btn')).toBeEnabled();
  await popup.locator('#server-section').scrollIntoViewIfNeeded();
  await popup.waitForTimeout(800);
  await popup.screenshot({ path: path.join(SHOTS, 'server-default.png') });

  // My own server: Save stays off until a Test passes, and a failed Test says why
  await popup.check('input[name="server-mode"][value="own"]');
  await expect(popup.locator('#server-save-btn')).toBeDisabled();
  await popup.fill('#server-url', 'ws://box.local:50003');
  await popup.click('#server-test-btn');
  await expect(popup.locator('#server-result')).toContainText('wss://');
  await expect(popup.locator('#server-save-btn')).toBeDisabled();
  await popup.fill('#server-url', DEAD);
  await popup.click('#server-test-btn');
  await expect(popup.locator('#server-result')).toContainText(/Can.t reach/, { timeout: 30000 });
  await expect(popup.locator('#server-save-btn')).toBeDisabled();
  await popup.screenshot({ path: path.join(SHOTS, 'server-test-failed.png') });

  // A server that was saved and later went away: label, banner, no fallback
  const sw = context.serviceWorkers()[0];
  await sw.evaluate((url) => chrome.storage.local.set({ server: { mainnet: { mode: 'default' }, testnet: { mode: 'own', url } } }), DEAD);
  rpcCalls.length = 0;
  await popup.reload();
  await expect(popup.locator('#server-banner')).toBeVisible({ timeout: 30000 });
  await expect(popup.locator('#server-banner-text')).toContainText('Turn on Tailscale');
  await expect(popup.locator('#server-label')).toContainText('My own server');
  await popup.waitForTimeout(500);
  await popup.screenshot({ path: path.join(SHOTS, 'server-unreachable-banner.png') });
  expect(rpcCalls.filter(m => m !== 'getblockcount')).toEqual([]);

  // IronDivi for this session only
  await popup.click('#server-banner-default');
  await expect(popup.locator('#server-banner')).toBeHidden();
  await expect(popup.locator('#server-label')).toContainText('IronDivi (standard)');
  const stored = await sw.evaluate(() => chrome.storage.local.get('server'));
  expect(stored.server.testnet).toEqual({ mode: 'own', url: DEAD });
});
