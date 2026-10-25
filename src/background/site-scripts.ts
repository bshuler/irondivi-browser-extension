/**
 * The wallet's scripts run only on the sites in the allowedSites setting.
 * Nothing is declared for every page in the manifest: the content script and
 * window.irondivi are registered here, for the allowed sites alone, so a page
 * on any other site never sees the wallet or its script. The background still
 * answers a page only if its origin is allowed (SITE_ALLOWED and every dApp
 * message check it), so a match pattern that is wider than a site pattern
 * (ports, *. versus **.) can admit nothing.
 */
import { browserAPI } from '../shared/browser-polyfill';
import { getSettings } from '../shared/storage';
import { patternsFor } from '../shared/site-patterns';

export const CONTENT_SCRIPT_ID = 'irondivi-content';
export const PROVIDER_SCRIPT_ID = 'irondivi-provider';

// The patterns the browser lets the extension run on. Chrome grants the
// manifest's host permissions at install; anything else the owner added must
// have been granted in Settings, or registering would fail.
async function granted(patterns: string[]): Promise<string[]> {
  const perms = browserAPI.permissions;
  if (!perms?.contains) return patterns;
  const ok: string[] = [];
  for (const origin of patterns) {
    try {
      if (await perms.contains({ origins: [origin] })) ok.push(origin);
    } catch {
      // A pattern the browser does not take is left out
    }
  }
  return ok;
}

// Startup, install and a settings change can each ask for a sync at once;
// they run one after another, or two would register the same ids
let syncQueue: Promise<unknown> = Promise.resolve();

/**
 * Register the content script and the provider for the allowed sites, or
 * remove them when no site is left. Safe to call at any time: it replaces
 * what was registered before.
 */
export function syncSiteScripts(): Promise<string[]> {
  const run = syncQueue.then(sync, sync);
  syncQueue = run.catch(() => {});
  return run;
}

async function sync(): Promise<string[]> {
  const scripting = browserAPI.scripting;
  if (!scripting?.registerContentScripts) {
    console.warn('IronDivi: this browser cannot register content scripts; the wallet is not available to sites');
    return [];
  }
  try {
    const { allowedSites } = await getSettings();
    const matches = await granted(patternsFor(allowedSites));
    const ids = [CONTENT_SCRIPT_ID, PROVIDER_SCRIPT_ID];
    const existing: Array<{ id: string }> = await scripting.getRegisteredContentScripts?.({ ids }) ?? [];
    if (existing.length > 0) {
      await scripting.unregisterContentScripts({ ids: existing.map(s => s.id) });
    }
    if (matches.length === 0) return [];
    await scripting.registerContentScripts([
      {
        id: CONTENT_SCRIPT_ID,
        matches,
        js: ['content-script.js'],
        runAt: 'document_start',
        persistAcrossSessions: true,
      },
      {
        // In the page's own world, at document_start, so window.irondivi is
        // there before any page script runs and no page script can take the
        // name first. No web-accessible file is needed for it.
        id: PROVIDER_SCRIPT_ID,
        matches,
        js: ['provider.js'],
        runAt: 'document_start',
        world: 'MAIN',
        persistAcrossSessions: true,
      },
    ]);
    return matches;
  } catch (error) {
    console.warn('IronDivi: could not register the wallet scripts for the allowed sites', error);
    return [];
  }
}
