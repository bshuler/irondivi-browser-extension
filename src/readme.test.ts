import { describe, expect, it } from 'vitest';
import fs from 'fs';
import path from 'path';

const readme = fs.readFileSync(path.join(__dirname, '..', 'README.md'), 'utf8');
const provider = fs.readFileSync(path.join(__dirname, 'injected', 'provider.ts'), 'utf8');
const section = readme.slice(readme.indexOf('## dApp connections'), readme.indexOf('## Development'));

describe('#7 README dApp section matches the code', () => {
  it('does not claim that every request opens the popup, or that a page it runs on may use the wallet', () => {
    expect(readme).not.toMatch(/every\s+request is approved in the extension popup/);
    expect(section).toMatch(/learns nothing|opens no window/);
  });

  it('names every site on the default list, and the denylist', async () => {
    const { DEFAULT_SITES } = await import('./shared/site-access');
    for (const site of DEFAULT_SITES) {
      expect(section).toContain(`\`${site}\``);
    }
    expect(section).toContain('site-access/blocked-sites.json');
  });

  it('documents each access status and its error code', () => {
    for (const status of ['default', 'allowed', 'not_allowed', 'denied', 'blocked']) {
      expect(section).toContain(`\`"${status}"\``);
    }
    expect(section).toMatch(/`4300` the site must ask/);
    expect(section).toMatch(/`4301` the site is blocked/);
    expect(section).toMatch(/requestAccess\(\{ reason:/);
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
