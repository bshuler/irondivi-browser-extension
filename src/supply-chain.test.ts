import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';

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

describe('L14 packaging writes checksums', () => {
  it('scripts/package.js writes SHA256SUMS after the packages', () => {
    const src = read('scripts/package.js').replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
    expect(src).toMatch(/createHash\('sha256'\)/);
    expect(src).toMatch(/SHA256SUMS-v\$\{version\}/);
    expect(src).toMatch(/packageSafari\(\);\s*writeChecksums\(\);/);
  });
});
