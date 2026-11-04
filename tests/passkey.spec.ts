import { test as base, expect, BrowserContext, Page, CDPSession } from '@playwright/test';
import http from 'http';
import { AddressInfo } from 'net';
import { launchWithExtension } from './browser';
import { DEV_EXTENSION_PATH } from './global-setup';
import { Address } from '../src/lib/address';
import { Mnemonic } from '../src/lib/mnemonic';
import { deriveAddresses } from '../src/lib/derivation';
import { Transaction } from '../src/lib/transaction';
import { PRF_UNSUPPORTED_ERROR } from '../src/popup/passkey-client';

const EXTENSION_PATH = process.env.EXT_PATH || DEV_EXTENSION_PATH;
const MNEMONIC = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
const PASSWORD = 'PasskeyE2ePassword123!';
// Deterministic 33-byte compressed secp256k1 public key for Player Certificate signing
const SAMPLE_PLAYER_PUBKEY = '0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798';

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
let dappUrl: string;

test.beforeAll(async () => {
  server = http.createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end('<!doctype html><title>Passkey dApp</title><h1>Passkey Test dApp</h1>');
  });
  await new Promise<void>(r => server.listen(0, '127.0.0.1', () => r()));
  dappUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/`;
});

test.afterAll(async () => {
  server.close();
});

async function waitForExtensionWindow(
  context: BrowserContext,
  seen: Set<Page>,
  urlPattern: RegExp,
): Promise<Page> {
  for (const end = Date.now() + 30000; Date.now() < end; await new Promise(r => setTimeout(r, 100))) {
    const found = context.pages().find(p => !seen.has(p) && urlPattern.test(p.url()));
    if (found) {
      await found.waitForLoadState('domcontentloaded');
      return found;
    }
  }
  throw new Error(`Timed out waiting for extension window matching ${urlPattern}`);
}

async function addVirtualAuthenticator(
  context: BrowserContext,
  page: Page,
  hasPrf: boolean,
): Promise<{ cdp: CDPSession; authenticatorId: string }> {
  const cdp = await context.newCDPSession(page);
  await cdp.send('WebAuthn.enable', { enableUI: false });
  const { authenticatorId } = await cdp.send('WebAuthn.addVirtualAuthenticator', {
    options: {
      protocol: 'ctap2',
      ctap2Version: 'ctap2_1',
      transport: 'internal',
      hasResidentKey: true,
      hasUserVerification: true,
      isUserVerified: true,
      automaticPresenceSimulation: true,
      hasPrf,
    },
  });
  return { cdp, authenticatorId };
}

async function setupMockChainAndWallet(context: BrowserContext, extensionId: string) {
  const own = (await deriveAddresses(await Mnemonic.toSeed(MNEMONIC), 'testnet', 0, 1))[0].address;
  const dest = (await deriveAddresses(await Mnemonic.toSeed(MNEMONIC, 'dest-wallet'), 'testnet', 0, 1))[0].address;
  const hash = Array.from(Address.decode(own).hash, (b: number) => b.toString(16).padStart(2, '0')).join('');
  const broadcasts: string[] = [];

  const funding = new Transaction();
  funding.inputs.push({ txid: '02'.repeat(32), vout: 0, script: '', sequence: 0xffffffff });
  funding.outputs.push({ value: 1000n * 100000000n, script: `76a914${hash}88ac` });
  funding.outputs.push({ value: 1000n * 100000000n, script: `76a914${hash}88ac` });
  const fundingTxid = funding.txid();

  await context.route('https://services.divi.domains/**', async route => {
    const body = route.request().postDataJSON() || {};
    let result: unknown = null;
    switch (body.method) {
      case 'getblockcount':
        result = 1000;
        break;
      case 'getaddressutxos':
        result = body.params[0] === own
          ? [0, 1].map(outputIndex => ({
              address: own,
              txid: fundingTxid,
              outputIndex,
              script: `76a914${hash}88ac`,
              satoshis: 1000e8,
              height: 990,
            }))
          : [];
        break;
      case 'getaddressbalance':
        result = { balance: body.params[0] === own ? 2000e8 : 0, received: 0 };
        break;
      case 'getaddresstxids':
        result = [];
        break;
      case 'validateaddress':
        result = { isvalid: true };
        break;
      case 'getrawtransaction':
        result = body.params[0] === fundingTxid && body.params[1] === 0 ? funding.toHex() : null;
        break;
      case 'sendrawtransaction':
        broadcasts.push(body.params[0]);
        result = Transaction.fromHex(body.params[0]).txid();
        break;
    }
    await route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({ jsonrpc: '2.0', id: body.id, result }),
    });
  });

  const popup = await context.newPage();
  await popup.goto(`chrome-extension://${extensionId}/popup.html`);
  await popup.click('#onboard-import-btn');
  await popup.fill('#import-name', 'Passkey Wallet');
  await popup.fill('#import-mnemonic', MNEMONIC);
  await popup.fill('#import-password', PASSWORD);
  await popup.click('#import-submit-btn');
  await expect(popup.locator('#balance-section')).toBeVisible({ timeout: 20000 });

  const [sw] = context.serviceWorkers();
  for (const end = Date.now() + 60000; Date.now() < end; ) {
    const t = Date.now();
    await sw.evaluate(() => 1);
    if (Date.now() - t < 250) break;
  }

  return { popup, own, dest, broadcasts };
}

