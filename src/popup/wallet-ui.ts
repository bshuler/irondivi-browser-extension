/**
 * Wallet UI - balance display, transaction list, address display
 */

import { elements } from './elements';
import { state } from './state';
import { formatAddress, formatAmount, showToast, showView, hideView } from './ui-state';
import { sendMessage } from './message-api';
import { MSG, NETWORKS } from '../shared/constants';
import { Account, Transaction, Contact, ConnectedSite, getPrimaryAddress } from './types';
import QRCode from 'qrcode';

// ============================================================
// Data Loading
// ============================================================

/**
 * Load balance for the current account
 */
export async function loadBalance(): Promise<void> {
  if (!state.currentAccount) return;

  try {
    const response = await sendMessage<{ balance: number }>(MSG.GET_BALANCE);
    state.balance = response.balance || 0;
    updateBalanceDisplay();
  } catch (error) {
    console.error('Failed to load balance');
    showToast('Failed to load balance. Please try again.', 'error');
  }
}

/**
 * Load transactions for the current account
 */
export async function loadTransactions(): Promise<void> {
  if (!state.currentAccount) return;

  try {
    const response = await sendMessage<{ transactions: Transaction[] }>(MSG.GET_TRANSACTIONS);
    state.transactions = response.transactions || [];
    updateTransactionList();
  } catch (error) {
    console.error('Failed to load transactions');
    showToast('Failed to load transactions. Please try again.', 'error');
  }
}

// ============================================================
// Display Updates
// ============================================================

/**
 * Update the balance display
 */
export function updateBalanceDisplay(): void {
  if (state.balanceHidden) {
    elements.balanceAmount.textContent = '\u2022\u2022\u2022\u2022\u2022\u2022';
    elements.balanceAmount.classList.add('hidden-balance');
  } else {
    elements.balanceAmount.textContent = formatAmount(state.balance);
    elements.balanceAmount.classList.remove('hidden-balance');
  }
}

/**
 * Update faucet section visibility based on network
 */
export function updateFaucetVisibility(): void {
  const faucetSection = document.getElementById('faucet-section') as HTMLDivElement;
  if (!faucetSection) return;

  // Only show faucet on testnet
  faucetSection.style.display = state.settings.network === 'testnet' ? 'block' : 'none';
}

/**
 * Format a transaction timestamp for display.
 * - Within last 24 hours: relative time ("2 hours ago", "30 minutes ago")
 * - Within last 7 days: day name ("Monday")
 * - Older: "Jan 15, 2024"
 */
export function formatTxDate(timestamp: number): string {
  const now = Date.now();
  const diffMs = now - timestamp;
  const diffMinutes = Math.floor(diffMs / 60_000);
  const diffHours = Math.floor(diffMs / 3_600_000);
  const diffDays = Math.floor(diffMs / 86_400_000);

  if (diffMinutes < 1) {
    return 'Just now';
  } else if (diffHours < 1) {
    return `${diffMinutes} minute${diffMinutes === 1 ? '' : 's'} ago`;
  } else if (diffHours < 24) {
    return `${diffHours} hour${diffHours === 1 ? '' : 's'} ago`;
  } else if (diffDays < 7) {
    return new Date(timestamp).toLocaleDateString('en-US', { weekday: 'long' });
  } else {
    return new Date(timestamp).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
  }
}

/**
 * Update the transaction list display
 */
