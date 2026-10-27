/**
 * Send transaction UI - send flow, confirmation, fee calculation
 */

import { elements } from './elements';
import { state } from './state';
import { formatAddress, formatAmount, showLoading, hideLoading, showToast, showView, hideView, clearPasswordInput } from './ui-state';
import { sendMessage } from './message-api';
import { MSG, DUST_THRESHOLD, NETWORKS, type NetworkType } from '../shared/constants';
import { loadBalance, loadTransactions } from './wallet-ui';
import { checkRecipient, chunkAddress, recipientNote, type KnownContact } from './recipient-check';
import { memoProblem, parsePaymentUri, type PaymentRequest } from '../lib/payment-uri';
import { visibleText } from './visible-text';
import { canCaptureTab, qrTextFromFile, qrTextFromVisibleTab } from './qr-image';

// ============================================================
// Send Transaction Handlers
// ============================================================

/**
 * Populate the "From" address dropdown
 */
export function populateSendFromDropdown(): void {
  if (!state.currentAccount) return;

  const select = document.getElementById('send-from-address') as HTMLSelectElement;
  select.innerHTML = '';

  // Add "Auto" option
  const autoOption = document.createElement('option');
  autoOption.value = 'auto';
  autoOption.textContent = 'Auto (uses available addresses)';
  select.appendChild(autoOption);

  // Add each address
  state.currentAccount.addresses.forEach((addr, idx) => {
    const option = document.createElement('option');
    option.value = addr.address;
    const shortAddr = `${addr.address.slice(0, 8)}...${addr.address.slice(-6)}`;
    option.textContent = `Address ${idx + 1}: ${shortAddr}`;
    select.appendChild(option);
  });

  // Set current selection
  select.value = state.selectedSendFromAddress;
}

/**
 * Handle send max button click
 */
export function handleSendMax(): void {
  const amountInput = document.getElementById('send-amount') as HTMLInputElement;
  const feeInput = document.getElementById('send-fee') as HTMLInputElement;
  const fee = parseFloat(feeInput.value) || 0.00005;
  const maxAmount = Math.max(0, state.balance - fee);
  // At most 8 decimals, rounded down, so the text parses exactly (EXT-25)
  amountInput.value = (Math.floor(maxAmount * 1e8) / 1e8).toFixed(8).replace(/\.?0+$/, '');
}

/**
 * Handle send confirm button - validate and show confirmation view
 */
export async function handleSendConfirm(): Promise<void> {
  const toInput = document.getElementById('send-to') as HTMLInputElement;
  const amountInput = document.getElementById('send-amount') as HTMLInputElement;
  const feeInput = document.getElementById('send-fee') as HTMLInputElement;

  // A pasted divi: payment request fills the form for the owner to check
  if (/^divi:/i.test(toInput.value.trim())) {
    applyPaymentRequestText(toInput.value);
    return;
  }

  const to = toInput.value.trim();
  const amount = parseFloat(amountInput.value);
  const fee = parseFloat(feeInput.value);
  const memoInput = document.getElementById('send-memo') as HTMLInputElement | null;
  const memo = memoInput?.value.trim() ? memoInput.value : undefined;
  if (memo !== undefined) {
    const problem = memoProblem(memo);
    if (problem) {
      showToast(problem, 'error');
      return;
    }
  }

  if (!to || !amount || amount <= 0) {
    showToast('Please enter a valid address and amount', 'error');
    return;
  }

  if (amount < DUST_THRESHOLD) {
    showToast(`Amount must be at least ${DUST_THRESHOLD} DIVI`, 'error');
    return;
  }

  if (amount + fee > state.balance) {
    showToast('Insufficient balance', 'error');
    return;
  }

  // Validate the recipient address
  try {
    const validation = await sendMessage<{ isValid: boolean }>(MSG.VALIDATE_ADDRESS, { address: to });
    if (!validation.isValid) {
      showToast('Invalid recipient address', 'error');
      return;
    }
  } catch {
    showToast('Failed to validate address', 'error');
    return;
  }

  // Get selected from address
  const fromSelect = document.getElementById('send-from-address') as HTMLSelectElement;
  const fromValue = fromSelect.value;
  const fromAddresses = fromValue === 'auto' ? undefined : [fromValue];

  state.pendingSendTx = { to, amount, amountText: amountInput.value.trim(), fee, fromAddresses, memo };
  showConfirmMemo(memo);

  // Update confirm view
  showRecipient(to, await loadRecipientContacts());
  (document.getElementById('confirm-amount') as HTMLSpanElement).textContent = `${formatAmount(amount)} DIVI`;
  (document.getElementById('confirm-fee') as HTMLSpanElement).textContent = `${formatAmount(fee)} DIVI`;

  // Calculate and display total
  const total = amount + fee;
  (document.getElementById('send-confirm-total') as HTMLSpanElement).textContent = `${formatAmount(total)} DIVI`;

  showView(elements.viewSendConfirm);
}

