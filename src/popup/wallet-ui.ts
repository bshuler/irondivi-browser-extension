/**
 * Wallet UI - balance display, transaction list, address display
 */

import { elements } from './elements';
import { state } from './state';
import { formatAddress, formatAmount, showToast, showView, hideView } from './ui-state';
import { sendMessage } from './message-api';
import { explainedByMissingAccess } from './service-access';
import { MSG, NETWORKS } from '../shared/constants';
import { Account, Transaction, Contact, ConnectedSite, getPrimaryAddress } from './types';
import QRCode from 'qrcode';
import { formatPaymentUri } from '../lib/payment-uri';

// A transaction counts as fully accepted at this many confirmations.
const CONFIRMATIONS_FINAL = 6;
// How often to re-check while a transaction is still pending.
const PENDING_REFRESH_MS = 10_000;
// After a faucet payout, keep checking this long even before it shows up.
const FAUCET_WATCH_MS = 60_000;

let refreshTimer: ReturnType<typeof setTimeout> | null = null;
let watchUntil = 0;

/**
 * Re-load balance and history in a few seconds while anything is short of final
 * confirmation (or a faucet payout was just requested), so the row counts up by itself.
 */
function scheduleRefresh(): void {
  if (refreshTimer) clearTimeout(refreshTimer);
  refreshTimer = null;
  const pending = state.transactions.some(tx => tx.confirmations < CONFIRMATIONS_FINAL);
  if (!state.currentAccount || (!pending && Date.now() > watchUntil)) return;
  refreshTimer = setTimeout(() => {
    refreshTimer = null;
    loadBalance();
    loadTransactions();
  }, PENDING_REFRESH_MS);
}

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
    if (await explainedByMissingAccess()) return;
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
    if (await explainedByMissingAccess()) return;
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
  updatePendingBalance();
}

/**
 * "+X DIVI pending": the net of transactions still in the mempool, which the
 * confirmed balance does not count yet.
 */
