// End-to-end: a page on an allowed site (http://127.0.0.1) against the built
// extension. A hostile page's own postMessage calls must be refused; the
// normal connect / send / sign flow through the approval popup must work.
// The testnet RPC is mocked with context.route, so nothing reaches a network
// and nothing is broadcast.
import { test as base, expect, BrowserContext, Page } from '@playwright/test';
import http from 'http';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import { AddressInfo } from 'net';
import { launchWithExtension } from './browser';
import { Address } from '../src/lib/address';
import { Mnemonic } from '../src/lib/mnemonic';
import { deriveAddresses } from '../src/lib/derivation';
import { Transaction } from '../src/lib/transaction';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const EXTENSION_PATH = process.env.EXT_PATH || path.join(__dirname, '../dist/chrome');
const SHOTS = path.join(__dirname, 'screenshots');
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

let server: http.Server;
let pageUrl: string;

test.beforeAll(async () => {
  fs.mkdirSync(SHOTS, { recursive: true });
  server = http.createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end('<!doctype html><title>dapp</title><h1>test dapp</h1>');
  });
  await new Promise<void>(r => server.listen(0, '127.0.0.1', () => r()));
  pageUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/`;
});

test.afterAll(async () => {
  server.close();
});

/** A page script posting the provider bridge message itself. */
async function rawPost(page: Page, method: string, params?: unknown): Promise<any> {
  return page.evaluate(([method, params]) => new Promise((resolve) => {
    const id = `raw-${Math.random()}`;
    window.addEventListener('message', (e) => {
      if (e.data?.type === 'IRONDIVI_PROVIDER_RESPONSE' && e.data.id === id) resolve(e.data.response);
    });
    window.postMessage({ type: 'IRONDIVI_PROVIDER_MESSAGE', id, method, params }, location.origin);
    setTimeout(() => resolve({ dropped: true }), 5000);
  }), [method, params] as const);
}

/** Click approve and wait for the site's answer, failing at once with the
 * window's error message if the wallet refused the approval. */
async function approveAndWait<T>(w: Page, answer: Promise<T>): Promise<T> {
  await w.click('#approve-request-btn');
  const refused = w.locator('#toast.error').waitFor({ timeout: 30000 })
    .then(async () => { throw new Error(`approval refused: ${await w.locator('#toast').innerText()}`); }, () => new Promise<never>(() => {}));
  return Promise.race([answer, refused]);
}

async function popupMessage(popup: Page, type: string, payload?: unknown): Promise<any> {
  return popup.evaluate(([type, payload]) => chrome.runtime.sendMessage({ type, payload }), [type, payload] as const);
}

async function setup(context: BrowserContext, extensionId: string) {
  // Fake testnet RPC for the service worker
  const own = (await deriveAddresses(await Mnemonic.toSeed(MNEMONIC), 'testnet', 0, 1))[0].address;
  const dest = (await deriveAddresses(await Mnemonic.toSeed(MNEMONIC, 'other-account'), 'testnet', 0, 1))[0].address;
  const hash = Array.from(Address.decode(own).hash, (b: number) => b.toString(16).padStart(2, '0')).join('');
  const broadcasts: string[] = [];
  // The coin's funding transaction, served raw: the wallet checks the coin
  // against it before it signs
  const funding = new Transaction();
  funding.inputs.push({ txid: '01'.repeat(32), vout: 0, script: '', sequence: 0xffffffff });
  funding.outputs.push({ value: 1000n * 100000000n, script: `76a914${hash}88ac` });
  const fundingTxid = funding.txid();
  await context.route('https://services.divi.domains/**', async (route) => {
    const body = route.request().postDataJSON() || {};
    let result: unknown = null;
    switch (body.method) {
      case 'getblockcount': result = 1000; break;
      case 'getaddressutxos':
        result = body.params[0] === own
          ? [{ address: own, txid: fundingTxid, outputIndex: 0, script: `76a914${hash}88ac`, satoshis: 1000e8, height: 990 }]
          : [];
        break;
      case 'getaddressbalance': result = { balance: body.params[0] === own ? 1000e8 : 0, received: 0 }; break;
      case 'getaddresstxids': result = []; break;
      case 'validateaddress': result = { isvalid: true }; break;
      case 'getrawtransaction': result = body.params[0] === fundingTxid && body.params[1] === 0 ? funding.toHex() : null; break;
      case 'sendrawtransaction': broadcasts.push(body.params[0]); result = Transaction.fromHex(body.params[0]).txid(); break;
    }
    await route.fulfill({ contentType: 'application/json', body: JSON.stringify({ jsonrpc: '2.0', id: body.id, result }) });
  });

  // Import the wallet in the popup and unlock a signing session
  const popup = await context.newPage();
  await popup.goto(`chrome-extension://${extensionId}/popup.html`);
  await popup.click('#onboard-import-btn');
  await popup.fill('#import-name', 'E2E');
  await popup.fill('#import-mnemonic', MNEMONIC);
  await popup.fill('#import-password', PASSWORD);
  await popup.click('#import-submit-btn');
  await expect(popup.locator('#balance-section')).toBeVisible({ timeout: 15000 });
  const accounts = await popupMessage(popup, 'GET_ACCOUNTS');
  const auth = await popupMessage(popup, 'AUTHENTICATE', { accountId: accounts.data.currentAccountId, password: PASSWORD });
  expect(auth.success).toBe(true);

  const page = await context.newPage();
  await page.goto(pageUrl);
  return { popup, page, own, dest, broadcasts };
}

