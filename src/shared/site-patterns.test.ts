import { describe, expect, it } from 'vitest';
import { checkSitePatterns, isSiteAllowed, isValidSitePattern, MAX_SITE_PATTERNS } from './origin';

// Regression tests for the security review's L1: the allowlist glob matcher
// ignored ports, let ? match a dot, and broke ** into one label

describe('L1 site patterns match labels and ports exactly', () => {
  it('a plain host matches only itself, on the default port', () => {
    expect(isSiteAllowed('https://games.divi.domains', ['games.divi.domains'])).toBe(true);
    expect(isSiteAllowed('https://games.divi.domains:8443', ['games.divi.domains'])).toBe(false);
    expect(isSiteAllowed('https://evilgames.divi.domains', ['games.divi.domains'])).toBe(false);
    expect(isSiteAllowed('https://games.divi.domains.evil.com', ['games.divi.domains'])).toBe(false);
  });

  it('*. matches exactly one label', () => {
    expect(isSiteAllowed('https://a.divi.domains', ['*.divi.domains'])).toBe(true);
    expect(isSiteAllowed('https://a.b.divi.domains', ['*.divi.domains'])).toBe(false);
    expect(isSiteAllowed('https://divi.domains', ['*.divi.domains'])).toBe(false);
  });

  it('**. matches one label or more, but not the bare domain', () => {
    expect(isSiteAllowed('https://a.divi.domains', ['**.divi.domains'])).toBe(true);
    expect(isSiteAllowed('https://a.b.divi.domains', ['**.divi.domains'])).toBe(true);
    expect(isSiteAllowed('https://divi.domains', ['**.divi.domains'])).toBe(false);
    expect(isSiteAllowed('https://xdivi.domains', ['**.divi.domains'])).toBe(false);
  });

  it('a port in the pattern is compared, and :* allows any port', () => {
    expect(isSiteAllowed('http://localhost:8080', ['localhost:8080'])).toBe(true);
    expect(isSiteAllowed('http://localhost:8081', ['localhost:8080'])).toBe(false);
    expect(isSiteAllowed('http://localhost', ['localhost:8080'])).toBe(false);
    expect(isSiteAllowed('http://localhost:3000', ['localhost:*'])).toBe(true);
    expect(isSiteAllowed('http://localhost', ['localhost:*'])).toBe(true);
    expect(isSiteAllowed('http://localhost:3000', ['localhost'])).toBe(false);
  });

  it('matching ignores case and surrounding spaces in the pattern', () => {
    expect(isSiteAllowed('https://games.divi.domains', ['  Games.Divi.Domains '])).toBe(true);
  });

  it('? and over-broad or malformed patterns are invalid, and an invalid pattern matches nothing', () => {
    for (const bad of ['gam?s.divi.domains', '*.com', '**.com', '*', '**', 'a*.divi.domains',
      'divi..domains', '-x.divi.domains', 'localhost:0', 'localhost:65536', 'localhost:abc',
      'https://games.divi.domains', 'games.divi.domains/path', '']) {
      expect(isValidSitePattern(bad), bad).toBe(false);
    }
    expect(isSiteAllowed('https://games.divi.domains', ['gam?s.divi.domains'])).toBe(false);
    expect(isSiteAllowed('https://x.com', ['*.com'])).toBe(false);
  });

  it('valid patterns are accepted', () => {
    for (const ok of ['games.divi.domains', '*.divi.domains', '**.divi.domains', 'localhost',
      'localhost:*', 'localhost:8080', '127.0.0.1:*', 'divi.domains:443']) {
      expect(isValidSitePattern(ok), ok).toBe(true);
    }
  });

  it('checkSitePatterns refuses a non-array, a non-string, a bad pattern or too many', () => {
    expect(checkSitePatterns(['games.divi.domains'])).toBeNull();
    expect(checkSitePatterns('games.divi.domains')).not.toBeNull();
    expect(checkSitePatterns([1])).not.toBeNull();
    expect(checkSitePatterns(['*.com'])).toMatch(/\*\.com/);
    const many = Array.from({ length: MAX_SITE_PATTERNS + 1 }, (_, i) => `s${i}.divi.domains`);
    expect(checkSitePatterns(many)).not.toBeNull();
    expect(checkSitePatterns(many.slice(0, MAX_SITE_PATTERNS))).toBeNull();
  });
});
