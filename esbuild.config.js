import esbuild from 'esbuild';
import { readFileSync, writeFileSync, cpSync, mkdirSync, existsSync, rmSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const isWatch = process.argv.includes('--watch');
const browser = process.argv[2] || 'chrome';
// A development build also allows dApps on localhost and 127.0.0.1
const isDev = isWatch || process.env.IRONDIVI_DEV === '1';

const commonConfig = {
  bundle: true,
  format: 'esm',
  target: 'es2022',
  // A release ships no source maps: they hand anyone the readable source and
  // the build paths, and the store review reads the minified code as shipped
  sourcemap: isDev,
  minify: !isWatch,
  define: { __IRONDIVI_DEV__: String(isDev) },
};

async function build() {
  const outdir = join(__dirname, 'dist', browser);

  // Start empty, so nothing from an earlier build (a dev build's source maps)
  // ends up in the package
  rmSync(outdir, { recursive: true, force: true });
  mkdirSync(outdir, { recursive: true });

  // Build background service worker
  await esbuild.build({
    ...commonConfig,
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
  // manifest.<browser>.json, when present, shallow-overrides top-level keys.
  const overridePath = join(__dirname, `manifest.${browser}.json`);
  if (existsSync(overridePath)) {
    Object.assign(baseManifest, JSON.parse(readFileSync(overridePath, 'utf-8')));
  }
  writeFileSync(join(outdir, 'manifest.json'), JSON.stringify(baseManifest, null, 2));

  console.log(`Built for ${browser} in dist/${browser}/`);
}

build().catch(err => {
  console.error(err);
  process.exit(1);
});