export function updateTransactionList(): void {
  if (state.transactions.length === 0) {
    elements.transactionList.innerHTML = '';
    const emptyState = document.createElement('div');
    emptyState.className = 'empty-state';
    emptyState.textContent = 'No transactions yet';
    elements.transactionList.appendChild(emptyState);
    return;
  }

  elements.transactionList.innerHTML = '';
  state.transactions.forEach(tx => {
    const item = document.createElement('div');
    item.className = 'transaction-item';

    const contact = state.contacts.find(c => c.address === tx.address);
    const displayName = contact?.name || formatAddress(tx.address);

    // tx-icon
    const txIcon = document.createElement('div');
    txIcon.className = `tx-icon ${tx.type}`;
    txIcon.textContent = tx.type === 'send' ? '\u2191' : '\u2193';

    // tx-details
    const txDetails = document.createElement('div');
    txDetails.className = 'tx-details';

    const txTitle = document.createElement('div');
    txTitle.className = 'tx-title';
    txTitle.textContent = tx.type === 'send' ? 'Sent to' : 'Received from';
    if (contact) {
      const contactSpan = document.createElement('span');
      contactSpan.style.color = 'var(--accent)';
      contactSpan.textContent = displayName;
      txTitle.appendChild(document.createTextNode(' '));
      txTitle.appendChild(contactSpan);
    }

    const txAddress = document.createElement('div');
    txAddress.className = 'tx-address';
    txAddress.textContent = contact ? tx.address : displayName;

    const confirmationsEl = document.createElement('span');
    confirmationsEl.className = tx.confirmations === 0
      ? 'tx-confirmations unconfirmed'
      : 'tx-confirmations';
    confirmationsEl.textContent = tx.confirmations === 0
      ? 'Unconfirmed'
      : `${tx.confirmations} confirmation${tx.confirmations === 1 ? '' : 's'}`;

    const txDateEl = document.createElement('span');
    txDateEl.className = 'tx-date';
    txDateEl.textContent = tx.timestamp ? formatTxDate(tx.timestamp) : '';

    txDetails.appendChild(txTitle);
    txDetails.appendChild(txAddress);
    txDetails.appendChild(confirmationsEl);
    if (tx.timestamp) txDetails.appendChild(txDateEl);

    // tx-amount
    const txAmount = document.createElement('div');
    txAmount.className = `tx-amount ${tx.type}`;
    txAmount.textContent = `${tx.type === 'send' ? '-' : '+'}${formatAmount(tx.amount)} PDIVI`;

    item.appendChild(txIcon);
    item.appendChild(txDetails);
    item.appendChild(txAmount);

    item.addEventListener('click', () => {
      const explorerUrl = NETWORKS[state.settings.network].explorerUrl + tx.txid;
      window.open(explorerUrl, '_blank');
    });

    elements.transactionList.appendChild(item);
  });
}

// ============================================================
// Receive View Handlers
// ============================================================

/**
 * Populate the receive address dropdown
 */
function populateReceiveAddressDropdown(): void {
  if (!state.currentAccount) return;

  const select = document.getElementById('receive-address-select') as HTMLSelectElement;
  select.innerHTML = '';

  // Add all existing addresses
  state.currentAccount.addresses.forEach((addr, idx) => {
    const option = document.createElement('option');
    option.value = String(idx);
    const shortAddr = `${addr.address.slice(0, 8)}...${addr.address.slice(-6)}`;
    option.textContent = `Address ${idx + 1}: ${shortAddr}`;
    select.appendChild(option);
  });

  // Add "Generate new address" option
  const newOption = document.createElement('option');
  newOption.value = 'new';
  newOption.textContent = '+ Generate new address';
  select.appendChild(newOption);

  // Set current selection
  select.value = String(state.selectedReceiveAddressIndex);
}

/**
 * Update the QR code and address display for selected address
 */
async function updateReceiveAddressDisplay(): Promise<void> {
  if (!state.currentAccount) return;

  const addr = state.currentAccount.addresses[state.selectedReceiveAddressIndex];
  if (!addr) return;

  const qrContainer = document.getElementById('qr-code') as HTMLDivElement;
  qrContainer.innerHTML = '';

  try {
    const canvas = await QRCode.toCanvas(addr.address, {
      width: 124,
      margin: 0,
      color: {
        dark: '#000000',
        light: '#ffffff',
      },
    });
    qrContainer.appendChild(canvas);
  } catch (error) {
    console.error('Failed to generate QR code');
  }

  const addressDisplay = document.getElementById('receive-address') as HTMLDivElement;
  addressDisplay.textContent = addr.address;
}

