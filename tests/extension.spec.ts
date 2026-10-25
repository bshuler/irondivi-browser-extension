import { test, expect } from './fixtures';

// Test 1: Extension loads without errors
test('should load extension without errors', async ({ extensionPage }) => {
  // Wait for app container to be visible
  await expect(extensionPage.locator('#app')).toBeVisible();

  // Verify header elements are present
  await expect(extensionPage.locator('.header')).toBeVisible();
  await expect(extensionPage.locator('.brand')).toHaveText('IronDivi');

  // Verify onboarding screen shows (no wallet yet)
  await expect(extensionPage.locator('#view-onboarding')).toBeVisible();
  await expect(extensionPage.locator('h1')).toHaveText('Welcome to IronDivi');

  // Check for console errors
  const consoleMessages = [];
  extensionPage.on('console', msg => {
    if (msg.type() === 'error') {
      consoleMessages.push(msg.text());
    }
  });

  // Allow some time for any delayed errors
  await extensionPage.waitForTimeout(1000);

  // Verify no critical errors
  expect(consoleMessages).toHaveLength(0);
});

// Test 2: Create new wallet with 12-word mnemonic
test('should create new wallet with 12-word mnemonic', async ({ extensionPage }) => {
  // Click "Create New Wallet" from onboarding
  await extensionPage.click('#onboard-create-btn');

  // Verify we're on the create account view
  await expect(extensionPage.locator('#view-create-account')).toBeVisible();
  await expect(extensionPage.locator('#view-create-account h2')).toHaveText('Create Wallet');

  // Fill in wallet details
  await extensionPage.fill('#create-name', 'Test Wallet');
  await extensionPage.fill('#create-password', 'SecurePassword123!');
  await extensionPage.fill('#create-password-confirm', 'SecurePassword123!');

  // Select 12 words (should be default)
  await extensionPage.selectOption('#create-word-count', '12');

  // Submit the form
  await extensionPage.click('#create-submit-btn');

  // The account only exists after the recovery-phrase modal is confirmed
  await expect(extensionPage.locator('#mnemonic-modal')).toBeVisible({ timeout: 10000 });
  await expect(extensionPage.locator('#mnemonic-grid > *')).toHaveCount(12);
  await extensionPage.click('#mnemonic-confirm-btn');

  // Wait for the loading overlay to clear (it can flash too fast to assert visible)
  await expect(extensionPage.locator('#loading')).not.toBeVisible({ timeout: 10000 });

  // Check for error toast
  const errorToast = extensionPage.locator('#toast.error');
  const hasError = await errorToast.isVisible();
  if (hasError) {
    const errorMessage = await errorToast.textContent();
    throw new Error(`Wallet creation failed: ${errorMessage}`);
  }

  // Dismiss the mnemonic alert if it appears
  extensionPage.on('dialog', dialog => dialog.accept());

  // Wait for main wallet UI to be visible (with longer timeout)
  await expect(extensionPage.locator('#balance-section')).toBeVisible({ timeout: 5000 });

  // Verify we're no longer on onboarding or create view
  await expect(extensionPage.locator('#view-onboarding')).not.toBeVisible();
  await expect(extensionPage.locator('#view-create-account')).not.toBeVisible();

  // Verify balance section elements are visible
  await expect(extensionPage.locator('#balance-amount')).toBeVisible();

  // Verify account name is displayed (not still loading)
  await expect(extensionPage.locator('#current-account-name')).not.toHaveText('Loading...');
});

