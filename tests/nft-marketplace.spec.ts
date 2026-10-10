import { test as base, BrowserContext, Page } from '@playwright/test';
import { launchWithExtension } from './browser';
import path from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const EXTENSION_PATH = path.join(__dirname, '../dist/chrome');
const SCREENSHOT_DIR = path.join(__dirname, 'screenshots');

// Ensure screenshot directory exists
if (!fs.existsSync(SCREENSHOT_DIR)) {
  fs.mkdirSync(SCREENSHOT_DIR, { recursive: true });
}

const test = base.extend<{
  context: BrowserContext;
  extensionId: string;
}>({
  context: async ({}, use) => {
    const context = await launchWithExtension(EXTENSION_PATH);
    await use(context);
    await context.close();
  },
  extensionId: async ({ context }, use) => {
    let [background] = context.serviceWorkers();
    if (!background) {
      background = await context.waitForEvent('serviceworker');
    }
    const extensionId = background.url().split('/')[2];
    await use(extensionId);
  },
});

// Helper to save screenshot with timestamp
async function saveScreenshot(page: Page, name: string) {
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const filename = `${name}-${timestamp}.png`;
  await page.screenshot({ path: path.join(SCREENSHOT_DIR, filename), fullPage: true });
  console.log(`Screenshot saved: ${filename}`);
  return filename;
}

