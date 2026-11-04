// End-to-end: the spending limits in the built extension, with screenshots.
// The defaults refuse a send of 40% of the balance; the Spending limits switch
// in Settings (off asks for the password, ADR 0002) lets the user send the
// whole wallet.
// The testnet RPC is mocked with context.route, so nothing is broadcast.
import { test as base, expect, BrowserContext, Page } from '@playwright/test';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import { launchWithExtension } from './browser';
import { Address } from '../src/lib/address';
import { Mnemonic } from '../src/lib/mnemonic';
import { deriveAddresses } from '../src/lib/derivation';
import { Transaction } from '../src/lib/transaction';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const EXTENSION_PATH = process.env.EXT_PATH || path.join(__dirname, '../dist/chrome');
const SHOTS = path.join(__dirname, '../docs/limits-screen');
const MNEMONIC = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
const PASSWORD = 'E2ePassword123!';

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

async function shot(popup: Page, name: string) {
  await popup.waitForTimeout(300);
  await popup.screenshot({ path: path.join(SHOTS, `${name}.png`) });
}

test('the default limits refuse a large send, and the user can switch them off', async ({ context, extensionId }) => {
  test.setTimeout(240000);
  fs.mkdirSync(SHOTS, { recursive: true });

  const own = (await deriveAddresses(await Mnemonic.toSeed(MNEMONIC), 'testnet', 0, 1))[0].address;
  const dest = (await deriveAddresses(await Mnemonic.toSeed(MNEMONIC, 'other-account'), 'testnet', 0, 1))[0].address;
  const hash = Array.from(Address.decode(own).hash, (b: number) => b.toString(16).padStart(2, '0')).join('');
  const broadcasts: string[] = [];
  const funding = new Transaction();
  funding.inputs.push({ txid: '01'.repeat(32), vout: 0, script: '', sequence: 0xffffffff });
  funding.outputs.push({ value: 1000n * 100000000n, script: `76a914${hash}88ac` });
  funding.outputs.push({ value: 1000n * 100000000n, script: `76a914${hash}88ac` });
  const fundingTxid = funding.txid();
  await context.route('https://services.divi.domains/**', async (route) => {
    const body = route.request().postDataJSON() || {};
    let result: unknown = null;
    switch (body.method) {
      case 'getblockcount': result = 1000; break;
      case 'getaddressutxos':
        result = body.params[0] === own || body.params[0]?.addresses?.includes?.(own)
          ? [0, 1].map(outputIndex => ({ address: own, txid: fundingTxid, outputIndex, script: `76a914${hash}88ac`, satoshis: 1000e8, height: 990 }))
          : [];
        break;
      case 'getaddressbalance': result = { balance: body.params[0] === own || body.params[0]?.addresses?.includes?.(own) ? 2000e8 : 0, received: 0 }; break;
      case 'getaddresstxids': result = []; break;
      case 'validateaddress': result = { isvalid: true }; break;
      case 'getrawtransaction': result = body.params[0] === fundingTxid && body.params[1] === 0 ? funding.toHex() : null; break;
      case 'sendrawtransaction': broadcasts.push(body.params[0]); result = Transaction.fromHex(body.params[0]).txid(); break;
    }
    await route.fulfill({ contentType: 'application/json', body: JSON.stringify({ jsonrpc: '2.0', id: body.id, result }) });
  });

  const popup = await context.newPage();
  await popup.setViewportSize({ width: 360, height: 760 });
  await popup.goto(`chrome-extension://${extensionId}/popup.html`);
  await popup.click('#onboard-import-btn');
  await popup.fill('#import-name', 'Limits demo');
  await popup.fill('#import-mnemonic', MNEMONIC);
  await popup.fill('#import-password', PASSWORD);
  await popup.click('#import-submit-btn');
  await expect(popup.locator('#balance-section')).toBeVisible({ timeout: 30000 });
  await expect(popup.locator('#balance-section')).toContainText('2000', { timeout: 60000 });
  await shot(popup, '1-wallet-2000-divi');

  // Settings → Security, as shipped: 10% a send, 25% a day
  await popup.click('#settings-btn');
  await popup.locator('#setting-limits-enabled').scrollIntoViewIfNeeded();
  await expect(popup.locator('#setting-limits-enabled')).toBeChecked();
  await expect(popup.locator('#setting-tx-limit-percent')).toHaveValue('10');
  await expect(popup.locator('#setting-daily-limit-percent')).toHaveValue('25');
  await shot(popup, '2-settings-default-limits');
  await popup.click('#settings-back-btn');

  // A send of 800 DIVI (40%) is refused before anything is signed
  async function send(amount: string | 'max') {
    await popup.click('#send-btn');
    await popup.fill('#send-to', dest);
    if (amount === 'max') await popup.click('#send-max-btn');
    else await popup.fill('#send-amount', amount);
    await popup.click('#send-confirm-btn');
    await expect(popup.locator('#view-send-confirm')).toBeVisible({ timeout: 15000 });
    await popup.fill('#send-password', PASSWORD);
    await popup.click('#send-submit-btn');
  }
  await send('800');
  await expect(popup.locator('#toast.error')).toContainText('Over your spending limit: 10% of your balance per send', { timeout: 30000 });
  await shot(popup, '3-send-800-refused');
  expect(broadcasts).toHaveLength(0);

  // The user switches the limits off: one switch, the password once
  await popup.goto(`chrome-extension://${extensionId}/popup.html`);
  await expect(popup.locator('#balance-section')).toBeVisible({ timeout: 30000 });
  await popup.click('#settings-btn');
  await popup.locator('#setting-limits-enabled').scrollIntoViewIfNeeded();
  await popup.click('#setting-limits-enabled');
  await expect(popup.locator('#password-modal')).toBeVisible();
  await shot(popup, '4-password-to-switch-limits-off');
  await popup.fill('#password-modal-input', PASSWORD);
  await popup.click('#password-modal-submit');
  await expect(popup.locator('#toast')).toContainText('Settings updated', { timeout: 15000 });
  await expect(popup.locator('#setting-limits-enabled')).not.toBeChecked();
  await expect(popup.locator('#limits-off-note')).toBeVisible();
  await expect(popup.locator('#limits-off-note')).toContainText('Off: any amount can be sent');
  await expect(popup.locator('#limits-numbers')).toBeHidden();
  await popup.locator('#setting-limits-enabled').scrollIntoViewIfNeeded();
  await shot(popup, '5-settings-limits-off');
  await popup.click('#settings-back-btn');

  // Now the whole wallet goes (MAX = everything less the fee)
  await send('max');
  await expect.poll(() => broadcasts.length, { timeout: 30000 }).toBe(1);
  await shot(popup, '6-whole-wallet-sent');
  const tx = Transaction.fromHex(broadcasts[0]);
  const sent = tx.outputs.reduce((s, o) => s + o.value, 0n);
  expect(tx.inputs).toHaveLength(2);
  expect(sent).toBeGreaterThan(1999n * 100000000n);
});
