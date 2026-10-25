/**
 * Signing Request UI Module
 *
 * Handles the display and user interaction for dApp signing requests
 * (sign_message, sign_game_tx and send_transaction).
 */

import { MSG, NETWORKS, sendMessage, type NetworkType } from '../shared/constants';
import { showLoading, hideLoading, showToast, showView, hideView, formatAmount } from './ui-state';
import { visibleText } from './visible-text';
import { retryAfterUnlock } from './unlock-retry';
import type { GameTxSummary, SessionGrant } from '../lib/game-tx';

// Type for a pending request (connection, signing, or transaction)
export interface SigningRequest {
  id: string;
  type: 'connect' | 'sign_message' | 'sign_game_tx' | 'send_transaction';
  origin: string;
  accountId: string;
  network?: NetworkType;
  data?: {
    message?: string;
    address?: string;
    to?: string;
    // Exact DIVI text, with the total worked out by the wallet (EXT-25)
    amount?: number | string;
    total?: string;
    fee?: number;
    // What the account holds after this payment, as text (EXT-8)
    balanceAfter?: string;
    addressIndex?: number;
    memo?: string;
    // A Divi Games transaction, as the background checked and read it
    gameTx?: GameTxSummary;
    // A Divi Games session grant the message makes
    session?: SessionGrant;
  };
  // The site has not had a request of this type approved before
  firstUse?: boolean;
  // Which account and address the request would sign or pay from (EXT-8)
  from?: { name: string; address: string; addressCount: number };
  // What the wallet knows about the recipient of a payment (EXT-8)
  recipient?: { text: string; level: 'ok' | 'warn' | 'danger' };
  createdAt: number;
}

/**
 * A fee as shown for approval. A fee the background did not report is
 * unknown, never a guess: a guessed fee understates the total (EXT-24).
 */
export function feeText(fee: unknown): { text: string; known: boolean } {
  if (typeof fee !== 'number' || !Number.isFinite(fee) || fee < 0) return { text: 'unknown', known: false };
  return { text: `${formatAmount(fee)} DIVI`, known: true };
}

// A request whose total cannot be shown cannot be approved
let blocked = false;
// Set while an approval is on its way to the background, so a second click
// or Enter does not send a second one (EXT-6)
let approving = false;

// State
let currentRequest: SigningRequest | null = null;
let signingRequestViewElement: HTMLDivElement | null = null;

/**
 * Get DOM elements for signing request view
 */
function getElements() {
  return {
    view: document.getElementById('view-signing-request') as HTMLDivElement,
    backBtn: document.getElementById('signing-request-back-btn') as HTMLButtonElement,
    origin: document.getElementById('signing-origin') as HTMLDivElement,
    network: document.getElementById('signing-network') as HTMLSpanElement,
    type: document.getElementById('signing-type') as HTMLDivElement,
    details: document.getElementById('signing-details') as HTMLDivElement,
    warningText: document.getElementById('signing-warning-text') as HTMLSpanElement,
    securityPhrase: document.getElementById('signing-security-phrase') as HTMLDivElement,
    password: document.getElementById('signing-password') as HTMLInputElement,
    rejectBtn: document.getElementById('reject-request-btn') as HTMLButtonElement,
    approveBtn: document.getElementById('approve-request-btn') as HTMLButtonElement,
  };
}

// Set when this popup is an approval window opened for one request. Such a
// window shows only that request, never another site's.
let boundRequestId: string | null = null;

// Approve does nothing until the window has been in front this long, so a
// site cannot open the window under the user's pointer and have a click or
// Enter meant for its own page land on Approve
export const APPROVE_DELAY_MS = 600;
let armedAt = Infinity;
let armTimer: ReturnType<typeof setTimeout> | undefined;

function disarmApprove(): void {
  armedAt = Infinity;
  clearTimeout(armTimer);
  const { approveBtn } = getElements();
  if (approveBtn) approveBtn.disabled = true;
}

function armApprove(): void {
  disarmApprove();
  armedAt = Date.now() + APPROVE_DELAY_MS;
  armTimer = setTimeout(() => {
    const { approveBtn } = getElements();
    if (approveBtn && Date.now() >= armedAt && !blocked && !approving) approveBtn.disabled = false;
  }, APPROVE_DELAY_MS);
}

/**
 * Which pending request to show. An approval window gets exactly the request
 * it was opened for or nothing; the plain popup shows the oldest.
 */
export function pickRequest(requests: SigningRequest[], requestId?: string): SigningRequest | undefined {
  if (requestId) return requests.find(r => r.id === requestId);
  return requests[0];
}

/**
 * Check for pending signing requests and show UI if any exist
 * @param requestId - The request an approval window was opened for
 * Returns true if a request is shown
 */