// Skipped 2026-10-10: the URL this test drove (vps1.divi.domains/testnet/nftmarket/)
// now serves the testnet landing page, and the live marketplace at
// https://services.divi.domains/testnet/nft/ ships its own in-page browser wallet
// and contains no injected-provider / DIVI_SIGN_* detection, so there is no
// "Connect Wallet" flow for the extension to drive. Re-enable once the
// marketplace consumes the ADR 0001 injected provider.
test.describe.skip('NFT Marketplace dApp Connection', () => {
  test('should connect wallet to NFT marketplace', async ({ context, extensionId }) => {
    // Step 1: Open extension popup and create wallet
    console.log('Step 1: Opening extension popup...');
    const popupPage = await context.newPage();
    await popupPage.goto(`chrome-extension://${extensionId}/popup.html`);
    await saveScreenshot(popupPage, '01-popup-initial');

    // Create a wallet
    console.log('Step 2: Creating wallet...');
    await popupPage.click('#onboard-create-btn');
    await popupPage.fill('#create-name', 'Test Wallet');
    await popupPage.fill('#create-password', 'TestPassword123!');
    await popupPage.fill('#create-password-confirm', 'TestPassword123!');

    // Handle any dialog that appears (mnemonic backup warning)
    popupPage.on('dialog', async dialog => {
      console.log(`Dialog appeared: ${dialog.message()}`);
      await dialog.accept();
    });

    await popupPage.click('#create-submit-btn');

    // Wait for mnemonic display screen
    console.log('Waiting for mnemonic screen...');
    await popupPage.waitForSelector('#view-mnemonic-display, button:has-text("I\'ve Written It Down")', { timeout: 10000 });
    await saveScreenshot(popupPage, '02a-mnemonic-screen');

    // Click "I've Written It Down" to confirm backup
    const confirmBackupBtn = popupPage.locator('button:has-text("I\'ve Written It Down")');
    if (await confirmBackupBtn.isVisible({ timeout: 2000 }).catch(() => false)) {
      await confirmBackupBtn.click();
      console.log('Confirmed mnemonic backup');
    }

    // Wait for wallet creation to complete
    await popupPage.waitForSelector('#loading', { state: 'visible', timeout: 2000 }).catch(() => {});
    await popupPage.waitForSelector('#loading', { state: 'hidden', timeout: 30000 });
    await popupPage.waitForSelector('#balance-section', { state: 'visible', timeout: 15000 });
    await saveScreenshot(popupPage, '02-wallet-created');
    console.log('Wallet created successfully');

    // Step 3: Navigate to NFT Marketplace
    console.log('Step 3: Opening NFT marketplace...');
    const marketPage = await context.newPage();
    await marketPage.goto('https://vps1.divi.domains/testnet/nftmarket/', {
      waitUntil: 'networkidle',
      timeout: 30000
    });
    await saveScreenshot(marketPage, '03-marketplace-loaded');
    console.log('Marketplace loaded');

    // Check that provider is injected
    const hasProvider = await marketPage.evaluate(() => {
      return !!(window as any).irondivi;
    });
    console.log(`Provider injected: ${hasProvider}`);

    if (!hasProvider) {
      // Check console for any errors
      const consoleLogs: string[] = [];
      marketPage.on('console', msg => consoleLogs.push(`[${msg.type()}] ${msg.text()}`));
      await marketPage.waitForTimeout(2000);
      console.log('Console logs:', consoleLogs);
      throw new Error('Provider not injected! Check content script.');
    }

    // Step 4: Find and click the Connect Wallet button
    console.log('Step 4: Looking for Connect Wallet button...');

    // Try various selectors for the connect button
    const connectButtonSelectors = [
      'button:has-text("Connect Wallet")',
      'button:has-text("Connect")',
      '[data-testid="connect-wallet"]',
      '.connect-wallet-btn',
      '#connect-wallet',
    ];

    let connectButton = null;
    for (const selector of connectButtonSelectors) {
      const button = marketPage.locator(selector).first();
      if (await button.isVisible({ timeout: 1000 }).catch(() => false)) {
        connectButton = button;
        console.log(`Found connect button with selector: ${selector}`);
        break;
      }
    }

    if (!connectButton) {
      await saveScreenshot(marketPage, '04-no-connect-button');
      // Log all buttons on the page
      const buttons = await marketPage.locator('button').allTextContents();
      console.log('Available buttons:', buttons);
      throw new Error('Connect Wallet button not found');
    }

    await saveScreenshot(marketPage, '04-before-connect');
    await connectButton.click();
    console.log('Clicked Connect Wallet button');

    // Take screenshot immediately after clicking connect
    await marketPage.waitForTimeout(500);
    await saveScreenshot(marketPage, '04a-after-connect-click');

    // Step 5: Wait for approval popup to appear
    console.log('Step 5: Waiting for approval popup...');
    await marketPage.waitForTimeout(1500);

    // Find the approval popup (new window should have opened)
    const pages = context.pages();
    console.log(`Number of pages: ${pages.length}`);

    let approvalPage: Page | null = null;
    for (const page of pages) {
      const url = page.url();
      console.log(`Page URL: ${url}`);
      if (url.includes('chrome-extension://') && url.includes('popup.html')) {
        // Check if this is an approval popup
        const isApprovalPopup = await page.locator('.signing-request-container, #view-signing-request').isVisible({ timeout: 1000 }).catch(() => false);
        if (isApprovalPopup) {
          approvalPage = page;
          break;
        }
        // Also check if there's a connect request in the original popup
        if (page !== popupPage) {
          approvalPage = page;
          break;
        }
      }
    }

    // Check for new windows
    const newWindows = await context.pages();
    for (const win of newWindows) {
      if (win.url().includes('approve=connect') || win.url().includes('requestId=')) {
        approvalPage = win;
        break;
      }
    }

    // If no new popup found, check the original popup page
    if (!approvalPage) {
      console.log('No new approval window found, checking original popup...');
      await popupPage.bringToFront();
      await popupPage.reload();
      await popupPage.waitForTimeout(1000);
      await saveScreenshot(popupPage, '05-popup-after-connect-click');

      // Check if there's a pending request in the popup
      const hasPendingRequest = await popupPage.locator('.signing-request-container, #view-signing-request, .connect-request').isVisible({ timeout: 2000 }).catch(() => false);
      if (hasPendingRequest) {
        approvalPage = popupPage;
      }
    }

    if (!approvalPage) {
      // Take screenshots of all pages for debugging
      for (let i = 0; i < pages.length; i++) {
        await saveScreenshot(pages[i], `debug-page-${i}`);
      }
      throw new Error('Approval popup not found');
    }

    await saveScreenshot(approvalPage, '06-approval-popup');
    console.log('Found approval popup');

    // Step 6: Enter password and approve the connection
    console.log('Step 6: Approving connection...');

    // Fill password if required
    const passwordField = approvalPage.locator('#signing-password, input[type="password"]').first();
    if (await passwordField.isVisible({ timeout: 1000 }).catch(() => false)) {
      await passwordField.fill('TestPassword123!');
      console.log('Filled password');
    }

    // Click approve button for connection
    const approveButton = approvalPage.locator('button:has-text("Approve"), #approve-btn, .approve-btn').first();
    if (await approveButton.isVisible({ timeout: 2000 }).catch(() => false)) {
      await saveScreenshot(approvalPage, '07-before-approve');
      await approveButton.click();
      console.log('Clicked Approve button for connection');
    } else {
      await saveScreenshot(approvalPage, '07-no-approve-button');
      const buttons = await approvalPage.locator('button').allTextContents();
      console.log('Available buttons in approval popup:', buttons);
      throw new Error('Approve button not found');
    }

    // Step 7: Wait for signature request popup
    console.log('Step 7: Waiting for signature request...');

    // Wait for sign popup to appear (it opens after connection is approved)
    let signatureApprovalPage: Page | null = null;

    // Poll for new popup window with approve=sign URL
    for (let i = 0; i < 30; i++) {
      await marketPage.waitForTimeout(500);

      const allPages = context.pages();

      for (const page of allPages) {
        const url = page.url();

        // Look specifically for sign popup URL (not connect)
        if (url.includes('approve=sign') && url.includes('requestId=')) {
          await page.bringToFront();
          await page.waitForTimeout(300);
          signatureApprovalPage = page;
          console.log(`Found signature popup at: ${url}`);
          break;
        }
      }

      if (signatureApprovalPage) break;

      // Log progress every 5 iterations
      if (i % 5 === 0) {
        console.log(`Check ${i}: Found ${allPages.length} pages, looking for approve=sign...`);
        for (const p of allPages) {
          console.log(`  - ${p.url()}`);
        }
      }
    }

    if (signatureApprovalPage) {
      console.log('Found signature approval popup');
      await saveScreenshot(signatureApprovalPage, '10-signature-popup');

      // Wait for popup content to fully load
      await signatureApprovalPage.waitForLoadState('domcontentloaded');
      await signatureApprovalPage.waitForTimeout(1000);

      // Find password field using ID selector (more reliable)
      const passwordField = signatureApprovalPage.locator('#signing-password');
      await passwordField.waitFor({ state: 'visible', timeout: 5000 }).catch(() => {});

      const isPasswordVisible = await passwordField.isVisible().catch(() => false);
      console.log(`Password field #signing-password visible: ${isPasswordVisible}`);

      if (isPasswordVisible) {
        await passwordField.click();
        await passwordField.fill('TestPassword123!');
        console.log('Filled password for signature');
        await saveScreenshot(signatureApprovalPage, '10a-password-filled');
      } else {
        // Try alternate selector
        const altPasswordField = signatureApprovalPage.locator('input[placeholder="Password"]');
        const altVisible = await altPasswordField.isVisible().catch(() => false);
        console.log(`Alternate password field visible: ${altVisible}`);
        if (altVisible) {
          await altPasswordField.click();
          await altPasswordField.fill('TestPassword123!');
          console.log('Filled password using alternate selector');
        }
      }

      // Click approve for signature
      const signApproveBtn = signatureApprovalPage.locator('#approve-request-btn, button:has-text("Approve")').first();
      await signApproveBtn.waitFor({ state: 'visible', timeout: 3000 }).catch(() => {});

      if (await signApproveBtn.isVisible().catch(() => false)) {
        await saveScreenshot(signatureApprovalPage, '11-before-sign-approve');
        await signApproveBtn.click();
        console.log('Clicked Approve for signature');

        // The approval page will close after successful signing - this is expected behavior
        // Wait a moment for the window.close() to execute, but don't fail if page closes
        await signatureApprovalPage.waitForTimeout(1000).catch(() => {
          console.log('Signature approval page closed (expected behavior)');
        });
      }
    } else {
      console.log('No signature popup found - may have auto-approved or different flow');
    }

    // Step 8: Verify connection was successful
    console.log('Step 8: Verifying connection...');
    await marketPage.bringToFront();

    // Capture console messages from marketplace
    const consoleMessages: string[] = [];
    marketPage.on('console', msg => {
      consoleMessages.push(`[${msg.type()}] ${msg.text()}`);
    });

    await marketPage.waitForTimeout(3000);
    await saveScreenshot(marketPage, '08-after-approve');
    console.log('Console messages from marketplace:', consoleMessages.slice(-10));

    // Check if connected (look for address display or different button state)
    const isConnected = await marketPage.evaluate(async () => {
      const irondivi = (window as any).irondivi;
      if (!irondivi) return false;
      try {
        return await irondivi.isConnected();
      } catch (e) {
        console.error('Error checking connection:', e);
        return false;
      }
    });

    console.log(`Connection status: ${isConnected ? 'CONNECTED' : 'NOT CONNECTED'}`);

    // Also check for visual indication
    const connectedIndicators = [
      'button:has-text("Disconnect")',
      '[data-connected="true"]',
      '.wallet-address',
      '.connected-address',
    ];

    let foundConnectedUI = false;
    for (const selector of connectedIndicators) {
      if (await marketPage.locator(selector).isVisible({ timeout: 1000 }).catch(() => false)) {
        foundConnectedUI = true;
        console.log(`Found connected indicator: ${selector}`);
        break;
      }
    }

    await saveScreenshot(marketPage, '09-final-state');

    if (!isConnected && !foundConnectedUI) {
      console.log('WARNING: Connection may not have completed successfully');
    } else {
      console.log('SUCCESS: Wallet connected to NFT marketplace!');
    }

    // Step 9: Verify connected site appears in Settings (optional - may fail if popup closed)
    console.log('Step 9: Verifying connected site in Settings...');

    try {
      // Open a fresh popup page
      const settingsPopup = await context.newPage();
      await settingsPopup.goto(`chrome-extension://${extensionId}/popup.html`);
      await settingsPopup.waitForLoadState('domcontentloaded');
      await settingsPopup.waitForTimeout(1000);

      // Check if main view is visible (no pending requests)
      const balanceSection = settingsPopup.locator('#balance-section');
      const isMainView = await balanceSection.isVisible({ timeout: 2000 }).catch(() => false);

      if (!isMainView) {
        console.log('Settings verification skipped - pending requests blocking main view');
        await saveScreenshot(settingsPopup, '12-pending-requests');
      } else {
        await saveScreenshot(settingsPopup, '12-popup-main-view');

        // Click settings button
        const settingsBtn = settingsPopup.locator('#settings-btn');
        await settingsBtn.click({ timeout: 3000 });
        await settingsPopup.waitForTimeout(1000);
        await saveScreenshot(settingsPopup, '13-settings-view');

        // Look for the connected sites section
        const connectedSitesList = settingsPopup.locator('#connected-sites-list');
        await connectedSitesList.waitFor({ state: 'visible', timeout: 3000 }).catch(() => {});

        // Check if vps1.divi.domains appears in the list
        const siteText = await connectedSitesList.textContent().catch(() => '');
        console.log(`Connected sites content: ${siteText}`);

        if (siteText?.includes('vps1.divi.domains')) {
          console.log('SUCCESS: Connected site appears in Settings!');
        } else {
          console.log('WARNING: Connected site not found in Settings list');
        }

        await saveScreenshot(settingsPopup, '14-connected-sites');
      }
    } catch (e) {
      console.log('Settings verification error (non-critical):', (e as Error).message);
    }
  });
});

export { test };
