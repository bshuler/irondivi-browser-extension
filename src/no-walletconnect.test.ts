// Tripwire for ADR 0001 (docs/decisions/0001-no-walletconnect.md): Divi wallets
// use their own connection mechanism, never WalletConnect/Reown.
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const ROOT = join(__dirname, '..');
const FORBIDDEN = /walletconnect|reown|walletkit/i;

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap(name => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? sourceFiles(path) : [path];
  });
}

describe('ADR 0001: no WalletConnect', () => {
  it('declares no WalletConnect or Reown dependency', () => {
    const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
    const deps = Object.keys({ ...pkg.dependencies, ...pkg.devDependencies });
    expect(deps.filter(d => FORBIDDEN.test(d))).toEqual([]);
  });

  it('references WalletConnect nowhere in src/ or the build config', () => {
    const files = [...sourceFiles(join(ROOT, 'src')), join(ROOT, 'esbuild.config.js')]
      .filter(f => f !== __filename);
    const offenders = files
      .filter(f => FORBIDDEN.test(readFileSync(f, 'utf8')))
      .map(f => relative(ROOT, f));
    expect(offenders).toEqual([]);
  });
});
