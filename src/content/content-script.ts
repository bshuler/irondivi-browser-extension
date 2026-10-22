import { runtime, storage } from '../shared/browser-polyfill';
import { DEFAULT_SETTINGS, type Settings } from '../shared/storage';
import { DAPP_METHODS } from '../shared/constants';
import { isAllowedDappOrigin } from '../shared/origin';

// Message types for content script bridge
const PROVIDER_MESSAGE = 'IRONDIVI_PROVIDER_MESSAGE';
const PROVIDER_RESPONSE = 'IRONDIVI_PROVIDER_RESPONSE';

// Capture page origin once at initialization
const pageOrigin = window.location.origin;

/**
 * Get settings from storage with defaults
 */
async function getSettings(): Promise<Settings> {
  try {
    const { settings } = await storage.local.get<{ settings: Settings }>('settings');
    return { ...DEFAULT_SETTINGS, ...settings };
  } catch {
    return DEFAULT_SETTINGS;
  }
}

// Whether this page may use the wallet at all: same rule as the background
const siteAllowed: Promise<boolean> = getSettings()
  .then(settings => isAllowedDappOrigin(pageOrigin, settings.allowedSites))
  .catch(() => false);

/**
 * Inject the provider script into the page context
 */
function injectProvider() {
  const script = document.createElement('script');
  script.src = runtime.getURL('provider.js');
  // Don't use type="module" - load as regular script for synchronous execution
  script.onload = () => {
    script.remove();
  };
  (document.head || document.documentElement).appendChild(script);
}

/**
 * Listen for messages from the injected provider
 */
window.addEventListener('message', async (event) => {
  // Only accept messages from the same window
  if (event.source !== window) return;

  // Check for provider messages
  if (event.data?.type !== PROVIDER_MESSAGE) return;

  // Forward nothing from a page that is not allowed to use the wallet
  if (!(await siteAllowed)) return;

  // Validate required message fields before forwarding
  const { id, method, params } = event.data;
  if (!id || !method) return;

  // Forward only the methods the provider exposes; never popup messages
  if (typeof method !== 'string' || !DAPP_METHODS.includes(method)) {
    window.postMessage({
      type: PROVIDER_RESPONSE,
      id,
      response: { success: false, error: 'Unsupported method' },
    }, pageOrigin);
    return;
  }

  try {
    // Forward to background service worker, including origin for audit
    const response = await runtime.sendMessage({
      type: method,
      payload: params,
      origin: pageOrigin,
    });

    // Send response back to page
    window.postMessage({
      type: PROVIDER_RESPONSE,
      id,
      response,
    }, pageOrigin);
  } catch (error) {
    window.postMessage({
      type: PROVIDER_RESPONSE,
      id,
      response: {
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error'
      },
    }, pageOrigin);
  }
});

// Inject the provider only on allowed sites
siteAllowed.then(allowed => {
  if (allowed) injectProvider();
});
