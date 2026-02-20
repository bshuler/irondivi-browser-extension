/**
 * Settings UI - settings panel, network switching, connected sites
 */

import { elements } from './elements';
import { state } from './state';
import { showLoading, hideLoading, showToast, showView, hideView } from './ui-state';
import { sendMessage } from './message-api';
import { showMnemonicModal, showPasswordModal, showConfirmModal, showInputModal } from './modals';
import { MSG, NETWORKS, NetworkType } from '../shared/constants';
import { Settings, ConnectedSite } from './types';
import { updateBalanceDisplay, updateFaucetVisibility, loadBalance, loadTransactions } from './wallet-ui';
import { loadAccounts, updateAccountDisplay } from './account-ui';

// ============================================================
// Data Loading
// ============================================================

/**
 * Load settings from background
 */
export async function loadSettings(): Promise<void> {
  try {
    const response = await sendMessage<{ settings: Settings }>(MSG.GET_SETTINGS);
    state.settings = response.settings || state.settings;
    state.balanceHidden = state.settings.hideBalance;
    updateSettingsDisplay();
    updateBalanceDisplay();
  } catch (error) {
    console.error('Failed to load settings');
    showToast('Failed to load settings. Please try again.', 'error');
  }
}

/**
 * Load connected sites
 */
export async function loadConnectedSites(): Promise<void> {
  try {
    const sites = await sendMessage<ConnectedSite[]>(MSG.GET_CONNECTED_SITES);
    updateConnectedSitesList(sites || []);
  } catch (error) {
    console.error('Failed to load connected sites');
    updateConnectedSitesList([]);
  }
}

// ============================================================
// Display Updates
// ============================================================

/**
 * Update the settings display
 */
export function updateSettingsDisplay(): void {
  const networkName = elements.networkBadge.querySelector('.network-name');
  if (networkName) {
    networkName.textContent = NETWORKS[state.settings.network].name;
  } else {
    elements.networkBadge.textContent = NETWORKS[state.settings.network].name;
  }

  const networkSelect = document.getElementById('setting-network') as HTMLSelectElement;
  const hideBalanceCheck = document.getElementById('setting-hide-balance') as HTMLInputElement;
  const authTimeoutSelect = document.getElementById('setting-auth-timeout') as HTMLSelectElement;
  const txLimitPercentInput = document.getElementById('setting-tx-limit-percent') as HTMLInputElement;
  const txLimitAbsoluteInput = document.getElementById('setting-tx-limit-absolute') as HTMLInputElement;
  const allowedSitesTextarea = document.getElementById('setting-allowed-sites') as HTMLTextAreaElement;

  networkSelect.value = state.settings.network;
  hideBalanceCheck.checked = state.settings.hideBalance;
  authTimeoutSelect.value = String(state.settings.authTimeoutMinutes);

  // Transaction limits
  const limits = state.settings.transactionLimits || { maxAmountPercent: 10, maxAmountAbsolute: 0 };
  txLimitPercentInput.value = limits.maxAmountPercent > 0 ? String(limits.maxAmountPercent) : '';
  txLimitAbsoluteInput.value = limits.maxAmountAbsolute > 0 ? String(limits.maxAmountAbsolute) : '';

  // Allowed sites
  const sites = state.settings.allowedSites || ['*.divi.domains', 'localhost', '127.0.0.1'];
  allowedSitesTextarea.value = sites.join('\n');
}

/**
 * Update the connected sites list
 */
export function updateConnectedSitesList(sites: ConnectedSite[]): void {
  if (!elements.connectedSitesList) return;

  if (sites.length === 0) {
    elements.connectedSitesList.innerHTML = '';
    const emptyState = document.createElement('div');
    emptyState.className = 'empty-state';
    emptyState.style.padding = '16px 0';
    emptyState.style.fontSize = '13px';
    emptyState.textContent = 'No connected sites';
    elements.connectedSitesList.appendChild(emptyState);
    return;
  }

  elements.connectedSitesList.innerHTML = '';
  sites.forEach(site => {
    const item = document.createElement('div');
    item.className = 'connected-site-item';

    const originSpan = document.createElement('span');
    originSpan.className = 'connected-site-origin';
    originSpan.textContent = site.origin;

    const disconnectBtn = document.createElement('button');
    disconnectBtn.className = 'disconnect-btn';
    disconnectBtn.dataset.origin = site.origin;
    disconnectBtn.textContent = 'Disconnect';
    disconnectBtn.addEventListener('click', () => disconnectSite(site.origin));

    item.appendChild(originSpan);
    item.appendChild(disconnectBtn);

    elements.connectedSitesList.appendChild(item);
  });
}