test('full passkey lifecycle: enrol, lock/unlock, send, sign player cert, dApp approve, remove & password fallback', async ({
  context,
  extensionId,
}) => {
  const { popup, dest, broadcasts } = await setupMockChainAndWallet(context, extensionId);
  const { cdp, authenticatorId } = await addVirtualAuthenticator(context, popup, true);

  // 1. Enrol a WebAuthn PRF passkey in Settings -> Security
  await popup.click('#settings-btn');
  await expect(popup.getByTestId('passkeys-section')).toBeVisible();
  await popup.fill('#new-passkey-label', 'Touch ID E2E');
  await popup.getByTestId('add-passkey-btn').click();

  await expect(popup.locator('#password-modal')).toBeVisible();
  await popup.fill('#password-modal-input', PASSWORD);
  await popup.click('#password-modal-submit');

  await expect(popup.locator('#passkeys-list')).toContainText('Touch ID E2E', { timeout: 15000 });
  await expect(popup.getByTestId('remove-passkey-btn')).toBeVisible();

  // Verify extension origin RP ID binding on the virtual authenticator
  const { credentials } = await cdp.send('WebAuthn.getCredentials', { authenticatorId });
  expect(credentials).toHaveLength(1);
  expect(credentials[0].rpId).toContain(extensionId);

  await popup.click('#settings-back-btn');
  await expect(popup.locator('#balance-section')).toBeVisible();

  // 2. Lock wallet and unlock with passkey
  await popup.getByTestId('lock-wallet-btn').click();
  await expect(popup.locator('#unlock-modal')).toBeVisible();
  await expect(popup.getByTestId('unlock-passkey-btn')).toBeVisible();
  await popup.getByTestId('unlock-passkey-btn').click();
  await expect(popup.locator('#unlock-modal')).toBeHidden({ timeout: 15000 });

  // 3. Send DIVI using Verify with Passkey
  await popup.click('#send-btn');
  await expect(popup.locator('#view-send')).toBeVisible();
  await popup.fill('#send-to', dest);
  await popup.fill('#send-amount', '12.5');
  await popup.click('#send-confirm-btn');

  await expect(popup.locator('#view-send-confirm')).toBeVisible();
  await expect(popup.getByTestId('reauth-passkey-btn')).toBeVisible();
  await popup.getByTestId('reauth-passkey-btn').click();

  await expect(popup.locator('#view-send-confirm')).toBeHidden({ timeout: 15000 });
  expect(broadcasts).toHaveLength(1);

  // 4. Sign Player Certificate using Verify with Passkey in the re-auth modal
  await popup.click('#player-cert-btn');
  await expect(popup.locator('#view-player-cert')).toBeVisible();
  await popup.fill('#player-cert-key-input', SAMPLE_PLAYER_PUBKEY);
  await expect(popup.locator('#player-cert-sign-btn')).toBeEnabled();
  await popup.click('#player-cert-sign-btn');

  await expect(popup.locator('#password-modal')).toBeVisible();
  await expect(popup.getByTestId('reauth-passkey-btn')).toBeVisible();
  await popup.getByTestId('reauth-passkey-btn').click();

  await expect(popup.locator('#player-cert-result')).toBeVisible({ timeout: 15000 });
  await popup.click('#player-cert-back-btn');

  // 5. dApp connect + signMessage approved via "Approve with Passkey"
  const dappPage = await context.newPage();
  await dappPage.goto(dappUrl);
  await dappPage.waitForFunction(() => Boolean((window as any).irondivi), null, { timeout: 15000 });

  const seenBeforeConnect = new Set(context.pages());
  const connectCall = dappPage.evaluate(() => (window as any).irondivi.connect());
  const connectWin = await waitForExtensionWindow(context, seenBeforeConnect, /approve=/);
  await expect(connectWin.locator('#approve-request-btn')).toBeEnabled({ timeout: 10000 });
  await connectWin.click('#approve-request-btn');
  const connected = await connectCall;
  expect(connected.connected).toBe(true);

  const seenBeforeSign = new Set(context.pages());
  const signCall = dappPage.evaluate(() =>
    (window as any).irondivi.signMessage('Verify ownership with passkey'),
  );
  const signWin = await waitForExtensionWindow(context, seenBeforeSign, /approve=/);
  // Approve from our popup tab which holds the CDP virtual authenticator credential,
  // exercising #approve-passkey-btn in signing-request-ui.ts!
  const signUrl = new URL(signWin.url());
  const reqId = signUrl.searchParams.get('requestId')!;
  await popup.goto(`chrome-extension://${extensionId}/popup.html?approve=sign_message&requestId=${reqId}`);

  const approvePasskeyBtn = popup.getByTestId('approve-passkey-btn');
  await expect(approvePasskeyBtn).toBeVisible();
  await expect(approvePasskeyBtn).toBeEnabled({ timeout: 10000 });
  // Prevent window.close() from destroying our popup tab during test
  await popup.evaluate(() => {
    window.close = () => {};
  });
  await approvePasskeyBtn.click();

  const signResult = await signCall;
  expect(typeof signResult).toBe('string');
  expect(String(signResult).length).toBeGreaterThan(40);
  if (!signWin.isClosed()) await signWin.close();

  // Navigate back to normal popup view
  await popup.goto(`chrome-extension://${extensionId}/popup.html`);
  await expect(popup.locator('#balance-section')).toBeVisible({ timeout: 15000 });

  // 6. Remove Passkey -> verify passkey buttons disappear and password still unlocks & exports
  await popup.click('#settings-btn');
  await expect(popup.getByTestId('remove-passkey-btn')).toBeVisible();
  await popup.getByTestId('remove-passkey-btn').click();

  await expect(popup.locator('#password-modal')).toBeVisible();
  await popup.getByTestId('reauth-passkey-btn').click();
  await expect(popup.locator('#passkeys-list')).toContainText('No passkeys enrolled', { timeout: 15000 });

  // Export phrase now shows password-only modal (no passkey button) and succeeds with password
  await popup.click('#export-mnemonic-btn');
  await expect(popup.locator('#password-modal')).toBeVisible();
  await expect(popup.getByTestId('reauth-passkey-btn')).toHaveCount(0);
  await popup.fill('#password-modal-input', PASSWORD);
  await popup.click('#password-modal-submit');
  await expect(popup.locator('#mnemonic-modal')).toBeVisible({ timeout: 15000 });
  await popup.click('#mnemonic-confirm-btn');
});

