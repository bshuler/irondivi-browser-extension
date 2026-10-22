import { describe, expect, it } from 'vitest';
import fs from 'fs';
import path from 'path';

const readme = fs.readFileSync(path.join(__dirname, '..', 'README.md'), 'utf8');
const provider = fs.readFileSync(path.join(__dirname, 'injected', 'provider.ts'), 'utf8');
const section = readme.slice(readme.indexOf('## dApp connections'), readme.indexOf('## Development'));

describe('#7 README dApp section matches the code', () => {
  it('does not claim the provider is on every page or that every request opens the popup', () => {
    expect(readme).not.toMatch(/adds to every http\(s\) page/);
    expect(readme).not.toMatch(/every\s+request is approved in the extension popup/);
  });

  it('names the default allowed sites', async () => {
    // storage.ts reaches for the browser API when loaded
    (globalThis as any).chrome ??= { runtime: {} };
    const { DEFAULT_SETTINGS } = await import('./shared/storage');
    for (const site of DEFAULT_SETTINGS.allowedSites) {
      expect(section).toContain(`\`${site}\``);
    }
  });

  it('lists every request() method name the provider accepts', () => {
    const names = [...provider.matchAll(/'(irondivi_[A-Za-z]+)'/g)].map(m => m[1]);
    expect(names.length).toBeGreaterThan(5);
    for (const name of new Set(names)) {
      expect(section).toContain(`\`${name}\``);
    }
  });

  it('says which calls open the popup and which need a connected site', () => {
    expect(section).toMatch(/`sendTransaction\(.*\| yes \| yes, always \|/);
    expect(section).toMatch(/`signMessage\(.*\| yes \| yes, always \|/);
    expect(section).toMatch(/a connected site gets its address back with no popup/);
  });
});
