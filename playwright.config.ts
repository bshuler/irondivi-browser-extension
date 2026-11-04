import { defineConfig } from '@playwright/test';
import { allowHeaded } from './tests/browser';

export default defineConfig({
  testDir: './tests',
  globalSetup: './tests/global-setup.ts',
  timeout: 60000,
  retries: 1,
  use: {
    headless: !allowHeaded(),
    viewport: { width: 400, height: 600 },
    screenshot: 'only-on-failure',
  },
  projects: [
    {
      name: 'chromium',
      use: { browserName: 'chromium' },
    },
  ],
});