export async function checkPendingRequests(requestId?: string): Promise<boolean> {
  if (requestId) boundRequestId = requestId;
  try {
    const response = await sendMessage({
      type: MSG.GET_PENDING_SIGNING_REQUESTS,
    });

    const data = response.data as { requests?: SigningRequest[]; securityPhrase?: string } | undefined;
    const request = response.success && data?.requests ? pickRequest(data.requests, requestId) : undefined;
    if (request) {
      showSigningRequestView(request);
      showSecurityPhrase(data?.securityPhrase ?? '');
      return true;
    }
    if (requestId) showToast('This request is no longer pending', 'error');
  } catch (error) {
    console.error('Failed to check pending requests');
  }

  return false;
}

/**
 * Display the signing request approval UI
 */
export function showSigningRequestView(request: SigningRequest): void {
  currentRequest = request;
  const elements = getElements();

  if (!elements.view) {
    console.error('Signing request view element not found');
    return;
  }

  signingRequestViewElement = elements.view;

  // Set origin
  elements.origin.textContent = request.origin;

  // Which network this request is for, in that network's colour
  const network = (request.network ?? document.body.dataset.network) as NetworkType | undefined;
  if (elements.network && network && NETWORKS[network]) {
    elements.network.textContent = NETWORKS[network].name;
    elements.network.dataset.network = network;
    // The colour bar and accent follow the request's network
    document.body.dataset.network = network;
  }
  blocked = false;

  // Set type label and warning message based on request type
  if (request.type === 'connect') {
    elements.type.textContent = 'Connect Site';
    elements.type.className = 'signing-type connect';
    elements.warningText.textContent = 'This shares your wallet address with the site. It cannot sign or send anything without asking you, with your password, each time.';
  } else if (request.type === 'sign_message' && request.data?.session) {
    elements.type.textContent = 'Start Game Session';
    elements.type.className = 'signing-type sign-message';
    elements.warningText.textContent = 'This lets another key play Divi Games as you until the time shown. It cannot send your tDIVI, but it can play, and spend, in games as you.';
  } else if (request.type === 'sign_message') {
    elements.type.textContent = 'Sign Message';
    elements.type.className = 'signing-type sign-message';
    elements.warningText.textContent = 'Your signature proves you agree to this exact text. Sign only text you have read and understand: whoever holds the signature can show it to others.';
  } else if (request.type === 'sign_game_tx') {
    const tx = request.data?.gameTx;
    elements.type.textContent = 'Divi Games Transaction';
    elements.type.className = 'signing-type send-transaction';
    elements.warningText.textContent = tx?.movesFunds
      ? 'This transaction can move funds on Divi Games. Check every detail before you approve.'
      : 'This transaction acts for you on Divi Games. Check the details before you approve.';
  } else {
    elements.type.textContent = 'Send Transaction';
    elements.type.className = 'signing-type send-transaction';
    elements.warningText.textContent = 'This will send funds from your wallet. Please verify the details carefully.';
  }

  // Build details content. Everything the site sent is set as text, never
  // as markup, and shown whole with its hidden characters made visible.
  const rows: HTMLElement[] = [];
  let hidden = 0;
  const shown = (raw: string): string => {
    const v = visibleText(raw);
    hidden += v.hidden;
    return v.text;
  };

  // Which account it is from: with several accounts, the one selected in the
  // popup need not be the one the site connected to
  if (request.from && request.type !== 'connect') {
    const from = el('span', 'signing-detail-value address', shown(`${request.from.name} · ${request.from.address}`));
    rows.push(detailRow('From:', from));
    if (request.type === 'send_transaction' && request.from.addressCount > 1) {
      rows.push(detailRow('', el('span', 'signing-detail-value', `Paid from any of this account's ${request.from.addressCount} addresses`)));
    }
  }

  if (request.type === 'connect') {
    // Keep it simple - the warning text explains what happens
    const row = el('div', 'signing-detail-row');
    row.style.textAlign = 'center';
    row.style.padding = '8px 0';
    const text = el('span', '', 'Allow this site to see your address and ask you to approve signatures and payments?');
    text.style.color = 'var(--text-secondary)';
    row.append(text);
    rows.push(row);
  } else if (request.type === 'sign_message' && request.data?.session) {
    const s = request.data.session;
    rows.push(detailRow('Lets key:', el('span', 'signing-detail-value address', shown(s.key))));
    rows.push(detailRow('Play as you until:', el('span', 'signing-detail-value', shown(localTime(s.until)))));
    rows.push(detailRow('Chain:', el('span', 'signing-detail-value', shown(s.chain))));
    if (request.data.address) {
      rows.push(detailRow('Address:', el('span', 'signing-detail-value address', shown(request.data.address))));
    }
  } else if (request.type === 'sign_game_tx') {
    const tx = request.data?.gameTx;
    if (tx) {
      const title = el('div', 'signing-detail-row', shown(tx.title));
      title.style.fontWeight = '600';
      rows.push(title);
      for (const r of tx.rows) {
        const cls = /address|^to|^from/i.test(r.label) ? 'signing-detail-value address' : 'signing-detail-value';
        rows.push(detailRow(`${shown(r.label)}:`, el('span', cls, shown(r.value))));
      }
    }
  } else if (request.type === 'sign_message') {
    rows.push(detailRow('Message:', el('div', 'signing-message-content', shown(request.data?.message || ''))));
    if (request.data?.address) {
      rows.push(detailRow('Address:', el('span', 'signing-detail-value address', shown(request.data.address))));
    }
  } else if (request.type === 'send_transaction') {
    const amount = request.data?.amount ?? 0;
    const fee = feeText(request.data?.fee);
    // Show the whole destination: a shortened one can hide a look-alike address
    rows.push(detailRow('To:', el('span', 'signing-detail-value address', shown(request.data?.to || ''))));
    if (request.recipient) {
      rows.push(el('div', `signing-detail-row recipient-note ${request.recipient.level}`, request.recipient.text));
    }
    const amountText = typeof amount === 'string' ? shown(amount) : formatAmount(amount);
    rows.push(detailRow('Amount:', el('span', 'signing-detail-value amount', `${amountText} DIVI`)));
    rows.push(detailRow('Fee:', el('span', 'signing-detail-value', fee.text)));
    const total = detailRow('Total:', el('span', 'signing-detail-value amount',
      !fee.known ? 'unknown'
        : typeof request.data?.total === 'string' ? `${shown(request.data.total)} DIVI`
        : `${formatAmount(Number(amount) + (request.data?.fee as number))} DIVI`));
    total.classList.add('total');
    rows.push(total);
    if (request.data?.balanceAfter !== undefined) {
      rows.push(detailRow('Left after:', el('span', 'signing-detail-value', `${shown(request.data.balanceAfter)} DIVI`)));
    }
    if (!fee.known) {
      blocked = true;
      rows.push(warningRow('fee-unknown', 'The wallet could not work out the fee, so this payment cannot be approved. Reject it and try again.'));
    }
    if (request.data?.memo !== undefined) {
      // Stored on the chain with the payment, where anyone can read it
      const value = el('span', 'signing-detail-value', shown(request.data.memo));
      value.style.fontSize = '11px';
      value.style.wordBreak = 'break-all';
      value.style.whiteSpace = 'pre-wrap';
      rows.push(detailRow('Memo (public):', value));
    }
  }

  if (hidden > 0) {
    rows.push(warningRow('hidden-chars', `This request contains ${hidden} hidden or direction-changing character${hidden === 1 ? '' : 's'}, shown above as ⟨U+…⟩. The text may not be what it seems.`));
  }

  if (request.type !== 'connect' && request.firstUse) {
    const what = request.type === 'sign_message' ? 'sign a message'
      : request.type === 'sign_game_tx' ? 'sign a game transaction' : 'send a payment';
    rows.push(warningRow('first-use', `This is the first time this site has asked to ${what}.`));
  }

  elements.details.replaceChildren(...rows);

  // Clear password field
  elements.password.value = '';

  // Hide password field for connection requests (they don't need password)
  const passwordFormGroup = elements.password.closest('.form-group') as HTMLElement | null;
  if (passwordFormGroup) {
    passwordFormGroup.style.display = request.type === 'connect' ? 'none' : 'block';
  }

  // Show the view
  showView(elements.view);
  armApprove();
}

