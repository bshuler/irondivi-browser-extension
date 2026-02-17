/**
 * Main popup orchestrator
 *
 * This file serves as the entry point and coordinator for the popup UI.
 * All substantive logic is delegated to specialized modules.
 */

import { elements } from './elements';
import { state } from './state';
import { showLoading, hideLoading, hideView } from './ui-state';
import { setupMnemonicModalHandlers } from './modals';
import { loadAccounts, setupAccountUIHandlers } from './account-ui';
import { loadBalance, loadTransactions, updateBalanceDisplay, setupWalletUIHandlers } from './wallet-ui';
import { setupSendUIHandlers } from './send-ui';
import { loadContacts, setupContactsUIHandlers } from './contacts-ui';
import { loadSettings, updateSettings, setupSettingsUIHandlers } from './settings-ui';
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
  elements.hideBalanceBtn.addEventListener('click', () => {
    state.balanceHidden = !state.balanceHidden;
    updateBalanceDisplay();
    updateSettings({ hideBalance: state.balanceHidden });
  });
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
 * Initialize the popup
 */
async function init(): Promise<void> {
  setupEventListeners();

  showLoading('Loading wallet...');

  try {
    await loadSettings();
    await loadAccounts();

    // Check for pending signing requests first
    const hasPendingRequests = await checkPendingRequests();

    // If no pending requests, load normal wallet view
    if (!hasPendingRequests) {
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
