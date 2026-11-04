/**
 * Settings UI - settings panel, network switching, connected sites
 */

import { refreshServerUI } from './server-ui';
import { elements } from './elements';
import { state } from './state';
import { showLoading, hideLoading, showToast, showView, hideView } from './ui-state';
import { sendMessage } from './message-api';
import { showMnemonicModal, showPasswordModal, showAuthModal, type AuthModalResult } from './modals';
import { MSG, NETWORKS, NetworkType } from '../shared/constants';
import {
  createAndVerifyPasskeyInWindow,
  fetchPasskeySlots,
  isTransientToolbarPopup,
  openPasskeyCeremonyWindow,
} from './passkey-client';
import type { PasskeySlotInfo } from '../shared/storage';
import { canonicalOrigin, DEFAULT_SITES, type SiteAccess } from '../shared/site-access';
import { checkSettingsUpdate } from '../shared/settings-check';
import { Settings, ConnectedSite, TransactionLimits } from './types';
import { updateBalanceDisplay, updateFaucetVisibility, loadBalance, loadTransactions } from './wallet-ui';
import {
  loadAccounts,
  ensureNetworkAddresses,
  renameCurrentAccount,
  removeCurrentAccount,
  clearOnboardingPassword,
  refreshOnboardingPasskeyOffer,
} from './account-ui';
import { loadPairings, setupConnectUIHandlers } from './connect-ui';

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
  // The stylesheet colours the whole popup by network (red Mainnet, purple Testnet)
  document.body.dataset.network = state.settings.network;
  void refreshServerUI();

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
  const dailyLimitPercentInput = document.getElementById('setting-daily-limit-percent') as HTMLInputElement;
  const dailyLimitAbsoluteInput = document.getElementById('setting-daily-limit-absolute') as HTMLInputElement;

  networkSelect.value = state.settings.network;
  hideBalanceCheck.checked = state.settings.hideBalance;
  const securityPhraseInput = document.getElementById('setting-security-phrase') as HTMLInputElement | null;
  if (securityPhraseInput) securityPhraseInput.value = state.settings.securityPhrase ?? '';
  authTimeoutSelect.value = String(state.settings.authTimeoutMinutes);

  // Spending limits (ADR 0002): off hides the numbers and says so in words
  const limits = currentLimits();
  (document.getElementById('setting-limits-enabled') as HTMLInputElement).checked = limits.enabled;
  (document.getElementById('limits-numbers') as HTMLElement).hidden = !limits.enabled;
  (document.getElementById('limits-off-note') as HTMLElement).hidden = limits.enabled;
  txLimitPercentInput.value = limits.maxAmountPercent > 0 ? String(limits.maxAmountPercent) : '';
  txLimitAbsoluteInput.value = limits.maxAmountAbsolute > 0 ? String(limits.maxAmountAbsolute) : '';
  dailyLimitPercentInput.value = limits.dailyLimitPercent > 0 ? String(limits.dailyLimitPercent) : '';
  dailyLimitAbsoluteInput.value = limits.dailyLimitAbsolute > 0 ? String(limits.dailyLimitAbsolute) : '';

  updateSiteAccessList();
}

/** The limits as the background has them, before settings first load: none, switch on */
function currentLimits(): TransactionLimits {
  return state.settings.transactionLimits
    || { enabled: true, maxAmountPercent: 0, maxAmountAbsolute: 0, dailyLimitAbsolute: 0, dailyLimitPercent: 0 };
}

const CHOICE_TEXT: Record<string, string> = { allowed: 'allowed', denied: 'never', not_now: 'not now' };

/**
 * The sites that asked for access and what the owner chose, per network, and
 * the sites the owner blocked
 */