/**
 * Handle approve button click
 */
async function handleApprove(): Promise<void> {
  if (!currentRequest || approving || blocked) return;
  // The button may be disabled, but Enter in the password field reaches here too
  if (Date.now() < armedAt) return;

  const elements = getElements();
  approving = true;
  elements.approveBtn.disabled = true;
  try {
    await approveCurrent(elements);
  } finally {
    approving = false;
  }
}

async function approveCurrent(elements: ReturnType<typeof getElements>): Promise<void> {
  if (!currentRequest) return;

  // Connection requests don't need password
  if (currentRequest.type === 'connect') {
    showLoading('Connecting...');

    try {
      const request = currentRequest;
      const response = await retryAfterUnlock(() => sendMessage({
        type: MSG.APPROVE_SIGNING_REQUEST,
        payload: {
          requestId: request.id,
          isConnection: true,
        },
      }), request.accountId);
      if (!response?.success) throw new Error(response?.error || 'Failed to connect');

      hideLoading();
      showToast('Site connected successfully', 'success');

      // Close the approval window after a short delay
      setTimeout(() => {
        window.close();
      }, 500);
    } catch (error) {
      hideLoading();
      showToast(error instanceof Error ? error.message : 'Failed to connect', 'error');
      elements.approveBtn.disabled = false;
    }
    return;
  }

  // Signing requests need password
  const password = elements.password.value;

  if (!password) {
    showToast('Please enter your password', 'error');
    elements.approveBtn.disabled = false;
    return;
  }

  showLoading(currentRequest.type === 'send_transaction' ? 'Sending transaction...' : 'Signing...');

  try {
    const response = await sendMessage({
      type: MSG.APPROVE_SIGNING_REQUEST,
      payload: {
        requestId: currentRequest.id,
        password,
      },
    });
    // A refused password or a failed send comes back as an error reply, not
    // a thrown one; it must not be shown as a success
    if (!response?.success) throw new Error(response?.error || 'Failed to approve request');

    hideLoading();

    if (currentRequest.type === 'sign_message') {
      showToast('Message signed successfully', 'success');
    } else if (currentRequest.type === 'sign_game_tx') {
      showToast('Transaction signed', 'success');
    } else {
      showToast('Transaction sent successfully', 'success');
    }

    // Close the approval window after a short delay
    setTimeout(() => {
      window.close();
    }, 500);
  } catch (error) {
    hideLoading();
    // Clear password on failure for security
    elements.password.value = '';
    showToast(error instanceof Error ? error.message : 'Failed to approve request', 'error');
    elements.approveBtn.disabled = false;
  }
}

