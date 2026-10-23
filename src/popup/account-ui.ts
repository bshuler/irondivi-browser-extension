/**
 * Account UI - account creation, import, selection, deletion
 */

import { elements } from './elements';
import { state } from './state';
import { showLoading, hideLoading, showToast, showView, hideView, clearPasswordInput } from './ui-state';
import { sendMessage } from './message-api';
import { showMnemonicModal, showPasswordModal } from './modals';
import { MSG, NETWORKS } from '../shared/constants';
import { Account } from './types';
import { loadBalance, loadTransactions } from './wallet-ui';

// ============================================================
// Pending Account Storage (survives popup close)
// ============================================================

interface PendingAccount {
  name: string;
  password: string;
  mnemonic: string;
}

const PENDING_ACCOUNT_KEY = 'irondivi_pending_account';

async function savePendingAccount(data: PendingAccount): Promise<void> {
  await chrome.storage.session.set({ [PENDING_ACCOUNT_KEY]: data });
}

async function getPendingAccount(): Promise<PendingAccount | null> {
  const result = await chrome.storage.session.get(PENDING_ACCOUNT_KEY);
  const pending = result[PENDING_ACCOUNT_KEY] as PendingAccount | undefined;
  return pending || null;
}

async function clearPendingAccount(): Promise<void> {
  await chrome.storage.session.remove(PENDING_ACCOUNT_KEY);
}

// ============================================================
// Data Loading
// ============================================================

/**
 * Load accounts from background
 */
export async function loadAccounts(): Promise<void> {
  try {
    const response = await sendMessage<{ accounts: Account[]; currentAccountId: string }>(MSG.GET_ACCOUNTS);
    state.accounts = response.accounts || [];

    if (response.currentAccountId) {
      state.currentAccount = state.accounts.find(a => a.id === response.currentAccountId) || null;
    }

    updateAccountDisplay();

    if (state.accounts.length === 0) {
      showView(elements.viewOnboarding);
    }
  } catch (error) {
    console.error('Failed to load accounts');
    showToast('Failed to load accounts. Please try again.', 'error');
  }
}

/**
 * A wallet made by 0.0.1 only has addresses on the network it was made on.
 * On any other, ask for its password once and add its first address there.
 */
export async function ensureNetworkAddresses(): Promise<void> {
  const account = state.currentAccount;
  if (!account || account.addresses.length > 0) return;

  const name = NETWORKS[state.settings.network].name;
  hideLoading();
  const password = await showPasswordModal(`Enter your password to set up your ${name} address`);
  if (!password) {
    showToast(`No ${name} address yet. Unlock the wallet to add one.`, 'error');
    return;
  }
  try {
    showLoading(`Setting up ${name}...`);
    await sendMessage(MSG.ADD_NETWORK_ADDRESSES, { accountId: account.id, password });
    await loadAccounts();
  } catch (error: unknown) {
    showToast(error instanceof Error ? error.message : `Failed to set up ${name}`, 'error');
  } finally {
    hideLoading();
  }
}

// ============================================================
// Display Updates
// ============================================================

/**
 * Update the account display in the header
 */
export function updateAccountDisplay(): void {
  if (!state.currentAccount) {
    elements.currentAccountName.textContent = 'No account';
    return;
  }

  elements.currentAccountName.textContent = state.currentAccount.name;

  // Update account list
  elements.accountList.innerHTML = '';
  state.accounts.forEach(account => {
    const item = document.createElement('button');
    item.className = 'menu-item';
    item.textContent = account.name;
    if (account.id === state.currentAccount?.id) {
      item.style.color = 'var(--accent)';
      item.style.fontWeight = '700';
    }
    item.addEventListener('click', () => selectAccount(account.id));
    elements.accountList.appendChild(item);
  });
}

// ============================================================
// Account Actions
// ============================================================

/**
 * Select an account
 */
export async function selectAccount(accountId: string): Promise<void> {
  try {
    showLoading('Switching account...');
    await sendMessage(MSG.SELECT_ACCOUNT, { accountId });
    await loadAccounts();
    state.selectedReceiveAddressIndex = 0;
    await ensureNetworkAddresses();
    await loadBalance();
    await loadTransactions();
    elements.accountMenu.classList.add('hidden');
    elements.accountDropdown.classList.remove('open');
  } catch (error) {
    showToast('Failed to switch account', 'error');
  } finally {
    hideLoading();
  }
}

/**
 * Create a new account
 * Flow: Generate mnemonic -> Save pending -> Show to user -> Create account after confirmation
 */
export async function createAccount(name: string, password: string, wordCount: number): Promise<void> {
  try {
    showLoading('Generating recovery phrase...');

    // Step 1: Generate mnemonic WITHOUT creating account
    const genResponse = await sendMessage<{ mnemonic: string }>(MSG.GENERATE_MNEMONIC, {
      wordCount,
    });

    // Step 2: Save pending account data (survives popup close)
    await savePendingAccount({ name, password, mnemonic: genResponse.mnemonic });

    hideLoading();

    // Step 3: Show mnemonic to user - must confirm before account is created
    await showMnemonicModal(genResponse.mnemonic, 'Save Your Recovery Phrase');

    // Step 4: User confirmed - NOW create the account
    await finalizePendingAccount();
  } catch (error: unknown) {
    const errorMessage = error instanceof Error ? error.message : 'Failed to create wallet';
    showToast(errorMessage, 'error');
  } finally {
    hideLoading();
  }
}

/**
 * Finalize a pending account after mnemonic confirmation
 */