/**
 * This account's network's contacts, for the recipient check. On failure the
 * recipient is treated as new, which only makes the warning stronger.
 */
async function loadRecipientContacts(): Promise<KnownContact[]> {
  try {
    const response = await sendMessage<{ contacts: KnownContact[] }>(MSG.GET_CONTACTS, { network: state.currentAccount?.network });
    return response.contacts || [];
  } catch {
    return [];
  }
}

/**
 * The whole recipient address in groups of four, and what is known about it
 */
function showRecipient(to: string, contacts: KnownContact[]): void {
  const toEl = document.getElementById('confirm-to') as HTMLSpanElement;
  toEl.replaceChildren(...chunkAddress(to).map(chunk => {
    const span = document.createElement('span');
    span.className = 'address-chunk';
    span.textContent = chunk;
    return span;
  }));
  const own = state.currentAccount?.addresses.map(a => a.address) ?? [];
  const note = recipientNote(checkRecipient(to, contacts, own));
  const noteEl = document.getElementById('confirm-recipient-note') as HTMLDivElement;
  noteEl.textContent = note.text;
  noteEl.className = `recipient-note ${note.level}`;
}

/**
 * Handle send submit - execute the transaction
 */
export async function handleSendSubmit(): Promise<void> {
  const passwordInput = document.getElementById('send-password') as HTMLInputElement;
  const password = passwordInput.value;

  if (!password) {
    showToast('Please enter your password', 'error');
    return;
  }

  try {
    await sendTransaction(password);
  } finally {
    clearPasswordInput(passwordInput);
  }
}

/**
 * Execute the send transaction
 */
async function sendTransaction(password: string): Promise<void> {
  if (!state.pendingSendTx) return;

  const toAddress = state.pendingSendTx.to;

  try {
    showLoading('Sending transaction...');

    // The password goes with the send: the background asks for it every time
    const response = await sendMessage<{ txid: string }>(MSG.SEND_TRANSACTION, {
      password,
      to: toAddress,
      amount: state.pendingSendTx.amountText,
      fee: state.pendingSendTx.fee,
      fromAddresses: state.pendingSendTx.fromAddresses,
      memo: state.pendingSendTx.memo,
    });

    showToast(`Transaction sent: ${formatAddress(response.txid)}`, 'success');
    state.pendingSendTx = null;
    clearPaymentRequest();

    // Mark contact as recently used if this address is a contact
    try {
      const contact = state.contacts.find(c => c.address === toAddress);
      if (contact) {
        await sendMessage(MSG.MARK_CONTACT_USED, { contactId: contact.id });
      }
    } catch {
      // Ignore errors marking contact used
    }

    // Refresh data
    await loadBalance();
    await loadTransactions();

    hideView();
  } catch (error: unknown) {
    const errorMessage = error instanceof Error ? error.message : 'Failed to send transaction';
    showToast(errorMessage, 'error');
  } finally {
    hideLoading();
  }
}

// ============================================================
// QR pay: fill the send form from a divi: payment request
// ============================================================

const MAX_SHOWN = 300;

/** Untrusted text from a QR code, with hidden characters made visible */
function shown(text: string): string {
  const visible = visibleText(text).text;
  return visible.length > MAX_SHOWN ? `${visible.slice(0, MAX_SHOWN)}…` : visible;
}

function setRequestLine(rowId: string, valueId: string, value: string | undefined): void {
  document.getElementById(rowId)?.classList.toggle('hidden', value === undefined);
  const el = document.getElementById(valueId);
  if (el) el.textContent = value === undefined ? '' : shown(value);
}

/** Show who asked and what for; neither goes on chain */
function showRequestInfo(request: PaymentRequest | null): void {
  const label = request?.label;
  const message = request?.message;
  setRequestLine('send-request-label-row', 'send-request-label', label);
  setRequestLine('send-request-message-row', 'send-request-message', message);
  document.getElementById('send-request-info')?.classList.toggle('hidden', label === undefined && message === undefined);
}

function clearPaymentRequest(): void {
  showRequestInfo(null);
  const memoInput = document.getElementById('send-memo') as HTMLInputElement | null;
  if (memoInput) memoInput.value = '';
}

function showConfirmMemo(memo: string | undefined): void {
  document.getElementById('confirm-memo-row')?.classList.toggle('hidden', memo === undefined);
  const el = document.getElementById('confirm-memo');
  if (el) el.textContent = memo === undefined ? '' : visibleText(memo).text;
}

/**
 * Fill address, amount and memo from a payment request and show its label
 * and message. Nothing is sent: the owner checks the form and continues.
 */
