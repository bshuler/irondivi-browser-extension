// Render og-image.html to site/assets/og-image-v2.png (1200x630), the link preview social sites show.
// Usage: node site/deploy/og/render.mjs   (after npm ci; uses the Playwright Chromium the tests use)
import { chromium } from '@playwright/test';
import fs from 'node:fs';
import os from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';

function resolveShell() {
  if (process.env.CHROMIUM_PATH) return { executablePath: process.env.CHROMIUM_PATH, headless: true };
  const cache = process.env.PLAYWRIGHT_BROWSERS_PATH
    || (process.platform === 'darwin' ? path.join(os.homedir(), 'Library/Caches/ms-playwright') : path.join(os.homedir(), '.cache/ms-playwright'));
  if (fs.existsSync(cache)) {
    const shells = fs.readdirSync(cache).filter(d => /^chromium_headless_shell-\d+$/.test(d))
      .sort((a, b) => Number(b.split('-').pop()) - Number(a.split('-').pop()));
    for (const d of shells) {
      const hit = ['chrome-headless-shell-mac-arm64/chrome-headless-shell', 'chrome-headless-shell-mac-x64/chrome-headless-shell', 'chrome-headless-shell-linux64/chrome-headless-shell', 'chrome-linux/headless_shell']
        .map(r => path.join(cache, d, r)).find(fs.existsSync);
      if (hit) return { executablePath: hit, headless: true };
    }
  }
  return { headless: true };
}

const here = path.dirname(fileURLToPath(import.meta.url));
const out = path.join(here, '../../assets/og-image-v2.png');
const browser = await chromium.launch(resolveShell());
const page = await browser.newPage({ viewport: { width: 1200, height: 630 } });
await page.goto(pathToFileURL(path.join(here, 'og-image.html')).href);
await page.evaluate(() => document.fonts.ready);
await page.screenshot({ path: out });
await browser.close();
console.log('wrote', out);