/**
 * Handle receive address selection change
 */
async function handleReceiveAddressChange(): Promise<void> {
  const select = document.getElementById('receive-address-select') as HTMLSelectElement;

  if (select.value === 'new') {
    // Generate new address - requires password
    const { showPasswordModal } = await import('./modals');
    const password = await showPasswordModal('Enter password to generate new address');

    if (!password) {
      // User cancelled - revert selection
      select.value = String(state.selectedReceiveAddressIndex);
      return;
    }

    try {
      const response = await sendMessage<{ address: { index: number; address: string; path: string } }>(
        MSG.GENERATE_NEW_ADDRESS,
        { accountId: state.currentAccount!.id, password }
      );

      // Add the new address to the current account
      state.currentAccount!.addresses.push(response.address);
      state.selectedReceiveAddressIndex = response.address.index;

      // Refresh dropdown and display
      populateReceiveAddressDropdown();
      await updateReceiveAddressDisplay();
      updateFaucetCooldownState();
      showToast('New address generated', 'success');
    } catch (error: unknown) {
      const errorMessage = error instanceof Error ? error.message : 'Failed to generate address';
      showToast(errorMessage, 'error');
      select.value = String(state.selectedReceiveAddressIndex);
    }
  } else {
    state.selectedReceiveAddressIndex = parseInt(select.value, 10);
    await updateReceiveAddressDisplay();
    updateFaucetCooldownState();
  }
}

/**
 * Handle showing the receive view with QR code
 */
export async function handleReceiveView(): Promise<void> {
  showView(elements.viewReceive);

  if (!state.currentAccount) return;

  // Populate address dropdown
  populateReceiveAddressDropdown();

  // Display selected address
  await updateReceiveAddressDisplay();

  // Update faucet visibility and cooldown state
  updateFaucetVisibility();
  updateFaucetCooldownState();
}

/**
 * Handle copying the receive address
 */
export async function handleCopyAddress(): Promise<void> {
  if (!state.currentAccount) return;

  const primaryAddress = getPrimaryAddress(state.currentAccount);
  if (!primaryAddress) {
    showToast('No address available', 'error');
    return;
  }

  try {
    await navigator.clipboard.writeText(primaryAddress);
    showToast('Address copied to clipboard', 'success');
  } catch (error) {
    showToast('Failed to copy address', 'error');
  }
}

const FAUCET_COOLDOWN_MS = 60 * 60 * 1000; // 1 hour cooldown
const FAUCET_COOLDOWN_PREFIX = 'pdivi_faucet_'; // Per-address cooldown: pdivi_faucet_{address}

/**
 * Get the currently selected receive address
 */
function getSelectedReceiveAddress(): string | null {
  if (!state.currentAccount) return null;
  const addr = state.currentAccount.addresses[state.selectedReceiveAddressIndex];
  return addr?.address || null;
}

/**
 * Update faucet button state based on cooldown for current address
 */
export function updateFaucetCooldownState(): void {
  const faucetBtn = document.getElementById('request-faucet-btn') as HTMLButtonElement;
  const faucetStatus = document.getElementById('faucet-status') as HTMLDivElement;
  if (!faucetBtn || !faucetStatus) return;

  const currentAddress = getSelectedReceiveAddress();
  if (!currentAddress) return;

  const cooldownKey = FAUCET_COOLDOWN_PREFIX + currentAddress;
  const lastRequest = localStorage.getItem(cooldownKey);
  if (lastRequest) {
    const elapsed = Date.now() - parseInt(lastRequest, 10);
    if (elapsed < FAUCET_COOLDOWN_MS) {
      const remainingMs = FAUCET_COOLDOWN_MS - elapsed;
      const remainingMinutes = Math.ceil(remainingMs / 60000);
      faucetBtn.disabled = true;
      faucetBtn.textContent = 'Requested';
      faucetStatus.textContent = `You can request more PDIVI in ${remainingMinutes} minute${remainingMinutes !== 1 ? 's' : ''}`;
      faucetStatus.style.color = 'var(--text-secondary)';
      return;
    }
  }

  // No cooldown active for this address
  faucetBtn.disabled = false;
  faucetBtn.textContent = 'Request from Faucet';
  faucetStatus.textContent = '';
}