export function updateSiteAccessList(): void {
  const list = document.getElementById('site-access-list');
  if (!list) return;
  const access: SiteAccess = state.settings.siteAccess ?? { grants: {}, blocked: {} };
  list.replaceChildren();
  const row = (origin: string, detail: string, buttons: Array<[string, () => void]>) => {
    const item = document.createElement('div');
    item.className = 'connected-site-item';
    const originSpan = document.createElement('span');
    originSpan.className = 'connected-site-origin';
    originSpan.textContent = origin;
    const detailSpan = document.createElement('span');
    detailSpan.className = 'connected-site-networks';
    detailSpan.textContent = detail;
    originSpan.append(' ', detailSpan);
    item.appendChild(originSpan);
    for (const [label, action] of buttons) {
      const btn = document.createElement('button');
      btn.className = 'disconnect-btn';
      btn.textContent = label;
      btn.addEventListener('click', action);
      item.appendChild(btn);
    }
    list.appendChild(item);
  };
  const origins = Object.keys(access.grants).filter(o => !(o in access.blocked)).sort();
  for (const origin of origins) {
    const detail = Object.entries(access.grants[origin] ?? {})
      .map(([net, g]) => `${NETWORKS[net as NetworkType]?.name ?? net}: ${CHOICE_TEXT[g!.state] ?? g!.state}`)
      .join(', ');
    row(origin, detail, [
      ['Forget', () => setSiteAccess('revoke', origin)],
      ['Block', () => setSiteAccess('block', origin)],
    ]);
  }
  for (const origin of Object.keys(access.blocked).sort()) {
    row(origin, 'blocked', [['Unblock', () => setSiteAccess('unblock', origin)]]);
  }
  if (!list.firstChild) {
    const empty = document.createElement('div');
    empty.className = 'empty-state';
    empty.style.padding = '8px 0';
    empty.style.fontSize = '13px';
    empty.textContent = 'No site has asked yet';
    list.appendChild(empty);
  }
  const defaults = document.getElementById('default-sites-list');
  if (defaults && !defaults.firstChild) {
    for (const origin of DEFAULT_SITES) {
      const li = document.createElement('li');
      li.textContent = origin;
      defaults.appendChild(li);
    }
  }
}

/**
 * Forget what the owner chose for a site, block it, or unblock it. Unblocking
 * loosens the records, so after a browser restart it asks for the password
 * (sendMessage retries after the unlock).
 */
async function setSiteAccess(action: 'revoke' | 'block' | 'unblock', origin: string): Promise<void> {
  try {
    const data = await sendMessage<{ siteAccess: SiteAccess }>(MSG.SET_SITE_ACCESS, { action, origin });
    state.settings = { ...state.settings, siteAccess: data.siteAccess };
    updateSiteAccessList();
    if (action !== 'unblock') await loadConnectedSites();
    showToast(action === 'block' ? `${origin} is blocked` : action === 'unblock' ? `${origin} is unblocked` : `${origin} must ask again`, 'success');
  } catch (error: unknown) {
    showToast(error instanceof Error ? error.message : 'Failed to update site access', 'error');
  }
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
    // A site connected on testnet asks again before it can ask on mainnet
    const networksSpan = document.createElement('span');
    networksSpan.className = 'connected-site-networks';
    networksSpan.textContent = (site.networks ?? []).length
      ? site.networks.map(n => NETWORKS[n]?.name ?? n).join(', ')
      : 'asks again';
    originSpan.append(' ', networksSpan);

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
  // Allowing a new site, raising or removing a limit, or a longer lock time
  // needs the wallet's password or passkey; the background refuses it otherwise
  const checked = checkSettingsUpdate(updates, state.settings as any);
  if (!checked.ok) {
    showToast(checked.error, 'error');
    updateSettingsDisplay();
    return;
  }
  let message: Partial<Settings> & AuthModalResult = updates;
  if (checked.loosens && state.accounts.length > 0) {
    const auth = await showAuthModal('Enter your password to change this setting');
    if (auth === null) {
      updateSettingsDisplay();
      return;
    }
    message = { ...updates, ...auth };
  }
  try {
    await sendMessage(MSG.UPDATE_SETTINGS, message);
    state.settings = { ...state.settings, ...checked.updates };
    updateSettingsDisplay();
    updateBalanceDisplay();
    updateFaucetVisibility();
    showToast('Settings updated', 'success');
  } catch (error: unknown) {
    const errorMessage = error instanceof Error ? error.message : 'Failed to update settings';
    showToast(errorMessage, 'error');
    updateSettingsDisplay();
  }
}

/**
 * Switch network and show the wallet's addresses, balance and history there
 */
