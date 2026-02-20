import { runtime, storage } from '../shared/browser-polyfill';
import { DEFAULT_SETTINGS, type Settings } from '../shared/storage';

// Message types for content script bridge
const PROVIDER_MESSAGE = 'PDIVI_PROVIDER_MESSAGE';
const PROVIDER_RESPONSE = 'PDIVI_PROVIDER_RESPONSE';

// Capture page origin once at initialization
const pageOrigin = window.location.origin;

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
function isHostAllowed(hostname: string, allowedSites: string[]): boolean {
  for (const pattern of allowedSites) {
    const regex = globToRegex(pattern);
    if (regex.test(hostname)) {
      return true;
    }
  }
  return false;
}

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

/**
 * Validate that the origin is allowed to send messages.
 * - HTTPS origins are always allowed.
 * - HTTP is only allowed for localhost (127.0.0.1 or localhost hostname).
 * - All other schemes (file://, data://, javascript://, etc.) are rejected.
 */
function isValidOrigin(origin: string): boolean {
  try {
    const url = new URL(origin);

    if (url.protocol === 'https:') {
      return true;
    }

    if (url.protocol === 'http:') {
      const host = url.hostname;
      return host === 'localhost' || host === '127.0.0.1';
    }

    // file://, data://, javascript://, and all other protocols are rejected
    return false;
  } catch {
    // Unparseable origin string
    return false;
  }
}

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

  // Validate the page origin before forwarding any message
  if (!isValidOrigin(pageOrigin)) return;

  // Check for provider messages
  if (event.data?.type !== PROVIDER_MESSAGE) return;

  // Validate required message fields before forwarding
  const { id, method, params } = event.data;
  if (!id || !method) return;

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

// Check allowlist and inject provider if site is allowed
async function initializeProvider() {
  // First validate the origin is a valid protocol
  if (!isValidOrigin(pageOrigin)) return;

  try {
    const url = new URL(pageOrigin);
    const settings = await getSettings();

    // Check if this site is in the allowlist
    if (!isHostAllowed(url.hostname, settings.allowedSites)) {
      // Site not allowed - don't inject provider
      return;
    }

    // Site is allowed - inject provider and set up message listener
    injectProvider();
  } catch {
    // Failed to check allowlist - don't inject for safety
  }
}

// Initialize
initializeProvider();
