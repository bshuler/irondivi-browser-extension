import esbuild from 'esbuild';
import { readFileSync, writeFileSync, cpSync, mkdirSync, existsSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const isWatch = process.argv.includes('--watch');
const browser = process.argv[2] || 'chrome';

const commonConfig = {
  bundle: true,
  format: 'esm',
  target: 'es2022',
  sourcemap: true,
  minify: !isWatch,
};

// esbuild plugin: alias bare Node.js module specifiers to browser shims
const nodeShimsPlugin = {
  name: 'node-shims',
  setup(build) {
    // Redirect `import "crypto"` / `require("crypto")` to our empty shim
    build.onResolve({ filter: /^crypto$/ }, () => ({
      path: join(__dirname, 'crypto-shim.js'),
    }));
  },
};

// WalletConnect SDK needs Node.js globals polyfilled for browser environments
const serviceWorkerConfig = {
  ...commonConfig,
  define: {
    'global': 'globalThis',
    'process.env.NODE_ENV': '"production"',
    'process.env': '{}',
  },
  inject: [join(__dirname, 'buffer-shim.js')],
  plugins: [nodeShimsPlugin],
};

async function build() {
  const outdir = join(__dirname, 'dist', browser);

  // Ensure output directory
  mkdirSync(outdir, { recursive: true });

  // Build background service worker (with WalletConnect polyfills)
  await esbuild.build({
    ...serviceWorkerConfig,
    entryPoints: [join(__dirname, 'src/background/service-worker.ts')],
    outfile: join(outdir, 'background.js'),
  });

  // Build popup
  await esbuild.build({
    ...commonConfig,
    entryPoints: [join(__dirname, 'src/popup/popup.ts')],
    outfile: join(outdir, 'popup.js'),
  });

  // Build content script
  await esbuild.build({
    ...commonConfig,
    entryPoints: [join(__dirname, 'src/content/content-script.ts')],
    outfile: join(outdir, 'content-script.js'),
  });

  // Build provider (injected into page)
  await esbuild.build({
    ...commonConfig,
    entryPoints: [join(__dirname, 'src/injected/provider.ts')],
    outfile: join(outdir, 'provider.js'),
    format: 'iife',  // IIFE for page injection
  });

  // Copy static files
  cpSync(join(__dirname, 'src/popup/popup.html'), join(outdir, 'popup.html'));
  cpSync(join(__dirname, 'src/popup/styles.css'), join(outdir, 'styles.css'));
  cpSync(join(__dirname, 'assets/icons'), join(outdir, 'icons'), { recursive: true });

  // Merge manifest for browser
  const baseManifest = JSON.parse(readFileSync(join(__dirname, 'manifest.json'), 'utf-8'));
  if (browser === 'firefox') {
    const firefoxOverrides = JSON.parse(readFileSync(join(__dirname, 'manifest.firefox.json'), 'utf-8'));
    Object.assign(baseManifest, firefoxOverrides);
  }
  writeFileSync(join(outdir, 'manifest.json'), JSON.stringify(baseManifest, null, 2));

  console.log(`Built for ${browser} in dist/${browser}/`);
}

build().catch(err => {
  console.error(err);
  process.exit(1);
});
