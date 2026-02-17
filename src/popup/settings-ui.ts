/**
 * Settings UI - settings panel, network switching, connected sites
 */

import { elements } from './elements';
import { state } from './state';
import { showLoading, hideLoading, showToast, showView, hideView } from './ui-state';
import { sendMessage } from './message-api';
import { showMnemonicModal, showPasswordModal } from './modals';
import { MSG, NETWORKS, NetworkType } from '../shared/constants';
import { Settings, ConnectedSite } from './types';
import { updateBalanceDisplay, updateFaucetVisibility } from './wallet-ui';

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
    const response = await sendMessage<{ sites: ConnectedSite[] }>(MSG.GET_CONNECTED_SITES);
    updateConnectedSitesList(response.sites || []);
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
  elements.networkBadge.textContent = NETWORKS[state.settings.network].name;

  const networkSelect = document.getElementById('setting-network') as HTMLSelectElement;
  const hideBalanceCheck = document.getElementById('setting-hide-balance') as HTMLInputElement;
  const authTimeoutSelect = document.getElementById('setting-auth-timeout') as HTMLSelectElement;

  networkSelect.value = state.settings.network;
  hideBalanceCheck.checked = state.settings.hideBalance;
  authTimeoutSelect.value = String(state.settings.authTimeoutMinutes);
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

  // Network select
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
}
