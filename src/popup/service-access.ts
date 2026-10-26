/**
 * The banner that asks for the Divi services when the browser has not granted them
 *
 * Safari grants an extension's host permissions one website at a time, and
 * nobody browses to services.divi.domains, so until the user allows it every
 * balance, history and send call from the background fails as a cross-origin
 * request. Chrome grants them at install; Firefox does too but lets the user
 * take them back, and then the banner shows there as well.
 */
import { NETWORKS, FAUCET_URLS } from '../shared/constants';

/** Every host the background fetches from */
export const SERVICE_ORIGINS = [
  ...new Set([...Object.values(NETWORKS).map(n => n.rpcUrl), ...Object.values(FAUCET_URLS)]
    .map(url => `${new URL(url).origin}/*`)),
];

function permissionsAPI(): any {
  const api = (globalThis as any).chrome || (globalThis as any).browser;
  return api?.permissions;
}

/** Whether the background may reach every Divi service (true where it can't be asked) */
export function hasServiceAccess(): Promise<boolean> {
  const permissions = permissionsAPI();
  if (!permissions?.contains) return Promise.resolve(true);
  return new Promise(resolve => {
    try {
      permissions.contains({ origins: SERVICE_ORIGINS }, (granted: boolean) => resolve(granted !== false));
    } catch {
      resolve(true);
    }
  });
}

/**
 * Ask for the Divi services. Call it straight from a click, before any
 * await: a browser only shows the prompt for something the user just did.
 */
export function requestServiceAccess(): Promise<boolean> {
  const permissions = permissionsAPI();
  if (!permissions?.request) return Promise.resolve(false);
  return new Promise(resolve => {
    try {
      permissions.request({ origins: SERVICE_ORIGINS }, (granted: boolean) => resolve(granted === true));
    } catch {
      resolve(false);
    }
  });
}

/**
 * After a failed call: if the services were never granted, show the banner
 * that asks for them and return true, so the caller shows no error of its own
 */
export async function explainedByMissingAccess(): Promise<boolean> {
  if (await hasServiceAccess()) return false;
  const banner = document.getElementById('service-access');
  const allow = document.getElementById('service-access-allow');
  if (!banner || !allow) return false;
  banner.classList.remove('hidden');
  allow.onclick = async () => {
    // Start over with access: everything the popup loaded failed without it
    if (await requestServiceAccess()) location.reload();
  };
  return true;
}