async function finalizePendingAccount(): Promise<void> {
  const pending = await getPendingAccount();
  if (!pending) return;

  try {
    showLoading('Creating wallet...');
    const importResponse = await sendMessage<{ account: Account }>(MSG.IMPORT_ACCOUNT, {
      name: pending.name,
      mnemonic: pending.mnemonic,
      password: pending.password,
      network: state.settings.network,
    });

    // Clear pending data
    await clearPendingAccount();

    showToast(`Wallet created: ${importResponse.account.name}`, 'success');

    await loadAccounts();
    await loadBalance();
    hideView();
  } catch (error: unknown) {
    const errorMessage = error instanceof Error ? error.message : 'Failed to create wallet';
    showToast(errorMessage, 'error');
    throw error;
  } finally {
    hideLoading();
  }
}

/**
 * Check for and resume pending account creation (called on popup open)
 */
export async function checkPendingAccountCreation(): Promise<boolean> {
  const pending = await getPendingAccount();
  if (!pending) return false;

  // Show the mnemonic modal again
  await showMnemonicModal(pending.mnemonic, 'Save Your Recovery Phrase');

  // User confirmed - finalize the account
  await finalizePendingAccount();
  return true;
}

/**
 * Import an account from mnemonic
 */
export async function importAccount(name: string, mnemonic: string, password: string): Promise<void> {
  try {
    showLoading('Importing wallet...');
    const response = await sendMessage<{ account: Account }>(MSG.IMPORT_ACCOUNT, {
      name,
      mnemonic: mnemonic.trim(),
      password,
      network: state.settings.network,
    });

    showToast(`Wallet imported: ${response.account.name}`, 'success');
    await loadAccounts();
    await loadBalance();
    hideView();
  } catch (error: unknown) {
    const errorMessage = error instanceof Error ? error.message : 'Failed to import wallet';
    showToast(errorMessage, 'error');
  } finally {
    hideLoading();
  }
}

// ============================================================
// Form Handlers
// ============================================================

/**
 * Handle create account form submission
 */
async function handleCreateSubmit(): Promise<void> {
  const nameInput = document.getElementById('create-name') as HTMLInputElement;
  const passwordInput = document.getElementById('create-password') as HTMLInputElement;
  const confirmInput = document.getElementById('create-password-confirm') as HTMLInputElement;
  const wordCountSelect = document.getElementById('create-word-count') as HTMLSelectElement;

  const name = nameInput.value.trim() || 'My Wallet';
  const password = passwordInput.value;
  const confirm = confirmInput.value;
  const wordCount = parseInt(wordCountSelect.value);

  if (!password || password.length < 8) {
    showToast('Password must be at least 8 characters', 'error');
    return;
  }

  if (password !== confirm) {
    showToast('Passwords do not match', 'error');
    return;
  }

  try {
    await createAccount(name, password, wordCount);
  } finally {
    nameInput.value = '';
    clearPasswordInput(passwordInput);
    clearPasswordInput(confirmInput as HTMLInputElement);
  }
}

/**
 * Handle import account form submission
 */
async function handleImportSubmit(): Promise<void> {
  const nameInput = document.getElementById('import-name') as HTMLInputElement;
  const mnemonicInput = document.getElementById('import-mnemonic') as HTMLTextAreaElement;
  const passwordInput = document.getElementById('import-password') as HTMLInputElement;

  const name = nameInput.value.trim() || 'Imported Wallet';
  const mnemonic = mnemonicInput.value.trim();
  const password = passwordInput.value;

  if (!mnemonic) {
    showToast('Please enter a recovery phrase', 'error');
    return;
  }

  if (!password || password.length < 8) {
    showToast('Password must be at least 8 characters', 'error');
    return;
  }

  try {
    await importAccount(name, mnemonic, password);
  } finally {
    nameInput.value = '';
    mnemonicInput.value = '';
    clearPasswordInput(passwordInput);
  }
}

/**
 * Setup account UI event listeners
 */
export function setupAccountUIHandlers(): void {
  // Account selector
  elements.accountDropdown.addEventListener('click', () => {
    elements.accountMenu.classList.toggle('hidden');
    elements.accountDropdown.classList.toggle('open');
  });

  elements.addAccountBtn.addEventListener('click', () => {
    elements.accountMenu.classList.add('hidden');
    elements.accountDropdown.classList.remove('open');
    showView(elements.viewAddAccount);
  });

  // Close account menu when clicking outside
  document.addEventListener('click', (e) => {
    const target = e.target as HTMLElement;
    if (!target.closest('.account-selector')) {
      elements.accountMenu.classList.add('hidden');
      elements.accountDropdown.classList.remove('open');
    }
  });

  // Add account view
  document.getElementById('add-account-back-btn')?.addEventListener('click', hideView);

  document.getElementById('create-account-btn')?.addEventListener('click', () => {
    showView(elements.viewCreateAccount);
  });

  document.getElementById('import-account-btn')?.addEventListener('click', () => {
    showView(elements.viewImportAccount);
  });

  // Create account view
  document.getElementById('create-back-btn')?.addEventListener('click', () => {
    showView(elements.viewAddAccount);
  });

  document.getElementById('create-submit-btn')?.addEventListener('click', handleCreateSubmit);

  // Import account view
  document.getElementById('import-back-btn')?.addEventListener('click', () => {
    showView(elements.viewAddAccount);
  });

  document.getElementById('import-submit-btn')?.addEventListener('click', handleImportSubmit);

  // Onboarding view
  document.getElementById('onboard-create-btn')?.addEventListener('click', () => {
    showView(elements.viewCreateAccount);
  });

  document.getElementById('onboard-import-btn')?.addEventListener('click', () => {
    showView(elements.viewImportAccount);
  });
}
