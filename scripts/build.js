#!/usr/bin/env node
import { spawn } from 'child_process';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const rootDir = join(__dirname, '..');

const allBrowsers = ['chrome', 'firefox', 'edge', 'safari'];
const browsers = process.argv[2] === 'all'
  ? allBrowsers
  : [process.argv[2] || 'chrome'];

const isWatch = process.argv.includes('--watch');

async function build(browser) {
  return new Promise((resolve, reject) => {
    const args = [join(rootDir, 'esbuild.config.js'), browser];
    if (isWatch) args.push('--watch');

    const proc = spawn('node', args, { stdio: 'inherit', cwd: rootDir });
    proc.on('close', code => code === 0 ? resolve() : reject(new Error(`Build failed for ${browser}`)));
  });
}

async function main() {
  console.log(`Building for: ${browsers.join(', ')}\n`);

  for (const browser of browsers) {
    console.log(`\n=== Building ${browser} ===`);
    await build(browser);
  }

  console.log('\n✓ All builds complete!');
}

main().catch(err => {
  console.error('Build failed:', err);
  process.exit(1);
});
