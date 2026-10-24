import { runtime } from '../shared/browser-polyfill';
import { DAPP_METHODS, MSG } from '../shared/constants';

// Message types for content script bridge
const PROVIDER_MESSAGE = 'IRONDIVI_PROVIDER_MESSAGE';
const PROVIDER_RESPONSE = 'IRONDIVI_PROVIDER_RESPONSE';

// Capture page origin once at initialization
const pageOrigin = window.location.origin;

// Run once per page. This window is the content script's own isolated world,
// so the page cannot see or set the flag; a second copy (an extension reload)
// must not add a second relay or inject a second provider.
const firstCopy = !(window as any).__irondiviBridge;
(window as any).__irondiviBridge = true;

// Whether this page may use the wallet at all. The background decides from
// this tab's origin; a content script never reads extension storage.
const siteAllowed: Promise<boolean> = (runtime.sendMessage({ type: MSG.SITE_ALLOWED }) as Promise<any>)
  .then(r => r?.success === true && r.data?.allowed === true)
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
async function onPageMessage(event: MessageEvent) {
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
}

if (firstCopy) window.addEventListener('message', onPageMessage);

// Inject the provider only on allowed sites
siteAllowed.then(allowed => {
  if (allowed && firstCopy) injectProvider();
});