export function applyPaymentRequestText(text: string): boolean {
  const network = state.currentAccount?.network;
  if (!network || !Object.hasOwn(NETWORKS, network)) return false;
  const parsed = parsePaymentUri(text, network as NetworkType);
  if (!parsed.ok) {
    showToast(shown(parsed.error), 'error');
    return false;
  }
  const { request } = parsed;
  (document.getElementById('send-to') as HTMLInputElement).value = request.address;
  (document.getElementById('send-amount') as HTMLInputElement).value = request.amount ?? '';
  const memoInput = document.getElementById('send-memo') as HTMLInputElement | null;
  if (memoInput) memoInput.value = request.memo ?? '';
  showRequestInfo(request);
  showToast(request.amount ? 'Payment request filled in; check it, then Continue' : 'Address filled in; enter the amount', 'success');
  return true;
}

async function scanWith(read: () => Promise<string | null>): Promise<void> {
  let text: string | null;
  try {
    text = await read();
  } catch (error: unknown) {
    showToast(error instanceof Error ? error.message : 'The picture could not be read', 'error');
    return;
  }
  if (text === null) {
    showToast('No QR code found', 'error');
    return;
  }
  applyPaymentRequestText(text);
}

function setupQrPay(): void {
  const tabBtn = document.getElementById('send-scan-tab-btn') as HTMLButtonElement | null;
  if (tabBtn) {
    // iOS Safari cannot capture a tab; the picture picker opens the camera there
    tabBtn.classList.toggle('hidden', !canCaptureTab());
    tabBtn.addEventListener('click', async () => {
      tabBtn.disabled = true;
      try {
        await scanWith(qrTextFromVisibleTab);
      } finally {
        tabBtn.disabled = false;
      }
    });
  }

  const file = document.getElementById('send-qr-input') as HTMLInputElement | null;
  file?.addEventListener('change', async () => {
    const picked = file.files?.[0];
    file.value = '';
    if (!picked) return;
    await scanWith(() => qrTextFromFile(picked));
  });
}

/**
 * Setup contact suggestions in send form
 */
export function setupContactSuggestions(): void {
  const sendToInput = document.getElementById('send-to') as HTMLInputElement;
  const suggestionsContainer = document.getElementById('contact-suggestions') as HTMLDivElement;

  sendToInput.addEventListener('input', (e) => {
    const value = (e.target as HTMLInputElement).value.toLowerCase();

    if (value.length < 2) {
      suggestionsContainer.classList.add('hidden');
      suggestionsContainer.innerHTML = '';
      return;
    }

    const matches = state.contacts.filter(c =>
      c.name.toLowerCase().includes(value) ||
      c.address.toLowerCase().includes(value)
    );

    if (matches.length === 0) {
      suggestionsContainer.classList.add('hidden');
      suggestionsContainer.innerHTML = '';
      return;
    }

    suggestionsContainer.innerHTML = '';
    matches.forEach(contact => {
      const item = document.createElement('div');
      item.className = 'suggestion-item';
      const nameDiv = document.createElement('div');
      nameDiv.className = 'suggestion-name';
      nameDiv.textContent = contact.name;
      const addressDiv = document.createElement('div');
      addressDiv.className = 'suggestion-address';
      addressDiv.textContent = contact.address;
      item.appendChild(nameDiv);
      item.appendChild(addressDiv);
      item.addEventListener('click', () => {
        sendToInput.value = contact.address;
        suggestionsContainer.classList.add('hidden');
        suggestionsContainer.innerHTML = '';
      });
      suggestionsContainer.appendChild(item);
    });

    suggestionsContainer.classList.remove('hidden');
  });

  // Close suggestions when clicking outside
  document.addEventListener('click', (e) => {
    const target = e.target as HTMLElement;
    if (!target.closest('.form-group')) {
      suggestionsContainer.classList.add('hidden');
    }
  });
}

/**
 * Setup send UI event listeners
 */
export function setupSendUIHandlers(): void {
  elements.sendBtn.addEventListener('click', () => {
    populateSendFromDropdown();
    showView(elements.viewSend);
  });

  document.getElementById('send-back-btn')?.addEventListener('click', hideView);
  document.getElementById('send-max-btn')?.addEventListener('click', handleSendMax);
  document.getElementById('send-confirm-btn')?.addEventListener('click', handleSendConfirm);

  // Track from address selection
  document.getElementById('send-from-address')?.addEventListener('change', (e) => {
    state.selectedSendFromAddress = (e.target as HTMLSelectElement).value;
  });

  // Send confirm view
  document.getElementById('send-confirm-back-btn')?.addEventListener('click', () => {
    showView(elements.viewSend);
  });

  document.getElementById('send-submit-btn')?.addEventListener('click', handleSendSubmit);

  // Setup contact suggestions
  setupContactSuggestions();
  setupQrPay();
}
