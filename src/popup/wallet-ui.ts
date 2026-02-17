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
 * Handle showing the receive view with QR code
 */
export async function handleReceiveView(): Promise<void> {
  showView(elements.viewReceive);

  if (!state.currentAccount) return;

  // Generate QR code
  const qrContainer = document.getElementById('qr-code') as HTMLDivElement;
  qrContainer.innerHTML = '';

  const primaryAddress = getPrimaryAddress(state.currentAccount);
  if (!primaryAddress) {
    showToast('No address available', 'error');
    return;
  }

  try {
    const canvas = await QRCode.toCanvas(primaryAddress, {
      width: 208,
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
  addressDisplay.textContent = primaryAddress;

  // Clear faucet status and update visibility based on network
  const faucetStatus = document.getElementById('faucet-status') as HTMLDivElement;
  faucetStatus.innerHTML = '';
  updateFaucetVisibility();
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

/**
 * Handle faucet request
 */
export async function handleFaucetRequest(): Promise<void> {
  if (!state.currentAccount) return;

  const primaryAddress = getPrimaryAddress(state.currentAccount);
  if (!primaryAddress) {
    showToast('No address available', 'error');
    return;
  }

  const FAUCET_COOLDOWN_MS = 60 * 60 * 1000; // 1 hour cooldown
  const FAUCET_COOLDOWN_KEY = 'pdivi_faucet_last_request';

  const faucetBtn = document.getElementById('request-faucet-btn') as HTMLButtonElement;
  const faucetStatus = document.getElementById('faucet-status') as HTMLDivElement;

  // Check rate limiting
  const lastRequest = localStorage.getItem(FAUCET_COOLDOWN_KEY);
  if (lastRequest) {
    const elapsed = Date.now() - parseInt(lastRequest, 10);
    if (elapsed < FAUCET_COOLDOWN_MS) {
      const remainingMinutes = Math.ceil((FAUCET_COOLDOWN_MS - elapsed) / 60000);
      showToast(`Please wait ${remainingMinutes} minute(s) before requesting again`, 'error');
      faucetStatus.innerHTML = '';
      const rateLimitDiv = document.createElement('div');
      rateLimitDiv.style.color = 'var(--warning)';
      rateLimitDiv.style.marginTop = '12px';
      rateLimitDiv.textContent = `Rate limited. Try again in ${remainingMinutes} minute(s).`;
      faucetStatus.appendChild(rateLimitDiv);
      return;
    }
  }

  try {
    faucetBtn.disabled = true;
    faucetBtn.textContent = 'Requesting...';
    faucetStatus.innerHTML = '';

    const response = await sendMessage<{ success: boolean; txid?: string; error?: string }>(
      MSG.REQUEST_FAUCET,
      { address: primaryAddress }
    );

    if (response.success && response.txid) {
      // Record successful request for rate limiting
      localStorage.setItem(FAUCET_COOLDOWN_KEY, String(Date.now()));

      const explorerUrl = NETWORKS[state.settings.network].explorerUrl + response.txid;
      faucetStatus.innerHTML = '';
      const successDiv = document.createElement('div');
      successDiv.style.color = 'var(--success)';
      successDiv.style.marginTop = '12px';
      successDiv.textContent = 'Success! Coins sent.';
      const br = document.createElement('br');
      const viewLink = document.createElement('a');
      viewLink.href = explorerUrl;
      viewLink.target = '_blank';
      viewLink.style.color = 'var(--accent)';
      viewLink.style.textDecoration = 'underline';
      viewLink.textContent = 'View transaction';
      successDiv.appendChild(br);
      successDiv.appendChild(viewLink);
      faucetStatus.appendChild(successDiv);
      showToast('Faucet request successful!', 'success');

      // Refresh balance after a delay
      setTimeout(() => {
        loadBalance();
        loadTransactions();
      }, 2000);
    } else {
      faucetStatus.innerHTML = '';
      const errorDiv = document.createElement('div');
      errorDiv.style.color = 'var(--danger)';
      errorDiv.style.marginTop = '12px';
      errorDiv.textContent = response.error || 'Request failed. Please try again later.';
      faucetStatus.appendChild(errorDiv);
      showToast(response.error || 'Faucet request failed', 'error');
    }
  } catch (error: unknown) {
    faucetStatus.innerHTML = '';
    const catchDiv = document.createElement('div');
    catchDiv.style.color = 'var(--danger)';
    catchDiv.style.marginTop = '12px';
    const errorMessage = error instanceof Error ? error.message : 'Request failed';
    catchDiv.textContent = errorMessage;
    faucetStatus.appendChild(catchDiv);
    showToast(errorMessage, 'error');
  } finally {
    faucetBtn.disabled = false;
    faucetBtn.textContent = 'Request from Faucet';
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
}
