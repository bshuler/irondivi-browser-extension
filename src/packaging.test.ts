import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

// Regression tests for the security review's EXT-12: npm run package shipped
// whatever was in dist/, and dev and watch builds write there too, so a
// development build (dApps on localhost trusted, source maps) could be packaged

const root = fileURLToPath(new URL('..', import.meta.url));
const read = (file: string) => readFileSync(join(root, file), 'utf8');

function build(env: Record<string, string>) {
  const out = mkdtempSync(join(tmpdir(), 'irondivi-build-'));
  execFileSync('node', [join(root, 'esbuild.config.js'), 'chrome'], {
    cwd: root, env: { ...process.env, IRONDIVI_DEV: '', ...env, IRONDIVI_OUTDIR: out }, stdio: 'ignore',
  });
  return join(out, 'chrome');
}

describe('EXT-12 a development build is never packaged', () => {
  it('a release build is accepted and a development build refused', async () => {
    // @ts-expect-error plain JS module
    const { assertReleaseBuild } = await import('../scripts/package.js');
    const release = build({});
    const dev = build({ IRONDIVI_DEV: '1' });
    try {
      expect(JSON.parse(readFileSync(join(release, 'build-info.json'), 'utf8')).dev).toBe(false);
      expect(() => assertReleaseBuild(release)).not.toThrow();
      expect(() => assertReleaseBuild(dev)).toThrow(/development build/);
    } finally {
      rmSync(join(release, '..'), { recursive: true, force: true });
      rmSync(join(dev, '..'), { recursive: true, force: true });
    }
  }, 60000);

  it('a folder with no build-info.json, or with source maps, is refused', async () => {
    // @ts-expect-error plain JS module
    const { assertReleaseBuild } = await import('../scripts/package.js');
    const dir = mkdtempSync(join(tmpdir(), 'irondivi-dist-'));
    try {
      expect(() => assertReleaseBuild(dir)).toThrow(/no build-info.json/);
      writeFileSync(join(dir, 'build-info.json'), JSON.stringify({ dev: false }));
      writeFileSync(join(dir, 'background.js.map'), '{}');
      expect(() => assertReleaseBuild(dir)).toThrow(/source maps/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('npm run package rebuilds in release mode before packaging', () => {
    const scripts = JSON.parse(read('package.json')).scripts;
    expect(scripts.package).toMatch(/^npm run build:all && node scripts\/package\.js$/);
    expect(scripts['build:all']).not.toMatch(/IRONDIVI_DEV/);
  });
});
