import { test as base, expect, BrowserContext, Page } from '@playwright/test';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import { launchWithExtension } from './browser';
import { Address } from '../src/lib/address';
import { Mnemonic } from '../src/lib/mnemonic';
import { deriveAddresses } from '../src/lib/derivation';
import { Transaction } from '../src/lib/transaction';

// Store screenshots (1280x800) of the release build: the wallet, a send, an
// approval window for games.divi.domains, and the site and Connect settings.
// The wallet is the public BIP39 test vector on a fake testnet node, and no
// screen that shows a recovery phrase is opened. Run with STORE_SHOTS=1;
// the pictures land in packages/store/screenshots/.

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const EXTENSION_PATH = path.join(__dirname, '../dist', process.env.EXT_DIST || 'chrome');
const OUT = path.join(__dirname, '../packages/store/screenshots');
const MNEMONIC = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
const PASSWORD = 'StorePassword123!';
const GAME = 'https://games.divi.domains/';

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

test.skip(!process.env.STORE_SHOTS, 'store screenshots: set STORE_SHOTS=1');

/** Put a 360-wide wallet picture on a 1280x800 slide with a caption */
async function slide(context: BrowserContext, name: string, shot: Buffer, title: string, line: string) {
  const p = await context.newPage();
  await p.setViewportSize({ width: 1280, height: 800 });
  const img = `data:image/png;base64,${shot.toString('base64')}`;
  await p.setContent(`<!doctype html><html><body style="margin:0;width:1280px;height:800px;display:flex;align-items:center;gap:64px;padding:0 96px;box-sizing:border-box;background:linear-gradient(135deg,#0f0f1a,#1a1a2e);font-family:-apple-system,Segoe UI,Inter,sans-serif;color:#f8fafc">
    <div style="flex:1"><div style="font-size:48px;font-weight:800;letter-spacing:-0.02em;line-height:1.1">${title}</div>
    <div style="font-size:22px;color:#cbd5e1;margin-top:20px;line-height:1.5">${line}</div></div>
    <img src="${img}" style="height:720px;border-radius:16px;box-shadow:0 20px 60px rgba(0,0,0,.5)"></body></html>`);
  await p.screenshot({ path: path.join(OUT, `${name}.png`) });
  await p.close();
}

// The views slide in; wait for the slide to end before the picture
const popupShot = async (p: Page) => {
  await p.waitForTimeout(1000);
  return p.screenshot({ fullPage: false });
};

