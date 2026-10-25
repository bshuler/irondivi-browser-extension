import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
// @ts-expect-error plain JS build script
import { writeChecksums } from '../scripts/package.js';

// Regression tests for the security review's EXT-1: SHA256SUMS was served from
// the same host as the packages, so whoever could change one could change the
// other, and the page told Firefox users to turn off add-on signatures

vi.setConfig({ testTimeout: 30000 });

const repo = fileURLToPath(new URL('..', import.meta.url));
const script = (name: string) => join(repo, 'scripts', name);
const version = JSON.parse(readFileSync(join(repo, 'package.json'), 'utf8')).version;
const SUMS = `SHA256SUMS-v${version}`;

let dir: string;
let agent: { sock: string; pid: string };
let env: NodeJS.ProcessEnv;

function makeKey(name: string) {
  const path = join(dir, name);
  execFileSync('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-C', name, '-f', path]);
  return path;
}

function makePackages(): string {
  const pkg = mkdtempSync(join(dir, 'pkg-'));
  writeFileSync(join(pkg, `irondivi-wallet-chrome-v${version}.zip`), 'a package');
  writeFileSync(join(pkg, `irondivi-wallet-firefox-v${version}.xpi`), 'another package');
  writeChecksums(pkg, version);
  return pkg;
}

const run = (name: string, args: string[], extra: NodeJS.ProcessEnv = {}) =>
  spawnSync(script(name), args, { env: { ...env, ...extra }, encoding: 'utf8' });
const verify = (pkg: string) => run('verify-release.sh', [pkg, version]);

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'release-signing-'));
  const sock = join(dir, 'agent.sock');
  const out = execFileSync('ssh-agent', ['-s', '-a', sock], { encoding: 'utf8' });
  agent = { sock, pid: /SSH_AGENT_PID=(\d+)/.exec(out)![1] };
  const key = makeKey('release');
  // The private key is in the agent only, as it is in 1Password for a real release
  execFileSync('ssh-add', ['-q', key], { env: { ...process.env, SSH_AUTH_SOCK: sock } });
  rmSync(key);
  const pub = readFileSync(`${key}.pub`, 'utf8').trim().split(' ').slice(0, 2).join(' ');
  writeFileSync(join(dir, 'allowed_signers'), `releases@browser.divi.domains namespaces="file" ${pub}\n`);
  env = {
    ...process.env,
    RELEASE_SIGNING_AGENT: sock,
    RELEASE_SIGNING_PUB: `${key}.pub`,
    RELEASE_SIGNING_SIGNERS: join(dir, 'allowed_signers'),
  };
});

afterAll(() => {
  try { process.kill(Number(agent.pid)); } catch { /* already gone */ }
  rmSync(dir, { recursive: true, force: true });
});

describe('EXT-1 the checksums are signed by a key that never leaves 1Password', () => {
  it('sign-release.sh signs through the agent and the signature verifies', () => {
    const pkg = makePackages();
    const r = run('sign-release.sh', [], { RELEASE_PACKAGES: pkg });
    expect(r.stderr).toBe('');
    expect(r.status).toBe(0);
    expect(existsSync(join(pkg, `${SUMS}.sig`))).toBe(true);
    expect(verify(pkg).status).toBe(0);
  });

  it('a changed package fails the check', () => {
    const pkg = makePackages();
    expect(run('sign-release.sh', [], { RELEASE_PACKAGES: pkg }).status).toBe(0);
    writeFileSync(join(pkg, `irondivi-wallet-chrome-v${version}.zip`), 'a planted package');
    const r = verify(pkg);
    expect(r.status).not.toBe(0);
    expect(r.stderr).toMatch(/do not match/);
  });

  it('changed sums fail the check, even when the packages match them', () => {
    const pkg = makePackages();
    expect(run('sign-release.sh', [], { RELEASE_PACKAGES: pkg }).status).toBe(0);
    writeFileSync(join(pkg, `irondivi-wallet-chrome-v${version}.zip`), 'a planted package');
    writeChecksums(pkg, version);
    expect(existsSync(join(pkg, `${SUMS}.sig`))).toBe(false);
    expect(verify(pkg).stderr).toMatch(/not signed/);
  });

  it('a signature kept from the old sums, or made by another key, fails', () => {
    const pkg = makePackages();
    expect(run('sign-release.sh', [], { RELEASE_PACKAGES: pkg }).status).toBe(0);
    const sig = readFileSync(join(pkg, `${SUMS}.sig`));
    writeFileSync(join(pkg, `irondivi-wallet-chrome-v${version}.zip`), 'a planted package');
    writeChecksums(pkg, version);
    writeFileSync(join(pkg, `${SUMS}.sig`), sig);
    expect(verify(pkg).stderr).toMatch(/not a good signature/);

    const other = makeKey('other');
    execFileSync('ssh-keygen', ['-q', '-Y', 'sign', '-f', other, '-n', 'file', join(pkg, SUMS)]);
    expect(verify(pkg).stderr).toMatch(/not a good signature/);
  });

  it('unsigned sums fail', () => {
    expect(verify(makePackages()).stderr).toMatch(/not signed/);
  });
});

describe('EXT-1 deploy.sh publishes only a signed release', () => {
  const deploy = readFileSync(join(repo, 'site/deploy/deploy.sh'), 'utf8');

  it('the signature is checked before anything is staged or sent', () => {
    const check = deploy.indexOf('"$REPO/scripts/verify-release.sh" "$PKG" "$VERSION"');
    expect(check).toBeGreaterThan(0);
    expect(check).toBeLessThan(deploy.indexOf('LOCAL=$(mktemp -d)'));
    expect(check).toBeLessThan(deploy.indexOf('ssh "$HOST"'));
  });

  it('the signature is published next to the sums', () => {
    expect(deploy).toContain('"$PKG/SHA256SUMS-v$VERSION.sig"');
  });
});

describe('EXT-1 the page does not ask anyone to turn off add-on signatures', () => {
  for (const file of ['site/index.html', 'README.md', 'DEPLOY.md']) {
    it(file, () => {
      if (!existsSync(join(repo, file))) return;
      expect(readFileSync(join(repo, file), 'utf8')).not.toMatch(/xpinstall|signatures\.required/);
    });
  }
});