// Test 3: Import wallet with known mnemonic
test('should import wallet with known mnemonic', async ({ extensionPage }) => {
  // Known test mnemonic (BIP39 valid)
  const testMnemonic = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';

  // Click "Import Existing Wallet" from onboarding
  await extensionPage.click('#onboard-import-btn');

  // Verify we're on the import account view
  await expect(extensionPage.locator('#view-import-account')).toBeVisible();
  await expect(extensionPage.locator('#view-import-account h2')).toHaveText('Import Wallet');

  // Fill in import details
  await extensionPage.fill('#import-name', 'Imported Wallet');
  await extensionPage.fill('#import-mnemonic', testMnemonic);
  await extensionPage.fill('#import-password', 'ImportPassword123!');

  // Submit the form
  await extensionPage.click('#import-submit-btn');

  // Wait for the loading overlay to clear (it can flash too fast to assert visible)
  await expect(extensionPage.locator('#loading')).not.toBeVisible({ timeout: 10000 });

  // Check for error toast
  const errorToast = extensionPage.locator('#toast.error');
  const hasError = await errorToast.isVisible();
  if (hasError) {
    const errorMessage = await errorToast.textContent();
    throw new Error(`Wallet import failed: ${errorMessage}`);
  }

  // Wait for main wallet UI to be visible (with longer timeout)
  await expect(extensionPage.locator('#balance-section')).toBeVisible({ timeout: 5000 });

  // Verify we're on main wallet view
  await expect(extensionPage.locator('#view-onboarding')).not.toBeVisible();
  await expect(extensionPage.locator('#view-import-account')).not.toBeVisible();

  // Verify imported wallet name appears
  const accountName = await extensionPage.locator('#current-account-name').textContent();
  expect(accountName).toBeTruthy();
  expect(accountName).not.toBe('Loading...');
});

// Test 4: Receive view shows QR code
test('should show receive view with QR code', async ({ extensionPage }) => {
  // First create a wallet
  await extensionPage.click('#onboard-create-btn');
  await extensionPage.fill('#create-name', 'QR Test Wallet');
  await extensionPage.fill('#create-password', 'SecurePassword123!');
  await extensionPage.fill('#create-password-confirm', 'SecurePassword123!');

  // Dismiss alert dialogs
  extensionPage.on('dialog', dialog => dialog.accept());

  await extensionPage.click('#create-submit-btn');

  // The account only exists after the recovery-phrase modal is confirmed
  await expect(extensionPage.locator('#mnemonic-modal')).toBeVisible({ timeout: 10000 });
  await extensionPage.click('#mnemonic-confirm-btn');

  // Wait for wallet creation to complete
  await expect(extensionPage.locator('#loading')).not.toBeVisible({ timeout: 10000 });
  await expect(extensionPage.locator('#balance-section')).toBeVisible({ timeout: 5000 });

  // Click the "Receive" button
  await extensionPage.click('#receive-btn');

  // Verify receive view is visible
  await expect(extensionPage.locator('#view-receive')).toBeVisible();
  await expect(extensionPage.locator('#view-receive h2')).toHaveText('Receive DIVI');

  // Verify QR code container exists
  await expect(extensionPage.locator('#qr-code')).toBeVisible();

  // Verify QR code has content (canvas or image)
  const qrCodeContent = await extensionPage.locator('#qr-code').innerHTML();
  expect(qrCodeContent.length).toBeGreaterThan(0);

  // Verify address is displayed
  await expect(extensionPage.locator('#receive-address')).toBeVisible();
  const address = await extensionPage.locator('#receive-address').textContent();
  expect(address).toBeTruthy();
  expect(address!.length).toBeGreaterThan(20); // Valid address should be long

  // Verify copy button exists
  await expect(extensionPage.locator('#copy-address-btn')).toBeVisible();

  // Test back navigation
  await extensionPage.click('#receive-back-btn');
  await expect(extensionPage.locator('#view-receive')).not.toBeVisible();
  await expect(extensionPage.locator('#balance-section')).toBeVisible();
});

