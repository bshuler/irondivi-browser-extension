/**
 * WalletConnect WalletKit integration for the IronDivi extension.
 *
 * Implements the "responder" side of WalletConnect v2:
 *   - Receives session proposals from dApps and prompts user for approval
 *   - Receives session requests (divi_sendTransaction, divi_signMessage)
 *     and routes them through the existing approval UI
 *   - Persists sessions internally via WalletKit (survives service-worker restarts)
 *
 * The popup communicates with this module via chrome.runtime messages
 * prefixed with `wc_`.
 */

import { Core } from '@walletconnect/core';
import { WalletKit, type IWalletKit } from '@reown/walletkit';

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

// Injected by esbuild from the IRONDIVI_WC_PROJECT_ID environment variable
declare const __IRONDIVI_WC_PROJECT_ID__: string;
const PROJECT_ID = __IRONDIVI_WC_PROJECT_ID__;
const RELAY_URL = 'wss://relay.walletconnect.com';

const METADATA = {
  name: 'IronDivi Wallet',
  description: 'IronDivi Browser Extension Wallet',
  url: 'https://divi.domains',
  icons: ['https://divi.domains/icon.png'],
};

// Supported JSON-RPC methods on the "divi" namespace
const SUPPORTED_METHODS = ['divi_sendTransaction', 'divi_signMessage'];
const SUPPORTED_EVENTS = ['accountsChanged', 'chainChanged'];

// Keep-alive alarm name (prevents Chrome from killing the service worker
// while an active WalletConnect session exists)
const KEEPALIVE_ALARM = 'wc-keepalive';

// ---------------------------------------------------------------------------
// Singleton state
// ---------------------------------------------------------------------------

let walletKit: IWalletKit | null = null;
let initPromise: Promise<IWalletKit> | null = null;

// ---------------------------------------------------------------------------
// Initialization
// ---------------------------------------------------------------------------

/**
 * Initialize (or return existing) WalletKit instance.
 * Safe to call multiple times; subsequent calls return the cached instance.
 */
export async function initWalletConnect(): Promise<IWalletKit> {
  if (walletKit) return walletKit;
  if (initPromise) return initPromise;

  if (!PROJECT_ID) {
    throw new Error('WalletConnect is disabled: this build has no IRONDIVI_WC_PROJECT_ID');
  }

  initPromise = (async () => {
    try {
      const core = new Core({ projectId: PROJECT_ID, relayUrl: RELAY_URL });
      const wk = await WalletKit.init({ core, metadata: METADATA });

      setupEventHandlers(wk);
      walletKit = wk;

      // Start keep-alive alarm if there are active sessions
      refreshKeepAlive();

      return wk;
    } catch (err) {
      initPromise = null; // Allow retry on next call
      throw err;
    }
  })();

  return initPromise;
}

// ---------------------------------------------------------------------------
// Event handlers
// ---------------------------------------------------------------------------

function setupEventHandlers(wk: IWalletKit) {
  // ---- Session Proposal ----
  wk.on('session_proposal', async (proposal) => {
    console.log('[WC] session_proposal', proposal.id);

    // Persist the proposal so the popup can read it
    await chrome.storage.local.set({
      wcPendingProposal: {
        id: proposal.id,
        params: proposal.params,
        timestamp: Date.now(),
      },
    });

    // Open approval popup
    openApprovalPopup('wc_proposal');
  });

  // ---- Session Request (RPC call from dApp) ----
  wk.on('session_request', async (event) => {
    const { id, topic, params } = event;
    const { request } = params;
    const { method, params: reqParams } = request;

    console.log('[WC] session_request', method, id);

    if (SUPPORTED_METHODS.includes(method)) {
      // Store request for popup approval
      await chrome.storage.local.set({
        wcPendingRequest: {
          id,
          topic,
          method,
          params: reqParams,
          timestamp: Date.now(),
        },
      });

      openApprovalPopup('wc_request');
    } else {
      // Reject unsupported methods immediately
      await wk.respondSessionRequest({
        topic,
        response: {
          id,
          jsonrpc: '2.0',
          error: { code: 4001, message: `Method ${method} not supported` },
        },
      });
    }
  });

  // ---- Session Delete ----
  wk.on('session_delete', () => {
    console.log('[WC] session_delete');
    refreshKeepAlive();
  });
}

// ---------------------------------------------------------------------------
// Popup helper
// ---------------------------------------------------------------------------

