import { execFileSync } from 'child_process';
import path from 'path';
import { fileURLToPath } from 'url';

// The dApp specs drive a page on http://127.0.0.1, which only a development
// build serves (a release build leaves local pages alone). Build one into
// dist/e2e/chrome for them; dist/chrome stays the release build.
export const DEV_EXTENSION_PATH = path.join(path.dirname(fileURLToPath(import.meta.url)), '../dist/e2e/chrome');

export default function globalSetup() {
  if (process.env.EXT_PATH) return;
  const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
  execFileSync('node', [path.join(root, 'esbuild.config.js'), 'chrome'], {
    cwd: root,
    stdio: 'inherit',
    env: { ...process.env, IRONDIVI_DEV: '1', IRONDIVI_OUTDIR: path.join(root, 'dist/e2e') },
  });
}
