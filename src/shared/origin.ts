/**
 * The game origin, and the site patterns of the allowedSites list that
 * installs before 0.0.5 kept. Which sites may use the wallet is decided in
 * site-access.ts.
 */

// Set by the build: true only for a development build (npm run build:dev or
// watch). Undefined outside a build, as in the unit tests, which is production.
declare const __IRONDIVI_DEV__: boolean | undefined;
const DEV_BUILD = typeof __IRONDIVI_DEV__ !== 'undefined' && __IRONDIVI_DEV__;

// Every pattern an old default allowedSites list held: up to 0.0.3
// *.divi.domains and the local hosts, in 0.0.4 games.divi.domains and
// services.divi.domains (and local hosts on any port in a development build).
// On moving to exact origins (0.0.5) these are not the user's own choices,
// and are not carried over as grants.
export const OLD_DEFAULT_PATTERNS: readonly string[] = [
  '*.divi.domains', 'localhost', '127.0.0.1',
  'games.divi.domains', 'services.divi.domains',
  'localhost:*', '127.0.0.1:*',
];

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