test('standalone passkey.html ceremony window completes enrolment without toolbar popup state, and non-PRF authenticators are rejected clearly', async ({
  context,
  extensionId,
}) => {
  const { popup } = await setupMockChainAndWallet(context, extensionId);

  // Part A: Non-PRF authenticator (hasPrf: false) is rejected with exact actionable message
  const { cdp: noPrfCdp, authenticatorId: noPrfId } = await addVirtualAuthenticator(
    context,
    popup,
    false,
  );
  await popup.click('#settings-btn');
  await popup.getByTestId('add-passkey-btn').click();
  await popup.fill('#password-modal-input', PASSWORD);
  await popup.click('#password-modal-submit');

  await expect(popup.locator('#toast.error')).toContainText(PRF_UNSUPPORTED_ERROR, {
    timeout: 15000,
  });
  await expect(popup.locator('#passkeys-list')).toContainText('No passkeys enrolled');
  await noPrfCdp.send('WebAuthn.removeVirtualAuthenticator', { authenticatorId: noPrfId });

  // Part B: Simulate transient toolbar popup (?ceremonyWindow=1) -> opens standalone passkey.html
  await popup.goto(`chrome-extension://${extensionId}/popup.html?ceremonyWindow=1`);
  await expect(popup.locator('#balance-section')).toBeVisible({ timeout: 15000 });
  await popup.click('#settings-btn');

  const seenBeforeCeremony = new Set(context.pages());
  await popup.fill('#new-passkey-label', 'Standalone Window Key');
  await popup.getByTestId('add-passkey-btn').click();
  await popup.fill('#password-modal-input', PASSWORD);
  await popup.click('#password-modal-submit');

  const ceremonyPage = await waitForExtensionWindow(
    context,
    seenBeforeCeremony,
    /\/passkey\.html\?mode=enrol&token=/,
  );
  expect(ceremonyPage.url()).toContain('/passkey.html?mode=enrol&token=');
  await addVirtualAuthenticator(context, ceremonyPage, true);

  await expect(ceremonyPage.getByTestId('passkey-ceremony-btn')).toBeVisible();
  await ceremonyPage.getByTestId('passkey-ceremony-btn').click();
  await expect(ceremonyPage.locator('#passkey-status')).toContainText('Passkey added!', {
    timeout: 15000,
  });

  // Toolbar popup automatically refreshes its passkeys list via PASSKEY_CEREMONY_DONE!
  await expect(popup.locator('#passkeys-list')).toContainText('Standalone Window Key', {
    timeout: 15000,
  });
});