/**
 * Show the owner's security phrase. A page can draw a look-alike window but
 * cannot know the phrase, so a window without it is not the wallet's (EXT-18).
 */
function showSecurityPhrase(phrase: string): void {
  const { securityPhrase } = getElements();
  if (!securityPhrase) return;
  if (phrase) {
    securityPhrase.textContent = phrase;
    securityPhrase.className = 'security-phrase';
  } else {
    securityPhrase.textContent = 'Set a security phrase in Settings: this window will show it, and a window that does not is not your wallet.';
    securityPhrase.className = 'security-phrase unset';
  }
}

/**
 * Handle reject button click
 */
async function handleReject(): Promise<void> {
  if (!currentRequest) return;

  try {
    const response = await sendMessage({
      type: MSG.REJECT_SIGNING_REQUEST,
      payload: {
        requestId: currentRequest.id,
      },
    });
    if (!response?.success) throw new Error(response?.error || 'Failed to reject request');

    showToast('Request rejected', 'success');

    // An approval window closes once its own request is answered; the plain
    // popup moves on to the next pending one
    const hasMore = boundRequestId ? false : await checkPendingRequests();
    if (!hasMore) {
      // Close the approval window
      setTimeout(() => {
        window.close();
      }, 500);
    }
  } catch (error) {
    showToast('Failed to reject request', 'error');
  }
}

/**
 * Hide the signing request view and return to wallet
 */
export function hideSigningRequestView(): void {
  currentRequest = null;
  hideView();
}

/**
 * Setup event listeners for signing request UI
 */
export function setupSigningRequestUIHandlers(): void {
  const elements = getElements();

  if (elements.approveBtn) {
    elements.approveBtn.addEventListener('click', handleApprove);
  }

  // Leaving the window disarms Approve; coming back starts the delay again
  window.addEventListener('blur', () => { if (currentRequest) disarmApprove(); });
  window.addEventListener('focus', () => { if (currentRequest) armApprove(); });

  if (elements.rejectBtn) {
    elements.rejectBtn.addEventListener('click', handleReject);
  }

  if (elements.backBtn) {
    elements.backBtn.addEventListener('click', handleReject);
  }

  // Allow Enter key to submit
  if (elements.password) {
    elements.password.addEventListener('keypress', (e) => {
      if (e.key === 'Enter') {
        handleApprove();
      }
    });
  }
}

// An ISO time as the owner's local time, with the UTC time after it
function localTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return `${d.toLocaleString()} (${iso})`;
}

function el(tag: string, className: string, text?: string): HTMLElement {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function detailRow(label: string, value: HTMLElement): HTMLElement {
  const row = el('div', 'signing-detail-row');
  row.append(el('span', 'signing-detail-label', label), value);
  return row;
}

function warningRow(className: string, text: string): HTMLElement {
  const row = el('div', `signing-detail-row ${className}`);
  const span = el('span', '', text);
  span.style.color = 'var(--warning, #f59e0b)';
  row.append(span);
  return row;
}