async function switchNetwork(network: NetworkType): Promise<void> {
  const name = NETWORKS[network].name;
  // Moving a wallet between Mainnet and Testnet needs its password or passkey
  let auth: AuthModalResult | null = null;
  if (state.accounts.length > 0) {
    auth = await showAuthModal(`Enter your password to switch to ${name}`);
    if (auth === null) {
      updateSettingsDisplay();
      return;
    }
  }
  try {
    showLoading(`Switching to ${name}...`);
    await sendMessage(MSG.UPDATE_SETTINGS, auth === null ? { network } : { network, ...auth });
  } catch (error: unknown) {
    hideLoading();
    showToast(error instanceof Error ? error.message : 'Failed to switch network', 'error');
    updateSettingsDisplay();
    return;
  }
  state.settings = { ...state.settings, network };
  updateSettingsDisplay();
  updateBalanceDisplay();
  updateFaucetVisibility();
  hideLoading();
  showToast(`Switched to ${name}`, 'success');
  await loadAccounts();
  state.selectedReceiveAddressIndex = 0;
  await ensureNetworkAddresses();
  await loadBalance();
  await loadTransactions();
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
  const auth = await showAuthModal('Enter password to export recovery phrase');
  if (!auth) return;

  try {
    showLoading('Exporting recovery phrase...');
    await sendMessage(MSG.AUTHENTICATE, { accountId: state.currentAccount?.id || '', ...auth });
    const response = await sendMessage<{ mnemonic: string }>(MSG.EXPORT_MNEMONIC, {
      accountId: state.currentAccount?.id || '',
      ...auth,
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

function formatPasskeyDate(ts: number): string {
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

export async function refreshPasskeysSection(): Promise<void> {
  const listEl = document.getElementById('passkeys-list');
  const addBtn = document.getElementById('add-passkey-btn') as HTMLButtonElement | null;
  if (!listEl) return;

  const accountId = state.currentAccount?.id;
  if (addBtn) addBtn.disabled = !accountId;
  if (!accountId) {
    listEl.replaceChildren();
    return;
  }

  const slots = await fetchPasskeySlots(accountId);
  listEl.replaceChildren();
  void refreshOnboardingPasskeyOffer();

  if (slots.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'empty-state';
    empty.style.padding = '8px 0';
    empty.style.fontSize = '13px';
    empty.textContent = 'No passkeys enrolled';
    listEl.appendChild(empty);
    return;
  }

  for (const slot of slots) {
    const row = document.createElement('div');
    row.className = 'passkey-item';

    const info = document.createElement('div');
    info.className = 'passkey-item-info';

    const labelEl = document.createElement('span');
    labelEl.className = 'passkey-item-label';
    labelEl.textContent = slot.label;

    const dateEl = document.createElement('span');
    dateEl.className = 'passkey-item-date';
    dateEl.textContent = `Added ${formatPasskeyDate(slot.createdAt)}`;

    info.append(labelEl, dateEl);

    const removeBtn = document.createElement('button');
    removeBtn.type = 'button';
    removeBtn.className = 'disconnect-btn';
    removeBtn.dataset.testid = 'remove-passkey-btn';
    removeBtn.dataset.slotId = slot.id;
    removeBtn.textContent = 'Remove';
    removeBtn.addEventListener('click', () => {
      void handleRemovePasskey(slot);
    });

    row.append(info, removeBtn);
    listEl.appendChild(row);
  }
}

export async function enrolPasskeyForAccount(
  accountId: string,
  opts?: { password?: string; label?: string },
): Promise<boolean> {
  const password = opts?.password ?? (await showPasswordModal('Enter your password to add a passkey'));
  if (!password) return false;

  let enrolData: {
    token: string;
    accountId: string;
    accountName: string;
    label: string;
    existingCredentialIds: string[];
  };

  try {
    showLoading('Preparing passkey enrolment...');
    enrolData = await sendMessage(MSG.START_PASSKEY_ENROL, {
      accountId,
      password,
      label: opts?.label,
    });
    hideLoading();
  } catch (err) {
    hideLoading();
    showToast(err instanceof Error ? err.message : 'Failed to start passkey enrolment', 'error');
    return false;
  }

  if (await isTransientToolbarPopup()) {
    try {
      await openPasskeyCeremonyWindow({
        mode: 'enrol',
        token: enrolData.token,
      });
      clearOnboardingPassword();
      return true;
    } catch (err) {
      await sendMessage(MSG.CANCEL_PASSKEY_ENROL, { token: enrolData.token }).catch(() => {});
      showToast(err instanceof Error ? err.message : 'Could not open passkey window', 'error');
      return false;
    }
  }

  try {
    showLoading('Waiting for passkey...');
    const created = await createAndVerifyPasskeyInWindow({
      accountName: enrolData.accountName,
      label: enrolData.label,
      existingCredentialIds: enrolData.existingCredentialIds,
    });

    await sendMessage(MSG.FINISH_PASSKEY_ENROL, {
      token: enrolData.token,
      credentialId: created.credentialId,
      prfSalt: created.prfSalt,
      prfOutput: created.prfOutput,
      label: enrolData.label,
    });

    clearOnboardingPassword();
    const labelInput = document.getElementById('new-passkey-label') as HTMLInputElement | null;
    if (labelInput) labelInput.value = '';
    await refreshPasskeysSection();
    await refreshOnboardingPasskeyOffer();
    showToast('Passkey added', 'success');
    return true;
  } catch (err) {
    await sendMessage(MSG.CANCEL_PASSKEY_ENROL, { token: enrolData.token }).catch(() => {});
    showToast(err instanceof Error ? err.message : 'Failed to add passkey', 'error');
    return false;
  } finally {
    hideLoading();
  }
}

async function handleAddPasskey(): Promise<void> {
  const account = state.currentAccount;
  if (!account) {
    showToast('No wallet open', 'error');
    return;
  }

  const labelInput = document.getElementById('new-passkey-label') as HTMLInputElement | null;
  const requestedLabel = labelInput?.value.trim() || undefined;
  await enrolPasskeyForAccount(account.id, { label: requestedLabel });
}

async function handleRemovePasskey(slot: PasskeySlotInfo): Promise<void> {
  const account = state.currentAccount;
  if (!account) return;

  const auth = await showAuthModal(`Verify to remove “${slot.label}”`, account.id);
  if (!auth) return;

  try {
    showLoading('Removing passkey...');
    await sendMessage(MSG.REMOVE_PASSKEY_SLOT, {
      accountId: account.id,
      slotId: slot.id,
      ...auth,
    });
    await refreshPasskeysSection();
    showToast('Passkey removed', 'success');
  } catch (err) {
    showToast(err instanceof Error ? err.message : 'Failed to remove passkey', 'error');
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
    loadPairings();
    void refreshPasskeysSection();
  });
  setupConnectUIHandlers();
  document.getElementById('add-passkey-btn')?.addEventListener('click', () => {
    void handleAddPasskey();
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
      networkMenu.classList.add('hidden');
      elements.networkBadge.classList.remove('open');
      if (network && network !== state.settings.network) {
        await switchNetwork(network);
      }
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
    switchNetwork(network);
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

  // The Spending limits switch: off asks for the password, on does not
  document.getElementById('setting-limits-enabled')?.addEventListener('change', (e) => {
    const enabled = (e.target as HTMLInputElement).checked;
    updateSettings({ transactionLimits: { ...currentLimits(), enabled } });
  });

  // Transaction limit (percent)
  document.getElementById('setting-tx-limit-percent')?.addEventListener('change', (e) => {
    const percent = parseInt((e.target as HTMLInputElement).value) || 0;
    updateSettings({
      transactionLimits: { ...currentLimits(), maxAmountPercent: Math.min(100, Math.max(0, percent)) }
    });
  });

  // Transaction limit (absolute)
  document.getElementById('setting-tx-limit-absolute')?.addEventListener('change', (e) => {
    const absolute = parseFloat((e.target as HTMLInputElement).value) || 0;
    updateSettings({
      transactionLimits: { ...currentLimits(), maxAmountAbsolute: Math.max(0, absolute) }
    });
  });

  // Daily limit (percent)
  document.getElementById('setting-daily-limit-percent')?.addEventListener('change', (e) => {
    const percent = parseInt((e.target as HTMLInputElement).value) || 0;
    updateSettings({
      transactionLimits: { ...currentLimits(), dailyLimitPercent: Math.min(100, Math.max(0, percent)) }
    });
  });

  // Daily limit (absolute)
  document.getElementById('setting-daily-limit-absolute')?.addEventListener('change', (e) => {
    const absolute = parseFloat((e.target as HTMLInputElement).value) || 0;
    updateSettings({
      transactionLimits: { ...currentLimits(), dailyLimitAbsolute: Math.max(0, absolute) }
    });
  });

  // Block a site by its address
  document.getElementById('block-site-btn')?.addEventListener('click', () => {
    const input = document.getElementById('block-site-input') as HTMLInputElement;
    const origin = canonicalOrigin(input.value);
    if (!origin) {
      showToast('Enter a site as https://name', 'error');
      return;
    }
    input.value = '';
    setSiteAccess('block', origin);
  });

  // The phrase approval windows show (EXT-18); changing it asks for the password
  document.getElementById('save-security-phrase-btn')?.addEventListener('click', () => {
    const input = document.getElementById('setting-security-phrase') as HTMLInputElement;
    updateSettings({ securityPhrase: input.value.trim() });
  });

  // Rename / remove the open wallet (the same actions as the wallet menu)
  document.getElementById('rename-account-btn')?.addEventListener('click', renameCurrentAccount);
  document.getElementById('delete-account-btn')?.addEventListener('click', removeCurrentAccount);
}