test('a hostile page is refused; popup-only messages, sign and send need the user', async ({ context, extensionId }) => {
  const { popup, page, dest, broadcasts } = await setup(context, extensionId);
  const before = (await popupMessage(popup, 'GET_SETTINGS')).data.settings;

  // #2: a page cannot reach popup-only messages
  const upd = await rawPost(page, 'UPDATE_SETTINGS', { network: 'mainnet', allowedSites: ['**'] });
  console.log('UPDATE_SETTINGS from page ->', JSON.stringify(upd));
  const gen = await rawPost(page, 'GENERATE_NEW_ADDRESS', {});
  console.log('GENERATE_NEW_ADDRESS from page ->', JSON.stringify(gen));
  const after = (await popupMessage(popup, 'GET_SETTINGS')).data.settings;
  console.log('settings before/after:', before.network, JSON.stringify(before.allowedSites), '/', after.network, JSON.stringify(after.allowedSites));

  // #4: an unconnected page cannot sign or send by posting the message itself
  const sign = await rawPost(page, 'SIGN_MESSAGE', { message: 'hostile' });
  console.log('SIGN_MESSAGE from unconnected page ->', JSON.stringify(sign));
  const send = await rawPost(page, 'SEND_TRANSACTION', { to: dest, amount: 1 });
  console.log('SEND_TRANSACTION from unconnected page ->', JSON.stringify(send));
  console.log('broadcasts:', broadcasts.length);

  expect(upd.success).not.toBe(true);
  expect(gen.success).not.toBe(true);
  expect(after.network).toBe(before.network);
  expect(after.allowedSites).toEqual(before.allowedSites);
  expect(sign.success).toBe(false);
  expect(sign.data?.signature).toBeUndefined();
  expect(send.success).toBe(false);
  expect(broadcasts).toHaveLength(0);
});

test('the approved path still works: connect, send (approve and reject), sign', async ({ context, extensionId }) => {
  const { page, dest, broadcasts } = await setup(context, extensionId);
  await page.waitForFunction(() => !!(window as any).irondivi, null, { timeout: 10000 });

  // connect -> approval window -> approve
  // The page event can fire before the new window has its URL, so take the
  // next page and then wait for it to reach the approval screen
  const approval = async () => {
    const p = await context.waitForEvent('page', { timeout: 15000 });
    await p.waitForURL(/approve=/, { timeout: 15000 });
    return p;
  };
  let win = approval();
  const connected = page.evaluate(() => (window as any).irondivi.connect());
  let w = await win;
  await w.click('#approve-request-btn');
  console.log('connect ->', JSON.stringify(await connected));

  // #3: send opens the approval window showing destination, amount and fee
  win = approval();
  const sent = page.evaluate(([to]) => (window as any).irondivi.sendTransaction({ to, amount: 1.25 }), [dest] as const);
  w = await win;
  await expect(w.locator('#signing-type')).toHaveText('Send Transaction');
  await expect(w.locator('#signing-details')).toContainText(dest);
  await expect(w.locator('#signing-details')).toContainText('1.25');
  await expect(w.locator('#signing-details')).toContainText('Fee');
  await w.screenshot({ path: path.join(SHOTS, 'b10-send-approval.png') });
  console.log('approval window details:', (await w.locator('#signing-details').innerText()).replace(/\s+/g, ' '));
  console.log('broadcasts before approval:', broadcasts.length);
  expect(broadcasts).toHaveLength(0);
  await w.fill('#signing-password', PASSWORD);
  const txid = await approveAndWait(w, sent);
  console.log('sendTransaction approved -> txid', txid, 'broadcasts:', broadcasts.length);
  expect(broadcasts).toHaveLength(1);
  expect(txid).toBe(Transaction.fromHex(broadcasts[0]).txid());

  // a rejected send is not broadcast
  win = approval();
  const rejected = page.evaluate(([to]) => (window as any).irondivi.sendTransaction({ to, amount: 1 }).then(() => 'resolved', (e: Error) => `rejected: ${e.message}`), [dest] as const);
  w = await win;
  await w.click('#reject-request-btn');
  const outcome = await rejected;
  console.log('sendTransaction rejected ->', outcome, 'broadcasts:', broadcasts.length);
  expect(outcome).toMatch(/^rejected: .*rejected/i);
  expect(broadcasts).toHaveLength(1);

  // sign a message through the approval window
  win = approval();
  const signed = page.evaluate(() => (window as any).irondivi.signMessage('hello from e2e'));
  w = await win;
  await expect(w.locator('#signing-type')).toHaveText('Sign Message');
  await w.fill('#signing-password', PASSWORD);
  const sig = await approveAndWait(w, signed);
  console.log('signMessage approved -> signature', String(sig).slice(0, 16) + '...');
  expect(typeof sig).toBe('string');
  expect(String(sig).length).toBeGreaterThan(40);
});