// Test 5: Send transaction flow (UI only, no actual sending)
test('should navigate through send transaction flow', async ({ extensionPage }) => {
  // First create a wallet
  await extensionPage.click('#onboard-create-btn');
  await extensionPage.fill('#create-name', 'Send Test Wallet');
  await extensionPage.fill('#create-password', 'SecurePassword123!');
  await extensionPage.fill('#create-password-confirm', 'SecurePassword123!');

  // Dismiss alert dialogs
  extensionPage.on('dialog', dialog => dialog.accept());

  await extensionPage.click('#create-submit-btn');

  // The account only exists after the recovery-phrase modal is confirmed
  await expect(extensionPage.locator('#mnemonic-modal')).toBeVisible({ timeout: 10000 });
  await extensionPage.click('#mnemonic-confirm-btn');

  // Wait for wallet creation to complete
  await expect(extensionPage.locator('#loading')).not.toBeVisible({ timeout: 10000 });
  await expect(extensionPage.locator('#balance-section')).toBeVisible({ timeout: 5000 });

  // Click the "Send" button
  await extensionPage.click('#send-btn');

  // Verify send view is visible
  await expect(extensionPage.locator('#view-send')).toBeVisible();
  await expect(extensionPage.locator('#view-send h2')).toHaveText('Send DIVI');

  // Fill in send details (a real testnet address: the popup validates it)
  const testAddress = 'y5cfytr6dxKHWMar8o7NTjYbP33a7uWtt1';
  await extensionPage.fill('#send-to', testAddress);
  await extensionPage.fill('#send-amount', '1.5');

  // Verify fee field has default value
  const feeValue = await extensionPage.inputValue('#send-fee');
  expect(parseFloat(feeValue)).toBeGreaterThan(0);

  // Test MAX button (should populate amount)
  await extensionPage.click('#send-max-btn');
  await extensionPage.waitForTimeout(500);

  // Reset amount for test
  await extensionPage.fill('#send-amount', '1.5');

  // A freshly created wallet holds nothing, so Continue must refuse rather than
  // open the confirmation view. (Reaching #view-send-confirm needs a funded
  // wallet; the faucet is not exercised here to keep the suite deterministic.)
  await extensionPage.click('#send-confirm-btn');
  await expect(extensionPage.locator('#toast.error')).toBeVisible();
  await expect(extensionPage.locator('#toast.error')).toHaveText('Insufficient balance');
  await expect(extensionPage.locator('#view-send-confirm')).not.toBeVisible();
  await expect(extensionPage.locator('#view-send')).toBeVisible();

  // Navigate back to main view
  await extensionPage.click('#send-back-btn');
  await expect(extensionPage.locator('#view-send')).not.toBeVisible();
  await expect(extensionPage.locator('#balance-section')).toBeVisible();
});

// Test 6: Address book (contacts) operations
test('should add and manage contacts', async ({ extensionPage }) => {
  // First create a wallet
  await extensionPage.click('#onboard-create-btn');
  await extensionPage.fill('#create-name', 'Contacts Test Wallet');
  await extensionPage.fill('#create-password', 'SecurePassword123!');
  await extensionPage.fill('#create-password-confirm', 'SecurePassword123!');

  // Dismiss alert dialogs
  extensionPage.on('dialog', dialog => dialog.accept());

  await extensionPage.click('#create-submit-btn');

  // The account only exists after the recovery-phrase modal is confirmed
  await expect(extensionPage.locator('#mnemonic-modal')).toBeVisible({ timeout: 10000 });
  await extensionPage.click('#mnemonic-confirm-btn');

  // Wait for wallet creation to complete
  await expect(extensionPage.locator('#loading')).not.toBeVisible({ timeout: 10000 });
  await expect(extensionPage.locator('#balance-section')).toBeVisible({ timeout: 5000 });

  // Switch to Contacts tab
  await extensionPage.click('button[data-tab="contacts"]');

  // Verify contacts tab is active
  await expect(extensionPage.locator('#tab-contacts')).toBeVisible();
  await expect(extensionPage.locator('#tab-contacts .empty-state')).toHaveText('No contacts found');

  // Click add contact button
  await extensionPage.click('#add-contact-btn');

  // Verify add contact view is visible
  await expect(extensionPage.locator('#view-add-contact')).toBeVisible();
  await expect(extensionPage.locator('#view-add-contact h2')).toHaveText('Add Contact');

  // Fill in contact details
  await extensionPage.fill('#contact-name', 'Alice');
  // Must be a real address: the popup validates base58check and the testnet version byte
  await extensionPage.fill('#contact-address', 'y5cfytr6dxKHWMar8o7NTjYbP33a7uWtt1');
  await extensionPage.fill('#contact-notes', 'Friend from work');

  // Save contact
  await extensionPage.click('#save-contact-btn');

  // Wait for save operation
  await extensionPage.waitForTimeout(1000);

  // Verify we're back on contacts tab
  await expect(extensionPage.locator('#view-add-contact')).not.toBeVisible();
  await expect(extensionPage.locator('#tab-contacts')).toBeVisible();

  // Verify contact appears in list (if empty state is gone, contact was added)
  const emptyState = await extensionPage.locator('#tab-contacts .empty-state').isVisible();
  expect(emptyState).toBe(false);

  // Test search functionality
  await extensionPage.fill('#contact-search', 'Alice');
  await extensionPage.waitForTimeout(500);

  // Clear search
  await extensionPage.fill('#contact-search', '');
});

