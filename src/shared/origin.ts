/**
 * Which web pages may talk to the wallet. Shared by the content script (which
 * decides whether to inject window.irondivi) and the background (which decides
 * whether to answer), so the two cannot disagree.
 */

// Set by the build: true only for a development build (npm run build:dev or
// watch). Undefined outside a build, as in the unit tests, which is production.
declare const __IRONDIVI_DEV__: boolean | undefined;
const DEV_BUILD = typeof __IRONDIVI_DEV__ !== 'undefined' && __IRONDIVI_DEV__;

// The sites that use the wallet. Each is named exactly: a wildcard such as
// *.divi.domains would also admit any other host under that name.
export const PRODUCTION_SITES = ['games.divi.domains', 'services.divi.domains'];

// Local dApps under development, on any port. Only a development build
// allows them.
export const DEV_SITES = ['localhost:*', '127.0.0.1:*'];

// The default list up to 0.0.3. A stored list equal to it was never chosen
// by the user, so it is replaced by the current default.
export const LEGACY_DEFAULT_SITES = ['*.divi.domains', 'localhost', '127.0.0.1'];

// The only origin that may ask the wallet to sign Divi Games chain
// transactions or session grants, whatever else the user allows. A
// development build also takes local dApps.
export const GAME_ORIGIN = 'https://games.divi.domains';

export function isGameOrigin(origin: string, dev: boolean = DEV_BUILD): boolean {
  if (origin === GAME_ORIGIN) return true;
  if (!dev) return false;
  try {
    const url = new URL(origin);
    return url.protocol === 'http:' && (url.hostname === 'localhost' || url.hostname === '127.0.0.1');
  } catch {
    return false;
  }
}

export function defaultAllowedSites(dev: boolean = DEV_BUILD): string[] {
  return dev ? [...PRODUCTION_SITES, ...DEV_SITES] : [...PRODUCTION_SITES];
}

/**
 * The allowedSites to use for a stored list: the default when nothing is
 * stored or the stored list is the old default, otherwise the stored list.
 */
export function effectiveAllowedSites(stored: string[] | undefined, dev: boolean = DEV_BUILD): string[] {
  if (!Array.isArray(stored)) return defaultAllowedSites(dev);
  const isLegacy = stored.length === LEGACY_DEFAULT_SITES.length &&
    stored.every((s, i) => s === LEGACY_DEFAULT_SITES[i]);
  return isLegacy ? defaultAllowedSites(dev) : stored;
}

/**
 * A page origin the wallet serves at all:
 * - https origins
 * - http only on localhost or 127.0.0.1 (development)
 * Everything else (file:, data:, other extensions, opaque "null") is refused.
 */
export function isValidDappOrigin(origin: string): boolean {
  try {
    const url = new URL(origin);
    if (url.protocol === 'https:') return true;
    if (url.protocol === 'http:') {
      return url.hostname === 'localhost' || url.hostname === '127.0.0.1';
    }
    return false;
  } catch {
    return false;
  }
}

// A site pattern names a host and, optionally, a port:
//   games.divi.domains        that host, on the scheme's default port
//   *.example.com             one label in front of example.com, not example.com
//   **.example.com            one or more labels in front of example.com
//   localhost:8080            that port only
//   localhost:*               any port
// Matching is done on labels, not with regular expressions, and a pattern
// that does not fit this form is refused rather than guessed at.
interface SitePattern {
  wildcard: 'none' | 'one' | 'any';
  labels: string[]; // the exact labels, after any wildcard
  port: string | '*' | ''; // '' means the scheme's default port
}

const LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
export const MAX_SITE_PATTERNS = 50;

function parseSitePattern(raw: string): SitePattern | null {
  if (typeof raw !== 'string') return null;
  const pattern = raw.trim().toLowerCase();
  if (pattern.length === 0 || pattern.length > 253) return null;

  const colon = pattern.lastIndexOf(':');
  let host = pattern;
  let port: SitePattern['port'] = '';
  if (colon !== -1) {
    host = pattern.slice(0, colon);
    const p = pattern.slice(colon + 1);
    if (p === '*') port = '*';
    else if (/^[0-9]{1,5}$/.test(p) && Number(p) >= 1 && Number(p) <= 65535) port = String(Number(p));
    else return null;
  }

  let wildcard: SitePattern['wildcard'] = 'none';
  if (host.startsWith('**.')) { wildcard = 'any'; host = host.slice(3); }
  else if (host.startsWith('*.')) { wildcard = 'one'; host = host.slice(2); }

  const labels = host.split('.');
  if (!labels.every(l => LABEL.test(l))) return null;
  // A wildcard needs at least two labels after it, so *.com is refused
  if (wildcard !== 'none' && labels.length < 2) return null;
  return { wildcard, labels, port };
}

/**
 * Whether a pattern is one the wallet understands. The popup and the
 * background both check it before saving.
 */
export function isValidSitePattern(pattern: string): boolean {
  return parseSitePattern(pattern) !== null;
}

/**
 * A list of patterns that may be saved: an array of at most 50 valid
 * patterns, or the reason it may not
 */
export function checkSitePatterns(sites: unknown): string | null {
  if (!Array.isArray(sites)) return 'Allowed sites must be a list';
  if (sites.length > MAX_SITE_PATTERNS) return `At most ${MAX_SITE_PATTERNS} allowed sites`;
  const bad = sites.find(s => !isValidSitePattern(s));
  return bad === undefined ? null : `Not a valid site: ${String(bad).slice(0, 60)}`;
}

function matchesSitePattern(url: URL, pattern: SitePattern): boolean {
  if (pattern.port === '' ? url.port !== '' : pattern.port !== '*' && url.port !== pattern.port) {
    return false;
  }
  const host = url.hostname.toLowerCase().split('.');
  const n = pattern.labels.length;
  const tail = host.slice(-n);
  if (tail.length !== n || !tail.every((l, i) => l === pattern.labels[i])) return false;
  const extra = host.length - n;
  if (pattern.wildcard === 'none') return extra === 0;
  if (pattern.wildcard === 'one') return extra === 1;
  return extra >= 1;
}

/**
 * Check if an origin's host and port match any pattern in the allowlist
 */
export function isSiteAllowed(origin: string, allowedSites: string[]): boolean {
  let url: URL;
  try { url = new URL(origin); } catch { return false; }
  return allowedSites.some(raw => {
    const pattern = parseSitePattern(raw);
    return pattern !== null && matchesSitePattern(url, pattern);
  });
}

/**
 * The full rule: a valid origin whose host is in the allowedSites setting.
 */
export function isAllowedDappOrigin(origin: string, allowedSites: string[]): boolean {
  if (!isValidDappOrigin(origin)) return false;
  return isSiteAllowed(origin, allowedSites);
}