// ============================================================
// Settings Actions
// ============================================================

/**
 * Update settings
 */
export async function updateSettings(updates: Partial<Settings>): Promise<void> {
  try {
    await sendMessage(MSG.UPDATE_SETTINGS, updates);
    state.settings = { ...state.settings, ...updates };
    updateSettingsDisplay();
    updateBalanceDisplay();
    updateFaucetVisibility();
    showToast('Settings updated', 'success');
  } catch (error: unknown) {
    const errorMessage = error instanceof Error ? error.message : 'Failed to update settings';
    showToast(errorMessage, 'error');
  }
}

/**
 * Disconnect a site
 */
export async function disconnectSite(origin: string): Promise<void> {
  try {
    showLoading('Disconnecting site...');
    await sendMessage(MSG.REVOKE_SITE, { origin });
    showToast(`Disconnected: ${origin}`, 'success');
    await loadConnectedSites();
  } catch (error: unknown) {
    const errorMessage = error instanceof Error ? error.message : 'Failed to disconnect site';
    showToast(errorMessage, 'error');
  } finally {
    hideLoading();
  }
}

/**
 * Export mnemonic
 */
async function handleExportMnemonic(): Promise<void> {
  const password = await showPasswordModal('Enter password to export recovery phrase');
  if (!password) return;

  try {
    showLoading('Exporting recovery phrase...');
    await sendMessage(MSG.AUTHENTICATE, { accountId: state.currentAccount?.id, password });
    const response = await sendMessage<{ mnemonic: string }>(MSG.EXPORT_MNEMONIC, {
      accountId: state.currentAccount?.id,
      password,
    });
    hideLoading();

    await showMnemonicModal(response.mnemonic, 'Your Recovery Phrase');
  } catch (error: unknown) {
    const errorMessage = error instanceof Error ? error.message : 'Failed to export recovery phrase';
    showToast(errorMessage, 'error');
  } finally {
    hideLoading();
  }
}

/**
 * Setup settings UI event listeners
 */
