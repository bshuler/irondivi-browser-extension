import { describe, expect, it } from 'vitest';
import fs from 'fs';
import path from 'path';

// The compiled site lists, as a pull request may change them (CONTRIBUTING.md)

const read = (name: string): unknown => JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', 'site-access', name), 'utf8'));
const lists = { 'default-sites.json': read('default-sites.json'), 'blocked-sites.json': read('blocked-sites.json') };

describe('site-access lists', () => {
  for (const [name, list] of Object.entries(lists)) {
    describe(name, () => {
      it('is an array of strings', () => {
        expect(Array.isArray(list)).toBe(true);
        for (const entry of list as unknown[]) expect(typeof entry).toBe('string');
      });

      it('holds only exact, lowercase https origins with no wildcard, path or port', () => {
        for (const entry of list as string[]) {
          expect(entry, entry).toMatch(/^https:\/\/[a-z0-9.-]+$/);
          expect(entry, entry).not.toContain('*');
          expect(entry, entry).toBe(entry.toLowerCase());
          const url = new URL(entry);
          expect(url.origin, entry).toBe(entry);
          expect(url.hostname.split('.').length, entry).toBeGreaterThanOrEqual(2);
          expect(url.hostname.split('.').every(label => label.length > 0 && !label.startsWith('-') && !label.endsWith('-')), entry).toBe(true);
        }
      });

      it('has no duplicates', () => {
        expect(new Set(list as string[]).size).toBe((list as string[]).length);
      });
    });
  }

  it('no site is on both lists', () => {
    const blocked = new Set(lists['blocked-sites.json'] as string[]);
    for (const site of lists['default-sites.json'] as string[]) expect(blocked.has(site), site).toBe(false);
  });

  it('the default list is the agreed one, with no *.divi.cx', () => {
    const sites = lists['default-sites.json'] as string[];
    expect([...sites].sort()).toEqual([
      'https://app.irondivi.com', 'https://browser.irondivi.com', 'https://divi.cx', 'https://dividinos.com',
      'https://games.divi.domains', 'https://intel.divi.domains', 'https://irondivi.com', 'https://name.divi.cx',
      'https://services.divi.domains', 'https://stakewatch.divi.cx', 'https://www.dividinos.com',
      'https://www.irondivi.com',
    ]);
  });

  it('the wallet loads the same lists', async () => {
    const { DEFAULT_SITES, BLOCKED_SITES } = await import('./site-access');
    expect([...DEFAULT_SITES]).toEqual(lists['default-sites.json']);
    expect([...BLOCKED_SITES]).toEqual(lists['blocked-sites.json']);
  });
});
