import { runtime } from '../shared/browser-polyfill';
import { DAPP_METHODS, MSG } from '../shared/constants';

// The provider in the page's world hands this script a private port
// (provider.ts explains the handshake); requests and answers go only over it
const PORT_EVENT = 'irondivi:port';
const READY_EVENT = 'irondivi:ready';

// Capture page origin once at initialization
const pageOrigin = window.location.origin;

// The background registers this script, and window.irondivi in the page's own
// world, only on the allowed sites (site-scripts.ts); nothing of the wallet
// runs on any other page.
//
// Run once per page. This window is the content script's own isolated world,
// so the page cannot see or set the flag; a second copy (an extension reload)
// must not add a second relay.
const firstCopy = !(window as any).__irondiviBridge;
(window as any).__irondiviBridge = true;

// Whether this page may use the wallet at all. The background decides from
// this tab's origin; a content script never reads extension storage.
const siteAllowed: Promise<boolean> = (runtime.sendMessage({ type: MSG.SITE_ALLOWED }) as Promise<any>)
  .then(r => r?.success === true && r.data?.allowed === true)
  .catch(() => false);

let port: MessagePort | null = null;

/**
 * Answer one request from the provider
 */
async function onProviderMessage(event: MessageEvent) {
  // Forward nothing from a page that is not allowed to use the wallet
  if (!(await siteAllowed)) return;

  // Validate required message fields before forwarding
  const { id, method, params } = event.data ?? {};
  if (!id || !method) return;
  const reply = (response: unknown) => port?.postMessage({ id, response });

  // Forward only the methods the provider exposes; never popup messages
  if (typeof method !== 'string' || !DAPP_METHODS.includes(method)) {
    reply({ success: false, error: 'Unsupported method' });
    return;
  }

  try {
    // Forward to background service worker, including origin for audit
    reply(await runtime.sendMessage({
      type: method,
      payload: params,
      origin: pageOrigin,
    }));
  } catch (error) {
    reply({
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error'
    });
  }
}

// Take the first port offered, which is the provider's: both run before any
// page script. A port offered later (by the page) is never taken.
function onPortOffer(event: Event) {
  const offered = (event as MessageEvent).ports?.[0];
  if (port || !offered) return;
  port = offered;
  port.onmessage = onProviderMessage;
  event.preventDefault();
  event.stopImmediatePropagation();
  window.removeEventListener(PORT_EVENT, onPortOffer);
}

if (firstCopy) {
  window.addEventListener(PORT_EVENT, onPortOffer);
  // The provider may have run first and be waiting for this
  window.dispatchEvent(new Event(READY_EVENT));
}