export function setupSettingsUIHandlers(): void {
  // Settings button in header
  elements.settingsBtn.addEventListener('click', () => {
    showView(elements.viewSettings);
    loadConnectedSites();
  });

  // Settings view back button
  document.getElementById('settings-back-btn')?.addEventListener('click', hideView);

  // Network badge dropdown
  const networkMenu = document.getElementById('network-menu');
  elements.networkBadge.addEventListener('click', (e) => {
    e.stopPropagation();
    networkMenu?.classList.toggle('hidden');
    elements.networkBadge.classList.toggle('open');
    // Update active state
    networkMenu?.querySelectorAll('.menu-item').forEach(item => {
      const itemNetwork = (item as HTMLElement).dataset.network;
      item.classList.toggle('active', itemNetwork === state.settings.network);
    });
  });

  // Network menu items
  networkMenu?.querySelectorAll('.menu-item').forEach(item => {
    item.addEventListener('click', async (e) => {
      e.stopPropagation();
      const network = (item as HTMLElement).dataset.network as NetworkType;
      if (network && network !== state.settings.network) {
        await updateSettings({ network });
        // Reload data for new network
        await loadBalance();
        await loadTransactions();
      }
      networkMenu.classList.add('hidden');
      elements.networkBadge.classList.remove('open');
    });
  });

  // Close network menu when clicking outside
  document.addEventListener('click', () => {
    networkMenu?.classList.add('hidden');
    elements.networkBadge.classList.remove('open');
  });

  // Network select in settings view
  document.getElementById('setting-network')?.addEventListener('change', (e) => {
    const network = (e.target as HTMLSelectElement).value as NetworkType;
    updateSettings({ network });
  });

  // Hide balance checkbox
  document.getElementById('setting-hide-balance')?.addEventListener('change', (e) => {
    const hideBalance = (e.target as HTMLInputElement).checked;
    updateSettings({ hideBalance });
  });

  // Auth timeout select
  document.getElementById('setting-auth-timeout')?.addEventListener('change', (e) => {
    const authTimeoutMinutes = parseInt((e.target as HTMLSelectElement).value);
    updateSettings({ authTimeoutMinutes });
  });

  // Export mnemonic button
  document.getElementById('export-mnemonic-btn')?.addEventListener('click', handleExportMnemonic);

  // Transaction limit (percent)
  document.getElementById('setting-tx-limit-percent')?.addEventListener('change', (e) => {
    const percent = parseInt((e.target as HTMLInputElement).value) || 0;
    const currentLimits = state.settings.transactionLimits || { maxAmountPercent: 0, maxAmountAbsolute: 0, dailyLimitAbsolute: 0, dailyLimitPercent: 0 };
    updateSettings({
      transactionLimits: { ...currentLimits, maxAmountPercent: Math.min(100, Math.max(0, percent)) }
    });
  });

  // Transaction limit (absolute)
  document.getElementById('setting-tx-limit-absolute')?.addEventListener('change', (e) => {
    const absolute = parseFloat((e.target as HTMLInputElement).value) || 0;
    const currentLimits = state.settings.transactionLimits || { maxAmountPercent: 0, maxAmountAbsolute: 0, dailyLimitAbsolute: 0, dailyLimitPercent: 0 };
    updateSettings({
      transactionLimits: { ...currentLimits, maxAmountAbsolute: Math.max(0, absolute) }
    });
  });

  // Allowed sites save button
  document.getElementById('save-allowed-sites-btn')?.addEventListener('click', () => {
    const textarea = document.getElementById('setting-allowed-sites') as HTMLTextAreaElement;
    const sites = textarea.value
      .split('\n')
      .map(s => s.trim())
      .filter(s => s.length > 0);
    updateSettings({ allowedSites: sites });
  });

  // Rename account button
  document.getElementById('rename-account-btn')?.addEventListener('click', async () => {
    if (!state.currentAccount) {
      showToast('No account selected', 'error');
      return;
    }

    const newName = await showInputModal(
      'Rename Account',
      'Enter new account name',
      state.currentAccount.name
    );

    if (!newName) return;

    try {
      showLoading('Renaming account...');
      await sendMessage(MSG.RENAME_ACCOUNT, {
        accountId: state.currentAccount.id,
        name: newName,
      });
      showToast('Account renamed', 'success');
      await loadAccounts();
      updateAccountDisplay();
    } catch (error: unknown) {
      const errorMessage = error instanceof Error ? error.message : 'Failed to rename account';
      showToast(errorMessage, 'error');
    } finally {
      hideLoading();
    }
  });

  // Delete account button
  document.getElementById('delete-account-btn')?.addEventListener('click', async () => {
    if (!state.currentAccount) {
      showToast('No account selected', 'error');
      return;
    }

    const confirmed = await showConfirmModal(
      'Delete Account',
      `Are you sure you want to delete "${state.currentAccount.name}"? This action cannot be undone. Make sure you have backed up your recovery phrase.`
    );

    if (!confirmed) return;

    const password = await showPasswordModal('Enter password to delete account');
    if (!password) return;

    try {
      showLoading('Deleting account...');
      await sendMessage(MSG.DELETE_ACCOUNT, {
        accountId: state.currentAccount.id,
        password,
      });
      showToast('Account deleted', 'success');
      hideView();
      await loadAccounts();
      await loadBalance();
      await loadTransactions();
    } catch (error: unknown) {
      const errorMessage = error instanceof Error ? error.message : 'Failed to delete account';
      showToast(errorMessage, 'error');
    } finally {
      hideLoading();
    }
  });
}
