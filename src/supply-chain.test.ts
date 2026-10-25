import { describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Regression tests for the security review's L14: dependencies were declared
// with ^ ranges, so a fresh install could pull a newer, unreviewed release,
// and the packages shipped with no checksums to check a download against

const read = (file: string) => readFileSync(new URL(`../${file}`, import.meta.url), 'utf8');

describe('L14 every dependency is pinned', () => {
  const pkg = JSON.parse(read('package.json'));
  const lock = JSON.parse(read('package-lock.json'));

  for (const field of ['dependencies', 'devDependencies']) {
    for (const [name, spec] of Object.entries<string>(pkg[field] ?? {})) {
      it(`${name} is an exact version that matches the lockfile`, () => {
        expect(spec).toMatch(/^\d+\.\d+\.\d+$/);
        expect(lock.packages[`node_modules/${name}`].version).toBe(spec);
      });
    }
  }

  it('npm saves new dependencies at an exact version', () => {
    expect(read('.npmrc')).toMatch(/^save-exact=true$/m);
  });
});

// EXT-19: the old check matched the call order with a regex and broke when
// the code changed; this runs the real writer on a temporary folder instead
describe('L14 packaging writes checksums', () => {
  it('writeChecksums lists every package of the version with its sha256, and releases.json agrees', async () => {
    // @ts-expect-error plain JS module
    const { writeChecksums, writeReleases } = await import('../scripts/package.js');
    const dir = mkdtempSync(join(tmpdir(), 'irondivi-pkg-'));
    try {
      writeFileSync(join(dir, 'irondivi-wallet-chrome-v9.9.9.zip'), 'chrome bytes');
      writeFileSync(join(dir, 'irondivi-wallet-firefox-v9.9.9.xpi'), 'firefox bytes');
      writeFileSync(join(dir, 'irondivi-wallet-chrome-v9.9.8.zip'), 'old version');
      const lines = writeChecksums(dir, '9.9.9');
      writeReleases(lines, dir, '9.9.9', { commit: 'abc123', time: 1798761600 });

      const sha = (s: string) => createHash('sha256').update(s).digest('hex');
      expect(readFileSync(join(dir, 'SHA256SUMS-v9.9.9'), 'utf8')).toBe(
        `${sha('chrome bytes')}  irondivi-wallet-chrome-v9.9.9.zip\n` +
        `${sha('firefox bytes')}  irondivi-wallet-firefox-v9.9.9.xpi\n`,
      );
      const rel = JSON.parse(readFileSync(join(dir, 'releases.json'), 'utf8'));
      expect(rel.version).toBe('9.9.9');
      expect(rel.files.chrome.sha256).toBe(sha('chrome bytes'));
      expect(rel.files.firefox.sha256).toBe(sha('firefox bytes'));
      expect(Object.keys(rel.files).sort()).toEqual(['chrome', 'firefox']);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('main() writes the checksums after every package, Safari included', () => {
    const src = read('scripts/package.js');
    const body = src.slice(src.indexOf('async function main()'));
    expect(body.indexOf('packageSafari(')).toBeGreaterThan(0);
    expect(body.indexOf('writeChecksums(')).toBeGreaterThan(body.indexOf('packageSafari('));
  });
});

// Regression test for the security review's EXT-30: the test image was pinned
// by tag, which upstream can move to another image
describe('EXT-30 the test image is pinned by digest', () => {
  it('every FROM names a sha256 digest, and the Playwright tag matches package.json', () => {
    const froms = read('Dockerfile').split('\n').filter((l) => /^FROM\s/i.test(l));
    expect(froms.length).toBeGreaterThan(0);
    for (const from of froms) expect(from).toMatch(/@sha256:[0-9a-f]{64}(\s|$)/);
    const pkg = JSON.parse(read('package.json'));
    const playwright = pkg.devDependencies['@playwright/test'];
    expect(froms[0]).toContain(`playwright:v${playwright}-`);
  });
});
