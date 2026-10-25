import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

// Regression tests for the security review's EXT-12: npm run package shipped
// whatever was in dist/, and dev and watch builds write there too, so a
// development build (dApps on localhost trusted, source maps) could be packaged

const root = fileURLToPath(new URL('..', import.meta.url));
const read = (file: string) => readFileSync(join(root, file), 'utf8');
const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex');

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

// EXT-14: archive entries kept their file times and releases.json stamped
// the day it was written, so two builds of one commit never matched
describe('EXT-14 a release can be rebuilt byte for byte', () => {
  const source = { commit: 'c0ffee', time: 1798761600 };

  async function zipTwice(dir: string) {
    // @ts-expect-error plain JS module
    const { zipDirectory, releaseDate } = await import('../scripts/package.js');
    const out = mkdtempSync(join(tmpdir(), 'irondivi-zip-'));
    try {
      await zipDirectory(dir, join(out, 'a.zip'), releaseDate(source));
      // Other file times, as a fresh checkout and build would have
      for (const name of ['background.js', 'manifest.json']) utimesSync(join(dir, name), 1000, 1000);
      await zipDirectory(dir, join(out, 'b.zip'), releaseDate(source));
      return [readFileSync(join(out, 'a.zip')), readFileSync(join(out, 'b.zip'))];
    } finally {
      rmSync(out, { recursive: true, force: true });
    }
  }

  it('two release builds of the same source package to the same bytes', async () => {
    const one = build({});
    const two = build({});
    try {
      const [a] = await zipTwice(one);
      const [, b] = await zipTwice(two);
      expect(sha(a)).toBe(sha(b));
    } finally {
      rmSync(join(one, '..'), { recursive: true, force: true });
      rmSync(join(two, '..'), { recursive: true, force: true });
    }
  }, 60000);

  it('the entries are sorted and carry the release date, not the file times', async () => {
    // @ts-expect-error plain JS module
    const { zipDirectory, releaseDate } = await import('../scripts/package.js');
    const dir = mkdtempSync(join(tmpdir(), 'irondivi-dist-'));
    try {
      mkdirSync(join(dir, 'icons'));
      for (const name of ['z.js', 'a.js', 'icons/b.png']) writeFileSync(join(dir, name), name);
      await zipDirectory(dir, join(dir, '..', `${dir.split('/').pop()}.zip`), releaseDate(source));
      const zip = readFileSync(join(dir, '..', `${dir.split('/').pop()}.zip`));
      rmSync(join(dir, '..', `${dir.split('/').pop()}.zip`));
      const names = [...zip.toString('latin1').matchAll(/PK\x03\x04[\s\S]{26}/g)].map(m => {
        const at = m.index! + 30;
        return zip.subarray(at, at + zip.readUInt16LE(m.index! + 26)).toString();
      });
      expect(names).toEqual(['a.js', 'icons/b.png', 'z.js']);
      // DOS date in every local header: 2027-01-01
      const dosDate = zip.readUInt16LE(12);
      expect([(dosDate >> 9) + 1980, (dosDate >> 5) & 15, dosDate & 31]).toEqual([2027, 1, 1]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('releases.json names the commit and takes its date from it', async () => {
    // @ts-expect-error plain JS module
    const { writeReleases } = await import('../scripts/package.js');
    const dir = mkdtempSync(join(tmpdir(), 'irondivi-pkg-'));
    try {
      writeReleases([], dir, '9.9.9', source);
      const rel = JSON.parse(readFileSync(join(dir, 'releases.json'), 'utf8'));
      expect(rel.commit).toBe('c0ffee');
      expect(rel.date).toBe('2027-01-01');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('a tree with uncommitted changes is not packaged, and a build from another commit is refused', async () => {
    // @ts-expect-error plain JS module
    const { sourceCommit, assertReleaseBuild } = await import('../scripts/package.js');
    const repo = mkdtempSync(join(tmpdir(), 'irondivi-git-'));
    const git = (...args: string[]) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'commit.gpgsign=false', ...args], { cwd: repo, encoding: 'utf8' });
    try {
      git('init', '-q');
      writeFileSync(join(repo, 'f'), '1');
      git('add', 'f');
      git('commit', '-q', '-m', 'one');
      const head = git('rev-parse', 'HEAD').trim();
      expect(sourceCommit(repo).commit).toBe(head);
      writeFileSync(join(repo, 'f'), '2');
      expect(() => sourceCommit(repo)).toThrow(/uncommitted changes/);

      writeFileSync(join(repo, 'build-info.json'), JSON.stringify({ dev: false, commit: `${head}-dirty` }));
      expect(() => assertReleaseBuild(repo, head)).toThrow(/was built from/);
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });
});

describe('EXT-14 releases are built with one Node version', () => {
  it('.nvmrc, package.json engines and CI agree', () => {
    const node = read('.nvmrc').trim();
    expect(node).toMatch(/^\d+\.\d+\.\d+$/);
    expect(JSON.parse(read('package.json')).engines.node).toBe(node);
    const ci = read('.github/workflows/ci.yml');
    expect(ci).toMatch(/node-version-file: \.nvmrc/);
    // Actions are pinned to a commit, not a movable tag
    for (const [, ref] of ci.matchAll(/uses: [\w-]+\/[\w-]+@(\S+)/g)) expect(ref).toMatch(/^[0-9a-f]{40}$/);
  });
});