test('store screenshots', async ({ context, extensionId }) => {
  test.setTimeout(300000);
  fs.mkdirSync(OUT, { recursive: true });
  const own = (await deriveAddresses(await Mnemonic.toSeed(MNEMONIC), 'testnet', 0, 1))[0].address;
  const dest = (await deriveAddresses(await Mnemonic.toSeed(MNEMONIC, 'other-account'), 'testnet', 0, 1))[0].address;
  const hash = Array.from(Address.decode(own).hash, (b: number) => b.toString(16).padStart(2, '0')).join('');
  const funding = new Transaction();
  funding.inputs.push({ txid: '01'.repeat(32), vout: 0, script: '', sequence: 0xffffffff });
  funding.outputs.push({ value: 1250n * 100000000n, script: `76a914${hash}88ac` });
  const fundingTxid = funding.txid();
  await context.route('https://services.divi.domains/**', async (route) => {
    const body = route.request().postDataJSON() || {};
    let result: unknown = null;
    switch (body.method) {
      case 'getblockcount': result = 1000; break;
      case 'getaddressutxos':
        result = body.params[0] === own ? [{ address: own, txid: fundingTxid, outputIndex: 0, script: `76a914${hash}88ac`, satoshis: 1250e8, height: 990 }] : [];
        break;
      case 'getaddressbalance': result = { balance: body.params[0] === own ? 1250e8 : 0, received: 0 }; break;
      case 'getaddresstxids': result = []; break;
      case 'validateaddress': result = { isvalid: true }; break;
      case 'getrawtransaction': result = body.params[0] === fundingTxid ? funding.toHex() : null; break;
    }
    await route.fulfill({ contentType: 'application/json', body: JSON.stringify({ jsonrpc: '2.0', id: body.id, result }) });
  });
  // A stand-in for the game site: the release build allows games.divi.domains
  await context.route(`${GAME}**`, route => route.fulfill({
    contentType: 'text/html',
    body: '<!doctype html><title>Divi Games</title><h1>Divi Games</h1>',
  }));

  const popup = await context.newPage();
  await popup.setViewportSize({ width: 360, height: 600 });
  await popup.goto(`chrome-extension://${extensionId}/popup.html`);
  await popup.click('#onboard-import-btn');
  await popup.fill('#import-name', 'Main wallet');
  await popup.fill('#import-mnemonic', MNEMONIC);
  await popup.fill('#import-password', PASSWORD);
  await popup.click('#import-submit-btn');
  await expect(popup.locator('#balance-section')).toBeVisible({ timeout: 30000 });
  await expect(popup.locator('#balance-section')).toContainText('1250', { timeout: 30000 });
  await slide(context, '1-wallet', await popupShot(popup), 'A Divi wallet in your browser',
    'Your keys stay on your device, encrypted with your password. Testnet first, with a colour bar that says which network you are on.');

  await popup.click('#send-btn');
  await popup.fill('#send-to', dest);
  await popup.fill('#send-amount', '25');
  await popup.click('#send-confirm-btn');
  await expect(popup.locator('#confirm-to')).toBeVisible();
  await slide(context, '2-send', await popupShot(popup), 'Every send is confirmed',
    'You see the recipient, amount and fee, and type your password for each payment. Spending limits are on by default.');
  await popup.click('#send-confirm-back-btn');
  await popup.click('#send-back-btn');

  // A connect and a payment request from the game site
  const page = await context.newPage();
  await page.goto(GAME);
  await page.waitForFunction(() => !!(window as any).irondivi, null, { timeout: 60000 });
  const approval = async () => {
    const seen = new Set(context.pages());
    for (const end = Date.now() + 120000; Date.now() < end; await new Promise(r => setTimeout(r, 250))) {
      const p = context.pages().find(x => !seen.has(x) && /approve=/.test(x.url()));
      if (p) { await p.waitForLoadState('domcontentloaded'); return p; }
    }
    throw new Error('no approval window opened');
  };
  let win = approval();
  void page.evaluate(() => (window as any).irondivi.connect().catch(() => {}));
  let w = await win;
  await w.setViewportSize({ width: 360, height: 760 });
  await expect(w.locator('#approve-request-btn')).toBeVisible();
  await slide(context, '3-connect', await popupShot(w), 'Sites ask first',
    'A site sees nothing until you allow it, and learns your address only when you approve its connect request.');
  await w.click('#approve-request-btn');

  win = approval();
  void page.evaluate(([to]) => (window as any).irondivi.sendTransaction({ to, amount: 5, memo: 'table 7 buy-in' }).catch(() => {}), [dest] as const);
  w = await win;
  await w.setViewportSize({ width: 360, height: 760 });
  await expect(w.locator('#signing-details')).toContainText(dest);
  await slide(context, '4-approve', await popupShot(w), 'Payments are shown, not hidden',
    'A site\'s payment request shows the site, recipient, amount, fee and memo. Nothing is signed until you approve it.');
  await w.click('#reject-request-btn');

  await popup.bringToFront();
  await popup.click('#settings-btn');
  await popup.locator('#site-access-list').scrollIntoViewIfNeeded();
  await slide(context, '5-sites', await popupShot(popup), 'You choose the sites',
    'Allow, block or forget a site at any time. Pair with a page on another device with IronDivi Connect, end-to-end encrypted.');
});