function openApprovalPopup(param: 'wc_proposal' | 'wc_request') {
  // Try the action.openPopup API first (Chrome 127+), fall back to windows.create
  if (typeof chrome.action?.openPopup === 'function') {
    chrome.action.openPopup().catch(() => {
      createPopupWindow(param);
    });
  } else {
    createPopupWindow(param);
  }
}

async function createPopupWindow(param: string) {
  const width = 400;
  const height = 600;
  let left = 100;
  let top = 100;

  try {
    const windows = await chrome.windows.getAll({ windowTypes: ['normal'] });
    if (windows.length > 0) {
      const ref = windows[0];
      left = Math.round((ref.left || 0) + ((ref.width || 800) - width) / 2);
      top = Math.round((ref.top || 0) + ((ref.height || 600) - height) / 2);
    }
  } catch {
    // use defaults
  }

  try {
    await chrome.windows.create({
      url: `popup.html?${param}=true`,
      type: 'popup',
      width,
      height,
      left,
      top,
      focused: true,
    });
  } catch {
    // popup creation failed - request will timeout via WalletConnect relay
  }
}

// ---------------------------------------------------------------------------
// Keep-alive alarm
// ---------------------------------------------------------------------------

function refreshKeepAlive() {
  const sessions = walletKit?.getActiveSessions() ?? {};
  const hasActive = Object.keys(sessions).length > 0;

  if (hasActive) {
    // Ping every 25 seconds to keep the service worker alive
    chrome.alarms.create(KEEPALIVE_ALARM, { periodInMinutes: 25 / 60 });
  } else {
    chrome.alarms.clear(KEEPALIVE_ALARM).catch(() => {});
  }
}

// ---------------------------------------------------------------------------
// Public API  (called from service-worker message handlers)
// ---------------------------------------------------------------------------

/**
 * Pair with a WalletConnect URI (from QR code or deep link).
 */
export async function pair(uri: string): Promise<void> {
  const wk = await initWalletConnect();
  await wk.pair({ uri });
}

/**
 * Approve a pending session proposal.
 * @param proposalId  - the proposal numeric ID
 * @param addresses   - wallet addresses to expose
 * @param network     - "mainnet" or "testnet"
 */
export async function approveSessionProposal(
  proposalId: number,
  addresses: string[],
  network: string,
): Promise<void> {
  const wk = await initWalletConnect();

  const chainId = `divi:${network}`;

  await wk.approveSession({
    id: proposalId,
    namespaces: {
      divi: {
        chains: [chainId],
        methods: SUPPORTED_METHODS,
        events: SUPPORTED_EVENTS,
        accounts: addresses.map((a) => `${chainId}:${a}`),
      },
    },
  });

  await chrome.storage.local.remove('wcPendingProposal');
  refreshKeepAlive();
}

/**
 * Reject a pending session proposal.
 */
export async function rejectSessionProposal(proposalId: number): Promise<void> {
  const wk = await initWalletConnect();
  await wk.rejectSession({
    id: proposalId,
    reason: { code: 4001, message: 'User rejected' },
  });
  await chrome.storage.local.remove('wcPendingProposal');
}

/**
 * Respond to a pending session request with a successful result.
 */
export async function respondToRequest(
  topic: string,
  requestId: number,
  result: unknown,
): Promise<void> {
  const wk = await initWalletConnect();
  await wk.respondSessionRequest({
    topic,
    response: { id: requestId, jsonrpc: '2.0', result },
  });
  await chrome.storage.local.remove('wcPendingRequest');
}

/**
 * Respond to a pending session request with an error.
 */
export async function rejectRequest(
  topic: string,
  requestId: number,
  message: string,
): Promise<void> {
  const wk = await initWalletConnect();
  await wk.respondSessionRequest({
    topic,
    response: {
      id: requestId,
      jsonrpc: '2.0',
      error: { code: 4001, message },
    },
  });
  await chrome.storage.local.remove('wcPendingRequest');
}

/**
 * Return all active WalletConnect sessions.
 */
export function getActiveSessions(): Record<string, unknown> {
  if (!walletKit) return {};
  return walletKit.getActiveSessions();
}

/**
 * Disconnect a specific session by topic.
 */
export async function disconnectSession(topic: string): Promise<void> {
  const wk = await initWalletConnect();
  await wk.disconnectSession({
    topic,
    reason: { code: 6000, message: 'User disconnected' },
  });
  refreshKeepAlive();
}
