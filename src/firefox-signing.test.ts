import { describe, expect, it } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Mozilla signs the Firefox package (scripts/sign-firefox.sh); the signed .xpi
// replaces ours, so the checksums, releases.json, the page and the reproduce
// check all have to know a signed .xpi from an unsigned one

const root = new URL('..', import.meta.url).pathname;
const read = (file: string) => readFileSync(join(root, file), 'utf8');

// Mozilla's signed file: the same entries, repacked, plus META-INF/
function signedCopy(unsigned: string, out: string, change?: string) {
  execFileSync('python3', ['-I', '-c', `
import sys, zipfile
src, out, change = sys.argv[1], sys.argv[2], sys.argv[3]
with zipfile.ZipFile(src) as a, zipfile.ZipFile(out, "w", zipfile.ZIP_DEFLATED) as b:
    b.writestr("META-INF/cose.sig", b"sig")
    b.writestr("META-INF/mozilla.rsa", b"rsa")
    for i in a.infolist():
        b.writestr(i.filename, b"changed" if i.filename == change else a.read(i))
`, unsigned, out, change ?? '']);
}

describe('a Mozilla-signed .xpi', () => {
  it('is marked signed in releases.json; an unsigned one is not', async () => {
    // @ts-expect-error plain JS module
    const { writeChecksums, writeReleases, zipDirectory } = await import('../scripts/package.js');
    const dir = mkdtempSync(join(tmpdir(), 'irondivi-fx-'));
    try {
      const src = join(dir, 'src');
      mkdirSync(src);
      writeFileSync(join(src, 'manifest.json'), '{}');
      writeFileSync(join(src, 'background.js'), 'x');
      const pkgs = join(dir, 'packages');
      mkdirSync(pkgs);
      const xpi = join(pkgs, 'irondivi-wallet-firefox-v9.9.9.xpi');
      await zipDirectory(src, xpi, new Date(0));
      writeFileSync(join(pkgs, 'irondivi-wallet-chrome-v9.9.9.zip'), 'chrome');
      const source = { commit: 'abc', time: 0 };

      writeReleases(writeChecksums(pkgs, '9.9.9'), pkgs, '9.9.9', source);
      let rel = JSON.parse(readFileSync(join(pkgs, 'releases.json'), 'utf8'));
      expect(rel.files.firefox.signed).toBeUndefined();

      signedCopy(xpi, join(dir, 'signed.xpi'));
      writeFileSync(xpi, readFileSync(join(dir, 'signed.xpi')));
      writeReleases(writeChecksums(pkgs, '9.9.9'), pkgs, '9.9.9', source);
      rel = JSON.parse(readFileSync(join(pkgs, 'releases.json'), 'utf8'));
      expect(rel.files.firefox.signed).toBe('mozilla');
      expect(rel.files.chrome.signed).toBeUndefined();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('xpi-same.py accepts the same files plus a signature, and refuses a changed file or no signature', async () => {
    // @ts-expect-error plain JS module
    const { zipDirectory } = await import('../scripts/package.js');
    const dir = mkdtempSync(join(tmpdir(), 'irondivi-fx-'));
    const same = (a: string, b: string) => spawnSync('python3', ['-I', join(root, 'scripts/xpi-same.py'), a, b]).status;
    try {
      const src = join(dir, 'src');
      mkdirSync(src);
      writeFileSync(join(src, 'manifest.json'), '{}');
      writeFileSync(join(src, 'background.js'), 'x');
      const xpi = join(dir, 'unsigned.xpi');
      await zipDirectory(src, xpi, new Date(0));

      signedCopy(xpi, join(dir, 'good.xpi'));
      expect(same(xpi, join(dir, 'good.xpi'))).toBe(0);
      signedCopy(xpi, join(dir, 'bad.xpi'), 'background.js');
      expect(same(xpi, join(dir, 'bad.xpi'))).toBe(1);
      expect(same(xpi, xpi)).toBe(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('scripts/sign-firefox.sh', () => {
  const script = read('scripts/sign-firefox.sh');

  it('takes the AMO key from 1Password into the environment, never onto a command line', () => {
    expect(script).toMatch(/WEB_EXT_API_KEY=\$\(secret get --name amo_api_issuer --op-ref "\$OP_ITEM\/issuer"\)/);
    expect(script).toMatch(/WEB_EXT_API_SECRET=\$\(secret get --name amo_api_secret --op-ref "\$OP_ITEM\/secret"\)/);
    expect(script).not.toMatch(/--api-key|--api-secret|op read|echo "\$WEB_EXT/);
  });

  it('signs unlisted with the source attached, checks the files, then re-signs the checksums', () => {
    expect(script).toMatch(/web-ext sign --channel unlisted --source-dir dist\/firefox/);
    expect(script).toMatch(/--upload-source-code "\$WORK\/source\.zip"/);
    const check = script.indexOf('xpi-same.py');
    expect(check).toBeGreaterThan(0);
    expect(script.indexOf('cp "$signed" "$XPI"')).toBeGreaterThan(check);
    expect(script.trimEnd().endsWith('"$REPO/scripts/sign-release.sh"')).toBe(true);
  });

  it('web-ext is a pinned dev dependency, run from node_modules', () => {
    expect(JSON.parse(read('package.json')).devDependencies['web-ext']).toMatch(/^\d+\.\d+\.\d+$/);
    expect(script).toMatch(/npx --no-install web-ext/);
  });
});

describe('the download page and reproduce.sh', () => {
  it('the page shows normal install steps only for a Mozilla-signed .xpi', () => {
    const html = read('site/index.html');
    expect(html).toMatch(/<div id="firefox-signed" hidden>/);
    expect(html).toMatch(/<div id="firefox-unsigned">/);
    const app = read('site/app.js');
    expect(app).toMatch(/signed: f\.signed === 'mozilla'/);
    expect(app).toMatch(/showFirefoxSteps\(\);/);
  });

  it('reproduce.sh compares a signed .xpi file by file', () => {
    const sh = read('scripts/reproduce.sh');
    expect(sh).toMatch(/if \(f\.signed\)/);
    expect(sh).toMatch(/python3 -I scripts\/xpi-same\.py "\$WORK\/src\/packages\/\$file" "\$WORK\/\$file"/);
  });
});
