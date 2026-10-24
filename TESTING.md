# Testing the IronDivi Extension

## Quick Start

```bash
# 1. Install Playwright
npm install

# 2. Install browser
npx playwright install chromium

# 3. Build extension. The tests serve their dApp from 127.0.0.1, which only
#    a development build allows.
npm run build:dev

# 4. Run tests
npm test
```

## Test Suite Overview

**7 comprehensive E2E tests covering:**

1. Extension loading and initialization
2. Wallet creation with 12-word mnemonic
3. Wallet import with recovery phrase
4. Receive address QR code display
5. Send transaction UI flow
6. Contact management (address book)
7. Balance visibility toggle

## Files Created

```
irondivi-browser-extension/
├── playwright.config.ts          # Playwright configuration
├── tests/
│   ├── fixtures.ts                # Test fixtures for extension loading
│   ├── extension.spec.ts          # Main test suite (7 tests)
│   └── README.md                  # Detailed test documentation
└── package.json                   # Updated with test scripts
```

## Updated package.json Scripts

```json
{
  "scripts": {
    "test": "playwright test",           // Run all tests
    "test:headed": "playwright test --headed",  // Visible browser
    "test:unit": "vitest"                // Unit tests (existing)
  }
}
```

## Running Tests Remotely (Docker)

Following the project's browser testing guidelines, tests should be run on remote hosts using Docker:

```bash
# From ~/code/remote_browser_testing
python run-remote.py bshuler@hp1 "extension"
```

This ensures:
- Headed browser mode (required for extensions)
- Xvfb virtual display
- Consistent test environment
- No local browser dependencies

## Test Architecture

### Fixtures (`tests/fixtures.ts`)

Provides two fixtures:
- **context**: Browser context with extension loaded
- **extensionPage**: Page object for popup.html

```typescript
import { test, expect } from './fixtures';

test('my test', async ({ extensionPage }) => {
  await extensionPage.click('#my-button');
  await expect(extensionPage.locator('#result')).toBeVisible();
});
```

### Extension Loading

The fixture automatically:
1. Launches Chrome with extension flags
2. Loads extension from `dist/chrome/`
3. Waits for background service worker
4. Opens popup.html
5. Provides page object to tests

## Test Details

### Test 1: Extension Loads
- Verifies UI elements render
- Checks for console errors
- Confirms onboarding appears

### Test 2: Create Wallet
- Fills wallet creation form
- Tests 12-word mnemonic generation
- Validates wallet UI appears

### Test 3: Import Wallet
- Uses BIP39 test mnemonic
- Tests import flow
- Verifies wallet loads

### Test 4: Receive QR Code
- Opens receive view
- Validates QR code renders
- Checks address display
- Tests copy button

### Test 5: Send Transaction
- Fills send form
- Tests MAX button
- Navigates to confirmation
- Validates transaction details
- **Does not execute transaction**

### Test 6: Address Book
- Adds contact
- Verifies contact list
- Tests search functionality

### Test 7: Hide Balance
- Toggles balance visibility
- Tests via button and settings
- Validates state persistence

## Configuration

### playwright.config.ts

```typescript
{
  testDir: './tests',
  timeout: 60000,        // 60s per test
  retries: 1,            // Retry once on failure
  use: {
    headless: false,     // Required for extensions
    viewport: { width: 400, height: 600 },  // Popup size
    screenshot: 'only-on-failure',
  }
}
```

## Best Practices

### Before Running Tests
1. **Always rebuild**: `npm run build:dev` (a release build refuses the test dApp on 127.0.0.1)
2. **Check dist exists**: `ls dist/chrome/manifest.json`
3. **Verify background script**: `ls dist/chrome/background.js`

### Test Isolation
- Each test creates a new wallet
- No shared state between tests
- Tests can run in any order

### Debugging
- Use `--headed` to see browser
- Add `await page.pause()` to stop execution
- Check `test-results/` for screenshots
- Enable trace: `--trace on`

## Common Issues

### "Extension not found"
**Solution:** Run `npm run build:dev` before testing

### "Timeout waiting for element"
**Cause:** Slow wallet creation/import
**Solution:** Increase timeout or add explicit waits

### "Background service worker not found"
**Cause:** Extension not loading properly
**Solution:** Check manifest.json and background.js exist in dist/

### TypeScript errors
**Solution:** Install Playwright: `npm install`

## Next Steps

### Recommended Additional Tests
- [ ] Multiple account management
- [ ] Network switching (testnet/mainnet)
- [ ] Transaction history display
- [ ] Auto-lock timeout
- [ ] Password change
- [ ] Export recovery phrase
- [ ] Connected sites management
- [ ] dApp integration (if applicable)

### Integration Testing
- Test with actual testnet RPC
- Verify transaction broadcast
- Check balance updates
- Validate UTXOs

### Performance Testing
- Wallet creation time
- Import time with many accounts
- Transaction signing speed
- UI responsiveness

## CI/CD Example

```yaml
name: E2E Tests

on: [push, pull_request]

jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v3

      - name: Setup Node
        uses: actions/setup-node@v3
        with:
          node-version: '18'

      - name: Install dependencies
        run: npm ci

      - name: Install Playwright browsers
        run: npx playwright install --with-deps chromium

      - name: Build extension
        run: npm run build:dev

      - name: Run tests
        run: npm test

      - name: Upload test results
        if: always()
        uses: actions/upload-artifact@v3
        with:
          name: playwright-results
          path: test-results/
```

## Resources

- [Playwright Documentation](https://playwright.dev)
- [Testing Chrome Extensions](https://playwright.dev/docs/chrome-extensions)
- [Playwright Best Practices](https://playwright.dev/docs/best-practices)
