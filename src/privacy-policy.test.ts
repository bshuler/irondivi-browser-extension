import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { NETWORKS, FAUCET_URLS } from './shared/constants';
import { PBKDF2_ITERATIONS } from './shared/crypto-utils';

// The privacy policy the store listings link to must match what the code
// does: every host the wallet sends to is named, and the claims about local
// storage hold.

const read = (p: string) => readFileSync(fileURLToPath(new URL(p, import.meta.url)), 'utf8');
const policy = read('../site/privacy/index.html');
const text = policy.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');

describe('the privacy policy matches the code', () => {
  it('names every host the wallet sends to', () => {
    const hosts = new Set([
      ...Object.values(NETWORKS).map(n => new URL(n.rpcUrl).host),
      ...Object.values(FAUCET_URLS).map(u => new URL(u).host),
    ]);
    for (const host of hosts) expect(text, host).toContain(host);
  });

  it('every fetch in the wallet goes to the RPC, the faucet or a Connect relay', () => {
    const src = fileURLToPath(new URL('.', import.meta.url));
    const fetching = (readdirSync(src, { recursive: true }) as string[])
      .filter(f => /\.ts$/.test(f) && !/\.test\.ts$|test-support/.test(f))
      .filter(f => /\bfetch\(/.test(readFileSync(`${src}/${f}`, 'utf8')))
      .sort();
    expect(fetching).toEqual(['background/connect-relay.ts', 'background/rpc-client.ts']);
    expect(text).toMatch(/IronDivi Connect relay/);
  });

  it('says how the phrase is encrypted, as the code does it', () => {
    expect(PBKDF2_ITERATIONS).toBeGreaterThanOrEqual(600_000);
    expect(text).toMatch(/PBKDF2 and AES-GCM/);
    expect(read('./shared/crypto-utils.ts')).toMatch(/AES-GCM/);
  });

  it('Firefox declares no data collection, as the policy says', () => {
    const ff = JSON.parse(read('../manifest.firefox.json'));
    expect(ff.browser_specific_settings.gecko.data_collection_permissions.required).toEqual(['none']);
    expect(text).toMatch(/collects nothing about you/);
  });

  it('the site links to it', () => {
    expect(read('../site/index.html')).toContain('href="/privacy/"');
  });
});
