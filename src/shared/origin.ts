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

// Local dApps under development. Only a development build allows them.
export const DEV_SITES = ['localhost', '127.0.0.1'];

// The default list up to 0.0.3. A stored list equal to it was never chosen
// by the user, so it is replaced by the current default.
export const LEGACY_DEFAULT_SITES = ['*.divi.domains', 'localhost', '127.0.0.1'];

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

/**
 * Convert a glob pattern to a RegExp
 * Supports: * (any chars except .), ** (any chars including .), ? (single char)
 */
function globToRegex(pattern: string): RegExp {
  const escaped = pattern
    .replace(/[.+^${}()|[\]\\]/g, '\\$&') // Escape regex special chars except * and ?
    .replace(/\*\*/g, '.*')               // ** matches anything
    .replace(/\*/g, '[^.]*')              // * matches anything except dots
    .replace(/\?/g, '.');                 // ? matches single char
  return new RegExp(`^${escaped}$`, 'i');
}

/**
 * Check if a hostname matches any pattern in the allowlist
 */
export function isHostAllowed(hostname: string, allowedSites: string[]): boolean {
  return allowedSites.some(pattern => globToRegex(pattern).test(hostname));
}

/**
 * The full rule: a valid origin whose host is in the allowedSites setting.
 */
export function isAllowedDappOrigin(origin: string, allowedSites: string[]): boolean {
  if (!isValidDappOrigin(origin)) return false;
  return isHostAllowed(new URL(origin).hostname, allowedSites);
}
