/**
 * Which web pages may talk to the wallet. Shared by the content script (which
 * decides whether to inject window.irondivi) and the background (which decides
 * whether to answer), so the two cannot disagree.
 */

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