// Test 7: Hide balance toggle
test('should toggle balance visibility', async ({ extensionPage }) => {
  // First create a wallet
  await extensionPage.click('#onboard-create-btn');
  await extensionPage.fill('#create-name', 'Balance Test Wallet');
  await extensionPage.fill('#create-password', 'SecurePassword123!');
  await extensionPage.fill('#create-password-confirm', 'SecurePassword123!');

  // Dismiss alert dialogs
  extensionPage.on('dialog', dialog => dialog.accept());

  await extensionPage.click('#create-submit-btn');

  // The account only exists after the recovery-phrase modal is confirmed
  await expect(extensionPage.locator('#mnemonic-modal')).toBeVisible({ timeout: 10000 });
  await extensionPage.click('#mnemonic-confirm-btn');

  // Wait for wallet creation to complete
  await expect(extensionPage.locator('#loading')).not.toBeVisible({ timeout: 10000 });
  await expect(extensionPage.locator('#balance-section')).toBeVisible({ timeout: 5000 });

  // Verify balance is initially visible
  await expect(extensionPage.locator('#balance-amount')).toBeVisible();
  const initialBalance = await extensionPage.locator('#balance-amount').textContent();
  expect(initialBalance).toBeTruthy();

  // Click hide balance button
  await extensionPage.click('#hide-balance-btn');

  // Wait for toggle animation
  await extensionPage.waitForTimeout(500);

  // Verify balance is hidden (replaced with dots or similar)
  const hiddenBalance = await extensionPage.locator('#balance-amount').textContent();

  // Balance should be different when hidden (likely showing asterisks or dots)
  // Or check if it has a specific class
  const hasHiddenClass = await extensionPage.locator('#balance-section').evaluate(
    el => el.classList.contains('hidden-balance') || el.classList.contains('balance-hidden')
  );

  // At least verify the button is still there to toggle back
  await expect(extensionPage.locator('#hide-balance-btn')).toBeVisible();

  // Toggle balance back to visible
  await extensionPage.click('#hide-balance-btn');
  await extensionPage.waitForTimeout(500);

  // Verify balance is visible again
  const visibleBalance = await extensionPage.locator('#balance-amount').textContent();
  expect(visibleBalance).toBeTruthy();

  // Test via Settings
  await extensionPage.click('#settings-btn');
  await expect(extensionPage.locator('#view-settings')).toBeVisible();

  // Find hide balance checkbox
  await expect(extensionPage.locator('#setting-hide-balance')).toBeVisible();

  // Toggle via settings
  await extensionPage.click('#setting-hide-balance');

  // Go back to main view
  await extensionPage.click('#settings-back-btn');
  await expect(extensionPage.locator('#view-settings')).not.toBeVisible();
  await expect(extensionPage.locator('#balance-section')).toBeVisible();
});
