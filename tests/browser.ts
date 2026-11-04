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
export function resolveLaunch(): { channel?: string; executablePath?: string } {
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

// Automated AI agent sessions (Antigravity / Claude Code) stay strictly headless
// unless HUMAN_HEADED_OK=1 is explicitly set for a human-watched session.
export function allowHeaded(requested = process.env.PW_HEADED === '1'): boolean {
  if (!requested) return false;
  if ((process.env.ANTIGRAVITY_AGENT || process.env.CLAUDECODE) && process.env.HUMAN_HEADED_OK !== '1') {
    return false;
  }
  return true;
}

// Pure CLI headless shell for non-extension DOM/icon/OG rendering (zero macOS AppKit/Dock registration).
export function resolveHeadlessShell(): { executablePath?: string } {
  if (process.env.CHROMIUM_PATH || process.env.PW_CHROMIUM) {
    return { executablePath: process.env.CHROMIUM_PATH || process.env.PW_CHROMIUM };
  }
  const cache = process.env.PLAYWRIGHT_BROWSERS_PATH
    || (process.platform === 'darwin'
      ? path.join(os.homedir(), 'Library/Caches/ms-playwright')
      : path.join(os.homedir(), '.cache/ms-playwright'));
  if (fs.existsSync(cache)) {
    const shells = fs.readdirSync(cache)
      .filter((d) => /^chromium_headless_shell-\d+$/.test(d))
      .sort((a, b) => Number(b.split('-').pop()) - Number(a.split('-').pop()));
    for (const d of shells) {
      const base = path.join(cache, d);
      const hit = [
        path.join(base, 'chrome-headless-shell-mac-arm64/chrome-headless-shell'),
        path.join(base, 'chrome-headless-shell-mac-x64/chrome-headless-shell'),
        path.join(base, 'chrome-headless-shell-linux64/chrome-headless-shell'),
        path.join(base, 'chrome-linux/headless_shell'),
      ].find((p) => fs.existsSync(p));
      if (hit) return { executablePath: hit };
    }
  }
  return resolveLaunch();
}

// The default server tries IronDivi's public Electrum first. Tests that mock the
// RPC proxy make its name unresolvable so the wallet falls back to the mock (a
// route would not do: Playwright does not see the service worker's sockets); a
// live test passes { liveElectrum: true } to reach the real server.
export async function launchWithExtension(
  extensionPath: string, { liveElectrum = false }: { liveElectrum?: boolean } = {},
): Promise<BrowserContext> {
  const launch = resolveLaunch();
  return chromium.launchPersistentContext('', {
    ...launch,
    // Headless unless asked (npm run test:headed): a visible window lands on
    // whoever's screen the tests run on. Chrome's own headless mode loads
    // extensions; only the separate headless shell can't.
    headless: !allowHeaded(),
    args: [
      `--disable-extensions-except=${extensionPath}`,
      `--load-extension=${extensionPath}`,
      ...(liveElectrum ? [] : ['--host-resolver-rules=MAP electrum.irondivi.com ~NOTFOUND']),
    ],
  });
}