/**
 * Handle faucet request for currently selected address
 */
export async function handleFaucetRequest(): Promise<void> {
  if (!state.currentAccount) return;

  const currentAddress = getSelectedReceiveAddress();
  if (!currentAddress) {
    showToast('No address available', 'error');
    return;
  }

  const faucetBtn = document.getElementById('request-faucet-btn') as HTMLButtonElement;
  const faucetStatus = document.getElementById('faucet-status') as HTMLDivElement;

  const cooldownKey = FAUCET_COOLDOWN_PREFIX + currentAddress;

  // Check rate limiting for this address
  const lastRequest = localStorage.getItem(cooldownKey);
  if (lastRequest) {
    const elapsed = Date.now() - parseInt(lastRequest, 10);
    if (elapsed < FAUCET_COOLDOWN_MS) {
      updateFaucetCooldownState();
      return;
    }
  }

  try {
    faucetBtn.disabled = true;
    faucetBtn.textContent = 'Requesting...';
    faucetStatus.textContent = '';

    const response = await sendMessage<{ success: boolean; txid?: string; error?: string }>(
      MSG.REQUEST_FAUCET,
      { address: currentAddress }
    );

    if (response.success && response.txid) {
      // Record successful request for this address
      localStorage.setItem(cooldownKey, String(Date.now()));

      const explorerUrl = NETWORKS[state.settings.network].explorerUrl + response.txid;
      faucetBtn.textContent = 'Requested';
      faucetStatus.innerHTML = '';
      const successDiv = document.createElement('div');
      successDiv.style.color = 'var(--success)';
      successDiv.textContent = 'Success! Coins sent. ';
      const viewLink = document.createElement('a');
      viewLink.href = explorerUrl;
      viewLink.target = '_blank';
      viewLink.style.color = 'var(--accent)';
      viewLink.style.textDecoration = 'underline';
      viewLink.textContent = 'View transaction';
      successDiv.appendChild(viewLink);
      faucetStatus.appendChild(successDiv);

      const cooldownDiv = document.createElement('div');
      cooldownDiv.style.color = 'var(--text-secondary)';
      cooldownDiv.style.marginTop = '4px';
      cooldownDiv.textContent = 'You can request more PDIVI in 60 minutes';
      faucetStatus.appendChild(cooldownDiv);

      // Refresh balance after a delay
      setTimeout(() => {
        loadBalance();
        loadTransactions();
      }, 2000);
    } else {
      faucetBtn.disabled = false;
      faucetBtn.textContent = 'Request from Faucet';
      faucetStatus.style.color = 'var(--danger)';
      faucetStatus.textContent = response.error || 'Request failed. Please try again.';
    }
  } catch (error: unknown) {
    faucetBtn.disabled = false;
    faucetBtn.textContent = 'Request from Faucet';
    const errorMessage = error instanceof Error ? error.message : 'Request failed';
    faucetStatus.style.color = 'var(--danger)';
    faucetStatus.textContent = errorMessage;
  }
}

/**
 * Setup wallet UI event listeners
 */
export function setupWalletUIHandlers(): void {
  // Balance toggle handler moved to popup.ts (includes settings sync)

  // Receive view
  elements.receiveBtn.addEventListener('click', handleReceiveView);
  document.getElementById('receive-back-btn')?.addEventListener('click', hideView);
  document.getElementById('copy-address-btn')?.addEventListener('click', handleCopyAddress);
  document.getElementById('request-faucet-btn')?.addEventListener('click', handleFaucetRequest);
  document.getElementById('receive-address-select')?.addEventListener('change', handleReceiveAddressChange);
}
