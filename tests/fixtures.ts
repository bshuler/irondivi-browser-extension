import { test as base, BrowserContext, Page } from '@playwright/test';
import { launchWithExtension } from './browser';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
// EXT_DIST=edge runs the same tests against dist/edge (pair it with PW_CHANNEL=msedge).
const EXTENSION_PATH = path.join(__dirname, '../dist', process.env.EXT_DIST || 'chrome');

export const test = base.extend<{
  context: BrowserContext;
  extensionPage: Page;
}>({
  context: async ({}, use) => {
    const context = await launchWithExtension(EXTENSION_PATH);
    await use(context);
    await context.close();
  },
  extensionPage: async ({ context }, use) => {
    let [background] = context.serviceWorkers();
    if (!background) {
      background = await context.waitForEvent('serviceworker');
    }
    const extensionId = background.url().split('/')[2];
    const page = await context.newPage();
    await page.goto(`chrome-extension://${extensionId}/popup.html`);
    await use(page);
  },
});

export { expect } from '@playwright/test';