function updatePendingBalance(): void {
  const el = document.getElementById('balance-pending');
  if (!el) return;
  const net = state.transactions
    .filter(tx => tx.confirmations === 0)
    .reduce((sum, tx) => sum + (tx.type === 'send' ? -tx.amount : tx.amount), 0);
  if (net === 0 || state.balanceHidden) {
    el.textContent = '';
    el.classList.add('hidden');
    return;
  }
  el.textContent = `${net > 0 ? '+' : '\u2212'}${formatAmount(Math.abs(net))} DIVI pending`;
  el.classList.remove('hidden');
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
  updatePendingBalance();
  scheduleRefresh();
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

    // Seen from the mempool at once; not fully accepted until the 6th confirmation.
    const confirmationsEl = document.createElement('span');
    confirmationsEl.className = tx.confirmations < CONFIRMATIONS_FINAL
      ? 'tx-confirmations unconfirmed'
      : 'tx-confirmations';
    if (tx.confirmations === 0) {
      confirmationsEl.textContent = `Pending \u00b7 0/${CONFIRMATIONS_FINAL} confirmations`;
    } else if (tx.confirmations < CONFIRMATIONS_FINAL) {
      confirmationsEl.textContent = `${tx.confirmations}/${CONFIRMATIONS_FINAL} confirmations`;
    } else {
      confirmationsEl.textContent = `${tx.confirmations} confirmations`;
    }

    const explorerUrl = NETWORKS[state.settings.network].explorerUrl + tx.txid;
    const explorerLink = document.createElement('a');
    explorerLink.className = 'tx-explorer-link';
    explorerLink.href = explorerUrl;
    explorerLink.target = '_blank';
    explorerLink.rel = 'noopener';
    // The explorer only shows a transaction once it is in a block.
    explorerLink.title = tx.confirmations === 0
      ? `${tx.txid}\nThe explorer shows it once it is in a block (about a minute).`
      : tx.txid;
    explorerLink.textContent = tx.confirmations === 0
      ? 'View on explorer \u2197 (once in a block)'
      : 'View on explorer \u2197';
    explorerLink.addEventListener('click', e => e.stopPropagation());

    const txDateEl = document.createElement('span');
    txDateEl.className = 'tx-date';
    txDateEl.textContent = tx.timestamp ? formatTxDate(tx.timestamp) : '';

    txDetails.appendChild(txTitle);
    txDetails.appendChild(txAddress);
    txDetails.appendChild(confirmationsEl);
    if (tx.timestamp) txDetails.appendChild(txDateEl);
    txDetails.appendChild(explorerLink);

    // tx-amount
    const txAmount = document.createElement('div');
    txAmount.className = `tx-amount ${tx.type}`;
    txAmount.textContent = `${tx.type === 'send' ? '-' : '+'}${formatAmount(tx.amount)} DIVI`;

    item.appendChild(txIcon);
    item.appendChild(txDetails);
    item.appendChild(txAmount);

    item.addEventListener('click', () => {
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

// The receive QR, redrawn only by the latest request (drawing is async)
let qrDraw = 0;

function receiveField(id: string): string {
  return (document.getElementById(id) as HTMLInputElement | null)?.value.trim() ?? '';
}

/**
 * What the receive QR shows: the bare address when no amount, label or memo
 * is asked for, else a divi: payment request; an error when a field
 * could not be paid.
 */
function receiveRequest(address: string): { text: string; isRequest: boolean } | { error: string } {
  const amount = receiveField('receive-amount');
  const label = receiveField('receive-label');
  const memo = receiveField('receive-memo');
  try {
    const text = formatPaymentUri({ address, amount, label, memo });
    return { text, isRequest: text !== address };
  } catch (error: unknown) {
    return { error: error instanceof Error ? error.message : 'That request cannot be paid' };
  }
}

/**
 * Update the QR code and address display for selected address
 */
async function updateReceiveAddressDisplay(): Promise<void> {
  if (!state.currentAccount) return;

  const addr = state.currentAccount.addresses[state.selectedReceiveAddressIndex];
  if (!addr) return;

  const addressDisplay = document.getElementById('receive-address') as HTMLDivElement;
  addressDisplay.textContent = addr.address;

  const request = receiveRequest(addr.address);
  const status = document.getElementById('receive-request-status') as HTMLDivElement | null;
  const copyRequest = document.getElementById('copy-request-btn') as HTMLButtonElement | null;
  const qrContainer = document.getElementById('qr-code') as HTMLDivElement;

  if ('error' in request) {
    // Keep the last good QR from being mistaken for this request
    qrDraw++;
    qrContainer.replaceChildren();
    qrContainer.classList.remove('qr-request');
    if (status) { status.textContent = request.error; status.className = 'receive-request-status error'; }
    if (copyRequest) copyRequest.disabled = true;
    return;
  }

  if (status) {
    status.textContent = request.isRequest ? request.text : 'Fill in any field to make a payment request; empty, the QR is just the address.';
    status.className = 'receive-request-status';
  }
  if (copyRequest) copyRequest.disabled = !request.isRequest;

  const draw = ++qrDraw;
  try {
    const canvas = await QRCode.toCanvas(request.text, {
      // Drawn at twice the shown size so a long request stays sharp
      width: request.isRequest ? 400 : 248,
      margin: 0,
      errorCorrectionLevel: 'M',
      color: {
        dark: '#000000',
        light: '#ffffff',
      },
    });
    if (draw !== qrDraw) return;
    qrContainer.replaceChildren(canvas);
    qrContainer.classList.toggle('qr-request', request.isRequest);
  } catch (error) {
    if (draw !== qrDraw) return;
    qrContainer.replaceChildren();
    console.error('Failed to generate QR code');
  }
}

/**
 * Copy the payment request link shown in the receive QR
 */
async function handleCopyRequest(): Promise<void> {
  const address = getSelectedReceiveAddress();
  if (!address) return;
  const request = receiveRequest(address);
  if ('error' in request || !request.isRequest) {
    showToast('error' in request ? request.error : 'Fill in an amount, label or memo first', 'error');
    return;
  }
  try {
    await navigator.clipboard.writeText(request.text);
    showToast('Payment link copied to clipboard', 'success');
  } catch {
    showToast('Failed to copy the payment link', 'error');
  }
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

const FAUCET_COOLDOWN_MS = 24 * 60 * 60 * 1000; // The faucet pays each address once a day
const FAUCET_COOLDOWN_PREFIX = 'irondivi_faucet_'; // Per-address cooldown: irondivi_faucet_{address}

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
      const remainingHours = Math.ceil(remainingMinutes / 60);
      const wait = remainingMinutes > 60
        ? `${remainingHours} hour${remainingHours !== 1 ? 's' : ''}`
        : `${remainingMinutes} minute${remainingMinutes !== 1 ? 's' : ''}`;
      faucetBtn.disabled = true;
      faucetBtn.textContent = 'Requested';
      faucetStatus.textContent = `You can request more DIVI in ${wait}`;
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
      cooldownDiv.textContent = 'It shows below as pending now, and is final at 6 confirmations.';
      faucetStatus.appendChild(cooldownDiv);

      // The payout is in the faucet node's mempool already: show it now, then keep watching.
      watchUntil = Date.now() + FAUCET_WATCH_MS;
      loadBalance();
      loadTransactions();
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
  // QR ask: the request form redraws the QR as the owner types
  for (const id of ['receive-amount', 'receive-label', 'receive-memo']) {
    document.getElementById(id)?.addEventListener('input', () => { void updateReceiveAddressDisplay(); });
  }
  document.getElementById('copy-request-btn')?.addEventListener('click', handleCopyRequest);
}
