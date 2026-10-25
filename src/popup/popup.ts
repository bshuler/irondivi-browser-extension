/**
 * Main popup orchestrator
 *
 * This file serves as the entry point and coordinator for the popup UI.
 * All substantive logic is delegated to specialized modules.
 */

import { elements } from './elements';
import { state } from './state';
import { showLoading, hideLoading, hideView } from './ui-state';
import { sendMessage, onPasswordAccepted } from './message-api';
import { MSG, UI_PORT } from '../shared/constants';
import { runtime } from '../shared/browser-polyfill';
import { setupMnemonicModalHandlers, showPasswordModal } from './modals';
import { setUnlockDeps } from './unlock-retry';
import { showRecordsWarning } from './records-warning-ui';
import { loadAccounts, setupAccountUIHandlers, checkPendingAccountCreation, ensureNetworkAddresses } from './account-ui';
import { loadBalance, loadTransactions, updateBalanceDisplay, setupWalletUIHandlers } from './wallet-ui';
import { setupSendUIHandlers } from './send-ui';
import { loadContacts, setupContactsUIHandlers } from './contacts-ui';
import { loadSettings, setupSettingsUIHandlers } from './settings-ui';
import { checkPendingRequests, setupSigningRequestUIHandlers } from './signing-request-ui';

// ============================================================
// Tab Management
// ============================================================

/**
 * Setup tab switching handlers
 */
function setupTabHandlers(): void {
  elements.tabs.forEach(tab => {
    tab.addEventListener('click', () => {
      const tabName = tab.dataset.tab;

      // Update tab button states
      elements.tabs.forEach(t => t.classList.remove('active'));
      tab.classList.add('active');

      // Update tab content visibility
      elements.tabActivity.classList.add('hidden');
      elements.tabActivity.classList.remove('active');
      elements.tabContacts.classList.add('hidden');
      elements.tabContacts.classList.remove('active');

      if (tabName === 'activity') {
        elements.tabActivity.classList.remove('hidden');
        elements.tabActivity.classList.add('active');
      } else if (tabName === 'contacts') {
        elements.tabContacts.classList.remove('hidden');
        elements.tabContacts.classList.add('active');
      }
    });
  });
}

// ============================================================
// Balance Toggle with Settings Sync
// ============================================================

/**
 * Setup balance toggle that syncs with settings
 */
function setupBalanceToggle(): void {
  elements.hideBalanceBtn.addEventListener('click', async () => {
    state.balanceHidden = !state.balanceHidden;
    state.settings.hideBalance = state.balanceHidden;
    updateBalanceDisplay();
    updateBalanceButtonIcon();
    // Save silently without toast
    try {
      await sendMessage(MSG.UPDATE_SETTINGS, { hideBalance: state.balanceHidden });
    } catch {
      // Ignore errors for balance toggle
    }
  });
}

/**
 * Update balance button icon based on state
 */
function updateBalanceButtonIcon(): void {
  elements.hideBalanceBtn.textContent = state.balanceHidden ? '👁️‍🗨️' : '👁️';
}

// ============================================================
// Event Listeners Setup
// ============================================================

/**
 * Setup all event listeners by delegating to module handlers
 */
function setupEventListeners(): void {
  // Core UI modules
  setupMnemonicModalHandlers();
  setUnlockDeps({
    ask: reason => showPasswordModal(reason),
    currentAccountId: () => state.currentAccount?.id,
    authenticate: async (accountId, password) => {
      const reply = await runtime.sendMessage({ type: MSG.AUTHENTICATE, payload: { accountId, password } });
      if (reply?.success) void showRecordsWarning();
      return reply;
    },
  });
  onPasswordAccepted(() => void showRecordsWarning());
  setupAccountUIHandlers();
  setupWalletUIHandlers();
  setupSendUIHandlers();
  setupContactsUIHandlers();
  setupSettingsUIHandlers();
  setupSigningRequestUIHandlers();

  // Tab management
  setupTabHandlers();

  // Balance toggle with settings sync (overrides wallet-ui handler)
  setupBalanceToggle();
}

// ============================================================
// Initialization
// ============================================================

/**
 * Check for approval request URL parameters
 * Returns true if this is an approval window
 */
function checkApprovalParams(): { type: string; requestId: string } | null {
  const params = new URLSearchParams(window.location.search);
  const approveType = params.get('approve');
  const requestId = params.get('requestId');

  if (approveType && requestId) {
    return { type: approveType, requestId };
  }
  return null;
}

/**
 * Initialize the popup
 */
async function init(): Promise<void> {
  // Held open while this window is; when the last wallet window closes, the
  // background locks the wallet. A browser without it still opens the popup.
  try {
    runtime.connect({ name: UI_PORT });
  } catch {
    console.warn('Could not tell the background this window is open');
  }
  setupEventListeners();

  showLoading('Loading wallet...');

  try {
    await loadSettings();
    updateBalanceButtonIcon();

    // An approval window only ever shows the request it was opened for; a
    // site can open one, so it must never resume a half-made wallet
    const approvalParams = checkApprovalParams();

    if (!approvalParams) {
      // Resume a wallet setup the user left before confirming the phrase
      const hadPendingAccount = await checkPendingAccountCreation();
      if (hadPendingAccount) {
        // Account was just created, loadAccounts was called in finalizePendingAccount
        hideLoading();
        return;
      }
    }

    await loadAccounts();
    // Every unlock can find the records changed; an approval window shows it too
    void showRecordsWarning();

    if (approvalParams) {
      // This is an approval popup - check for the specific pending request
      const hasPendingRequests = await checkPendingRequests(approvalParams.requestId);
      if (!hasPendingRequests) {
        // No pending requests found (maybe already handled)
        window.close();
      }
      hideLoading();
      return;
    }

    // Check for pending signing requests
    const hasPendingRequests = await checkPendingRequests();

    // If no pending requests, load normal wallet view
    if (!hasPendingRequests) {
      await ensureNetworkAddresses();
      await loadBalance();
      await loadTransactions();
      await loadContacts();
    }
  } catch (error) {
    console.error('Initialization error');
  } finally {
    hideLoading();
  }
}

// Start the app
init();
