#!/usr/bin/env node
import { createWriteStream, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'fs';
import { execFileSync } from 'child_process';
import { createHash } from 'crypto';
import { join, dirname, relative, sep } from 'path';
import { fileURLToPath, pathToFileURL } from 'url';
import archiver from 'archiver';

const __dirname = dirname(fileURLToPath(import.meta.url));
const rootDir = join(__dirname, '..');
const distDir = join(rootDir, 'dist');
const packagesDir = join(rootDir, 'packages');

// Zip entries store local time; packaging in UTC keeps the bytes the same
// wherever the release is built
process.env.TZ = 'UTC';

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

// The extension's files inside the app, as safari.sh copied them from dist/safari
function safariResources() {
  return join(safariApp, 'Contents', 'PlugIns', `IronDivi Wallet Extension.appex`, 'Contents', 'Resources');
}

function packageSafari(source) {
  if (!existsSync(safariApp)) {
    console.log('Skipped safari: run npm run build:safari && scripts/safari.sh first.');
    return;
  }
  assertReleaseBuild(safariResources(), source.commit);
  const filename = `irondivi-wallet-safari-v${version}.zip`;
  const outputPath = join(packagesDir, filename);
  rmSync(outputPath, { force: true });
  execFileSync('ditto', ['-c', '-k', '--keepParent', safariApp, outputPath]);
  console.log(`Created ${filename}`);
}

// A development build allows dApps on localhost and ships source maps; dev
// and watch builds write to the same dist/ folder, so check what is there
export function assertReleaseBuild(dir, commit) {
  const infoPath = join(dir, 'build-info.json');
  if (!existsSync(infoPath)) throw new Error(`${dir} has no build-info.json: rebuild it with npm run build:all`);
  const info = JSON.parse(readFileSync(infoPath, 'utf-8'));
  if (info.dev !== false) throw new Error(`${dir} is a development build: rebuild it with npm run build:all`);
  if (commit && info.commit !== commit) {
    throw new Error(`${dir} was built from ${info.commit}, not ${commit}: rebuild it with npm run build:all`);
  }
  const maps = readdirSync(dir, { recursive: true }).filter(name => String(name).endsWith('.map'));
  if (maps.length) throw new Error(`${dir} contains source maps (${maps.join(', ')})`);
}

// The source a release is built from: a commit with no uncommitted changes to
// tracked files, so releases.json can name it and anyone can rebuild it
export function sourceCommit(dir = rootDir) {
  const git = (...args) => execFileSync('git', args, { cwd: dir, encoding: 'utf-8' }).trim();
  if (git('status', '--porcelain', '--untracked-files=no')) {
    throw new Error('The working tree has uncommitted changes: commit them before packaging a release');
  }
  return { commit: git('rev-parse', 'HEAD'), time: Number(git('log', '-1', '--format=%ct')) };
}

// Every entry gets the same date and mode and the entries go in sorted order,
// so the same build gives the same bytes (EXT-14)
export function zipDirectory(dir, outputPath, date) {
  const names = readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter(entry => entry.isFile())
    .map(entry => relative(dir, join(entry.parentPath, entry.name)).split(sep).join('/'))
    .sort();
  return new Promise((resolve, reject) => {
    const output = createWriteStream(outputPath);
    const archive = archiver('zip', { zlib: { level: 9 } });
    output.on('close', () => resolve(archive.pointer()));
    archive.on('error', reject);
    archive.pipe(output);
    for (const name of names) {
      archive.append(readFileSync(join(dir, name)), { name, date, mode: 0o644 });
    }
    archive.finalize();
  });
}

async function createPackage(browser, source) {
  const browserDir = join(distDir, buildDirFor[browser] || browser);

  if (!existsSync(browserDir)) {
    console.error(`Build not found for ${browser}. Run npm run build:all first.`);
    process.exit(1);
  }
  assertReleaseBuild(browserDir, source.commit);

  // Create packages directory
  mkdirSync(packagesDir, { recursive: true });

  const ext = browser === 'firefox' ? 'xpi' : 'zip';
  const filename = `irondivi-wallet-${browser}-v${version}.${ext}`;
  const outputPath = join(packagesDir, filename);
  const bytes = await zipDirectory(browserDir, outputPath, releaseDate(source));
  console.log(`Created ${filename} (${bytes} bytes)`);
}

// SOURCE_DATE_EPOCH, if set, else the commit's time
export function releaseDate(source) {
  const epoch = process.env.SOURCE_DATE_EPOCH ? Number(process.env.SOURCE_DATE_EPOCH) : source.time;
  return new Date(epoch * 1000);
}

async function main() {
  console.log(`Packaging IronDivi Wallet v${version}...\n`);

  const source = sourceCommit();
  for (const browser of browsers) {
    await createPackage(browser, source);
  }
  packageSafari(source);
  writeReleases(writeChecksums(packagesDir, version), packagesDir, version, source);

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
  // A signature of the old sums no longer holds: scripts/sign-release.sh makes the new one
  rmSync(`${sumsPath}.sig`, { force: true });
  console.log(`\nWrote ${sumsPath}:\n${text}`);
  return lines;
}

// releases.json is what browser.divi.domains reads to offer each browser its
// download, with the same sha256 as SHA256SUMS, and the commit it was built
// from. The date is the commit's, so rebuilding the commit gives the same file
export function writeReleases(lines, packagesDir, version, source) {
  const files = {};
  for (const l of lines) {
    const browser = l.name.slice('irondivi-wallet-'.length, l.name.indexOf(`-v${version}.`));
    files[browser] = { file: l.name, sha256: l.sha256, bytes: l.bytes };
  }
  const release = {
    version,
    date: releaseDate(source).toISOString().slice(0, 10),
    commit: source.commit,
    sums: `SHA256SUMS-v${version}`,
    files,
  };
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
