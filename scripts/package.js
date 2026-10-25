#!/usr/bin/env node
import { createWriteStream, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'fs';
import { execFileSync } from 'child_process';
import { createHash } from 'crypto';
import { join, dirname } from 'path';
import { fileURLToPath, pathToFileURL } from 'url';
import archiver from 'archiver';

const __dirname = dirname(fileURLToPath(import.meta.url));
const rootDir = join(__dirname, '..');
const distDir = join(rootDir, 'dist');
const packagesDir = join(rootDir, 'packages');

// Get version from package.json
const packageJson = JSON.parse(readFileSync(join(rootDir, 'package.json'), 'utf-8'));
const version = packageJson.version;

// Opera and Brave run the Chrome build unchanged; Opera gets its own file so the
// Opera add-ons store and the download page can name it.
const browsers = ['chrome', 'edge', 'opera', 'firefox'];
const buildDirFor = { opera: 'chrome' };

// Safari ships as a macOS app (scripts/safari.sh builds it). ditto keeps the
// bundle's symlinks and code signature, which a plain zip would break.
const safariApp = join(rootDir, 'safari', 'build', 'Build', 'Products', 'Debug', 'IronDivi Wallet.app');

function packageSafari() {
  if (!existsSync(safariApp)) {
    console.log('Skipped safari: run npm run build:safari && scripts/safari.sh first.');
    return;
  }
  const filename = `irondivi-wallet-safari-v${version}.zip`;
  const outputPath = join(packagesDir, filename);
  rmSync(outputPath, { force: true });
  execFileSync('ditto', ['-c', '-k', '--keepParent', safariApp, outputPath]);
  console.log(`Created ${filename}`);
}

async function createPackage(browser) {
  const browserDir = join(distDir, buildDirFor[browser] || browser);

  if (!existsSync(browserDir)) {
    console.error(`Build not found for ${browser}. Run npm run build:all first.`);
    process.exit(1);
  }

  // Create packages directory
  mkdirSync(packagesDir, { recursive: true });

  const ext = browser === 'firefox' ? 'xpi' : 'zip';
  const filename = `irondivi-wallet-${browser}-v${version}.${ext}`;
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
  console.log(`Packaging IronDivi Wallet v${version}...\n`);

  for (const browser of browsers) {
    await createPackage(browser);
  }
  packageSafari();
  writeReleases(writeChecksums(packagesDir, version), packagesDir, version);

  console.log(`\nAll packages created in ${packagesDir}`);
}

// SHA256SUMS lists every package of this version, in the format sha256sum -c
// reads, so a download can be checked against the sums published with it
export function writeChecksums(packagesDir, version) {
  const prefix = 'irondivi-wallet-';
  const suffix = `-v${version}.`;
  const lines = readdirSync(packagesDir)
    .filter(name => name.startsWith(prefix) && name.includes(suffix))
    .sort()
    .map(name => {
      const data = readFileSync(join(packagesDir, name));
      return { name, sha256: createHash('sha256').update(data).digest('hex'), bytes: data.length };
    });
  const text = lines.map(l => `${l.sha256}  ${l.name}`).join('\n');
  const sumsPath = join(packagesDir, `SHA256SUMS-v${version}`);
  writeFileSync(sumsPath, text + '\n');
  console.log(`\nWrote ${sumsPath}:\n${text}`);
  return lines;
}

// releases.json is what browser.divi.domains reads to offer each browser its
// download, with the same sha256 as SHA256SUMS
export function writeReleases(lines, packagesDir, version) {
  const files = {};
  for (const l of lines) {
    const browser = l.name.slice('irondivi-wallet-'.length, l.name.indexOf(`-v${version}.`));
    files[browser] = { file: l.name, sha256: l.sha256, bytes: l.bytes };
  }
  const release = { version, date: new Date().toISOString().slice(0, 10), sums: `SHA256SUMS-v${version}`, files };
  const releasesPath = join(packagesDir, 'releases.json');
  writeFileSync(releasesPath, JSON.stringify(release, null, 2) + '\n');
  console.log(`Wrote ${releasesPath}`);
}

// Run only as a script, so tests can import the helpers above
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(err => {
    console.error('Packaging failed:', err);
    process.exit(1);
  });
}
