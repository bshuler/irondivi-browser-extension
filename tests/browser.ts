import { chromium, BrowserContext } from '@playwright/test';
import fs from 'fs';
import os from 'os';
import path from 'path';

// Which Chromium runs the extension tests, in order:
//   PW_CHANNEL=chrome|msedge   an installed branded browser (note: Google Chrome 137+
//                              ignores --load-extension, so 'chrome' no longer works)
//   PW_CHROMIUM=<path>         an explicit Chromium / Chrome for Testing binary
//   Playwright's own revision  if `npx playwright install chromium` was run
//   newest cached revision     any chromium-* already in ~/Library/Caches/ms-playwright
//                              (avoids a fresh ~350 MB download per Playwright version)
function resolveLaunch(): { channel?: string; executablePath?: string } {
  if (process.env.PW_CHANNEL) return { channel: process.env.PW_CHANNEL };
  if (process.env.PW_CHROMIUM) return { executablePath: process.env.PW_CHROMIUM };
  const bundled = chromium.executablePath();
  if (fs.existsSync(bundled)) return { executablePath: bundled };
  const cache = process.env.PLAYWRIGHT_BROWSERS_PATH
    || (process.platform === 'darwin'
      ? path.join(os.homedir(), 'Library/Caches/ms-playwright')
      : path.join(os.homedir(), '.cache/ms-playwright'));
  const candidates = fs.existsSync(cache)
    ? fs.readdirSync(cache)
      .filter((d) => /^chromium-\d+$/.test(d))
      .sort((a, b) => Number(b.split('-')[1]) - Number(a.split('-')[1]))
      .map((d) => {
        const base = path.join(cache, d);
        const mac = path.join(base, 'chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing');
        const linux = path.join(base, 'chrome-linux/chrome');
        return [mac, linux].find((p) => fs.existsSync(p));
      })
      .filter((p): p is string => !!p)
    : [];
  if (candidates.length) return { executablePath: candidates[0] };
  throw new Error(
    `No Chromium found for the extension tests. Run \`npx playwright install chromium\` `
    + `or set PW_CHROMIUM=<path to a Chromium binary>.`,
  );
}

export async function launchWithExtension(extensionPath: string): Promise<BrowserContext> {
  const launch = resolveLaunch();
  return chromium.launchPersistentContext('', {
    ...launch,
    // Headless unless asked (npm run test:headed): a visible window lands on
    // whoever's screen the tests run on. Chrome's own headless mode loads
    // extensions; only the separate headless shell can't.
    headless: process.env.PW_HEADED !== '1',
    args: [
      `--disable-extensions-except=${extensionPath}`,
      `--load-extension=${extensionPath}`,
    ],
  });
}
