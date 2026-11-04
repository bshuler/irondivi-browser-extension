# IronDivi Extension Test Suite

Playwright-based end-to-end tests for the IronDivi browser extension.

## Setup

1. **Install dependencies:**
   ```bash
   npm install
   ```
   The tests need a Chromium that honours `--load-extension` (branded Google Chrome
   137+ does not). `tests/browser.ts` picks, in order: `PW_CHANNEL` (e.g. `msedge`),
   `PW_CHROMIUM=<binary>`, Playwright's own revision (`npx playwright install chromium`),
   or the newest `chromium-*` already in `~/Library/Caches/ms-playwright`, so one cached
   Chrome for Testing serves every Playwright version instead of a 350 MB download each.

2. **Build the extension:**
   ```bash
   npm run build
   ```
   This creates the extension in `dist/chrome/`

## Running Tests

### Run all tests (headless):
```bash
npm test
```

### Run tests in headed mode (visible browser):
```bash
npm run test:headed
```

### Run specific test:
```bash
npx playwright test extension.spec.ts -g "should load extension"
```

### Debug mode:
```bash
npx playwright test --debug
```

## Test Coverage

The test suite includes 7 comprehensive tests:

1. **Extension Loads Without Errors**
   - Verifies extension loads successfully
   - Checks for console errors
   - Confirms onboarding screen appears

2. **Create New Wallet with 12-Word Mnemonic**
   - Tests wallet creation flow
   - Validates 12-word mnemonic generation
   - Confirms wallet UI appears after creation

3. **Import Wallet with Known Mnemonic**
   - Tests wallet import functionality
   - Uses valid BIP39 test mnemonic
   - Verifies imported wallet loads correctly

4. **Receive View Shows QR Code**
   - Tests receive address display
   - Validates QR code generation
   - Checks copy address functionality

5. **Send Transaction Flow**
   - Tests send form UI
   - Validates transaction confirmation screen
   - Tests MAX button and fee calculation
   - **Note:** Does not execute actual transactions

6. **Address Book Operations**
   - Tests contact creation
   - Validates contact list display
   - Tests contact search functionality

7. **Hide Balance Toggle**
   - Tests balance visibility toggle
   - Validates settings integration
   - Checks persistence across views

## Test Structure

### Fixtures (`fixtures.ts`)
- Sets up Chrome with extension loaded
- Provides `extensionPage` fixture for testing
- Handles extension ID resolution

### Test Specs (`extension.spec.ts`)
- Main test suite with all 7 tests
- Each test creates a fresh wallet to avoid state conflicts
- Uses explicit waits for async operations

## Important Notes

### Test Isolation
Each test creates its own wallet to ensure isolation. Tests do not depend on each other.

### Extension Path
Tests load the extension from `dist/chrome/`. Make sure to rebuild before testing if you've made changes:
```bash
npm run build && npm test
```

### Timeouts
- Default timeout: 60 seconds
- Explicit waits: 1-2 seconds for UI updates
- Adjust in `playwright.config.ts` if needed

### Headless Mode
Tests run headless by default, so no Chrome window opens on your screen.
Chrome's own headless mode loads extensions (only Playwright's separate
headless shell can't). To watch them: `npm run test:headed` (sets PW_HEADED=1).

### Debugging Failed Tests

1. **Screenshots**: Automatically captured on failure in `test-results/`

2. **Trace viewer**:
   ```bash
   npx playwright test --trace on
   npx playwright show-report
   ```

3. **Pause and inspect**:
   ```typescript
   await page.pause();
   ```

## Configuration

### Viewport
- Default: 400x600 (typical extension popup size)
- Configurable in `playwright.config.ts`

### Retries
- Automatic retry: 1 attempt on failure
- Disable: Set `retries: 0` in config

## Future Enhancements

Potential test additions:
- Transaction history display
- Multiple account switching
- Network switching (testnet/mainnet)
- Connected sites management
- Export/import functionality
- Password change flow
- Auto-lock timeout
- Transaction signing for dApps

## Troubleshooting

### Extension not loading
- Verify `dist/chrome/` exists and contains built files
- Check manifest.json is present in dist
- Run `npm run build` to rebuild

### Tests timing out
- Increase timeout in `playwright.config.ts`
- Check for network issues (extension connects to RPC)
- Verify background service worker is running

### Element not found
- Check popup.html for correct element IDs
- Add explicit waits before interactions
- Verify element is not hidden or in different view

## CI/CD Integration

Example GitHub Actions workflow:
```yaml
- name: Install dependencies
  run: npm ci

- name: Install Playwright
  run: npx playwright install --with-deps chromium

- name: Build extension
  run: npm run build

- name: Run tests
  run: npm test
```
