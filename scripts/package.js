#!/usr/bin/env node
import { createWriteStream, existsSync, mkdirSync, readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import archiver from 'archiver';

const __dirname = dirname(fileURLToPath(import.meta.url));
const rootDir = join(__dirname, '..');
const distDir = join(rootDir, 'dist');
const packagesDir = join(rootDir, 'packages');

// Get version from package.json
const packageJson = JSON.parse(readFileSync(join(rootDir, 'package.json'), 'utf-8'));
const version = packageJson.version;

const browsers = ['chrome', 'firefox', 'edge'];

async function createPackage(browser) {
  const browserDir = join(distDir, browser);

  if (!existsSync(browserDir)) {
    console.error(`Build not found for ${browser}. Run npm run build:all first.`);
    process.exit(1);
  }

  // Create packages directory
  mkdirSync(packagesDir, { recursive: true });

  const ext = browser === 'firefox' ? 'xpi' : 'zip';
  const filename = `pdivi-wallet-${browser}-v${version}.${ext}`;
  const outputPath = join(packagesDir, filename);

  return new Promise((resolve, reject) => {
    const output = createWriteStream(outputPath);
    const archive = archiver('zip', { zlib: { level: 9 } });

    output.on('close', () => {
      console.log(`Created ${filename} (${archive.pointer()} bytes)`);
      resolve();
    });

    archive.on('error', reject);
    archive.pipe(output);
    archive.directory(browserDir, false);
    archive.finalize();
  });
}

async function main() {
  console.log(`Packaging PrivateDivi Wallet v${version}...\n`);

  for (const browser of browsers) {
    await createPackage(browser);
  }

  console.log(`\nAll packages created in ${packagesDir}`);
}

main().catch(err => {
  console.error('Packaging failed:', err);
  process.exit(1);
});
