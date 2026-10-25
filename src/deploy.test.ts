import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

// Regression tests for the security review's EXT-13: deploy.sh staged the site
// and the nginx vhost under fixed /tmp names on the host and copied them with
// sudo, so another local user could plant files there first, and only the
// packages were checked after the copy

const script = readFileSync(fileURLToPath(new URL('../site/deploy/deploy.sh', import.meta.url)), 'utf8');
const [local, remote] = script.split("<<'REMOTE'");

describe('EXT-13 deploy.sh stages privately and checks the whole site', () => {
  it('no fixed /tmp name is used on the host', () => {
    expect(script).not.toMatch(/\/tmp\/\$SITE/);
    expect(remote.replace("/tmp/tmp.*", '')).not.toMatch(/\/tmp\//);
  });

  it('the stage is a fresh mktemp -d directory on the host, removed afterwards', () => {
    expect(local).toMatch(/STAGE=\$\(ssh "\$HOST" 'mktemp -d'\)/);
    expect(local).toMatch(/trap '.*ssh "\$HOST" "rm -rf/);
    expect(local).toMatch(/scp -q [^\n]*"\$HOST:\$STAGE\/\$SITE\.conf"/);
  });

  it('before any sudo copy the host checks the stage is ours alone and holds no symlink', () => {
    const firstSudo = remote.indexOf('sudo ');
    const check = remote.indexOf(`stat -c '%u %a' "$STAGE"`);
    const links = remote.indexOf('find "$STAGE" -type l');
    expect(check).toBeGreaterThan(0);
    expect(links).toBeGreaterThan(0);
    expect(check).toBeLessThan(firstSudo);
    expect(links).toBeLessThan(firstSudo);
    expect(remote).toContain('"$(id -u) 700"');
  });

  it('a hash of every site file is made here and checked on the stage and in the web root', () => {
    expect(local).toMatch(/find \. -type f ! -name "\$MANIFEST"[^\n]*shasum -a 256 > "\$MANIFEST"/);
    const stageCheck = remote.indexOf('(cd "$STAGE" && sha256sum -c --quiet "$MANIFEST")');
    const rootCheck = remote.indexOf('(cd "$ROOT" && sha256sum -c --quiet "$STAGE/$MANIFEST")');
    expect(stageCheck).toBeGreaterThan(0);
    expect(stageCheck).toBeLessThan(remote.indexOf('sudo rsync'));
    expect(rootCheck).toBeGreaterThan(remote.indexOf('sudo rsync -rlc "$STAGE/downloads/"'));
  });

  it('the vhost is installed from the private stage', () => {
    expect(remote).toContain('sudo cp "$conf_src" "$conf"');
  });
});
