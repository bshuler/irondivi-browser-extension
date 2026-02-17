/**
 * Signing Request UI Module
 *
 * Handles the display and user interaction for dApp signing requests
 * (sign_message and send_transaction).
 */

import { MSG, sendMessage } from '../shared/constants';
import { showLoading, hideLoading, showToast, showView, hideView, formatAddress, formatAmount } from './ui-state';

// Type for a pending signing request
export interface SigningRequest {
  id: string;
  type: 'sign_message' | 'send_transaction';
  origin: string;
  accountId: string;
  data: {
    message?: string;
    to?: string;
    amount?: number;
    fee?: number;
    addressIndex?: number;
  };
  createdAt: number;
}

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
    type: document.getElementById('signing-type') as HTMLDivElement,
    details: document.getElementById('signing-details') as HTMLDivElement,
    password: document.getElementById('signing-password') as HTMLInputElement,
    rejectBtn: document.getElementById('reject-request-btn') as HTMLButtonElement,
    approveBtn: document.getElementById('approve-request-btn') as HTMLButtonElement,
  };
}

/**
 * Check for pending signing requests and show UI if any exist
 * Returns true if there are pending requests
 */
export async function checkPendingRequests(): Promise<boolean> {
  try {
    const response = await sendMessage({
      type: MSG.GET_PENDING_SIGNING_REQUESTS,
    });

    const data = response.data as { requests?: SigningRequest[] } | undefined;
    if (response.success && data?.requests && data.requests.length > 0) {
      const request = data.requests[0];
      showSigningRequestView(request);
      return true;
    }
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

  // Set type label
  if (request.type === 'sign_message') {
    elements.type.textContent = 'Sign Message';
    elements.type.className = 'signing-type sign-message';
  } else {
    elements.type.textContent = 'Send Transaction';
    elements.type.className = 'signing-type send-transaction';
  }

  // Build details content
  let detailsHtml = '';

  if (request.type === 'sign_message') {
    const message = request.data.message || '';
    // Show truncated message if too long
    const displayMessage = message.length > 200
      ? message.substring(0, 200) + '...'
      : message;
    detailsHtml = `
      <div class="signing-detail-row">
        <span class="signing-detail-label">Message:</span>
        <div class="signing-message-content">${escapeHtml(displayMessage)}</div>
      </div>
    `;
  } else if (request.type === 'send_transaction') {
    const to = request.data.to || '';
    const amount = request.data.amount || 0;
    const fee = request.data.fee || 0.0001;
    detailsHtml = `
      <div class="signing-detail-row">
        <span class="signing-detail-label">To:</span>
        <span class="signing-detail-value address">${formatAddress(to, 12)}</span>
      </div>
      <div class="signing-detail-row">
        <span class="signing-detail-label">Amount:</span>
        <span class="signing-detail-value amount">${formatAmount(amount)} PDIVI</span>
      </div>
      <div class="signing-detail-row">
        <span class="signing-detail-label">Fee:</span>
        <span class="signing-detail-value">${formatAmount(fee)} PDIVI</span>
      </div>
      <div class="signing-detail-row total">
        <span class="signing-detail-label">Total:</span>
        <span class="signing-detail-value amount">${formatAmount(amount + fee)} PDIVI</span>
      </div>
    `;
  }

  elements.details.innerHTML = detailsHtml;

  // Clear password field
  elements.password.value = '';

  // Show the view
  showView(elements.view);
}

/**
 * Handle approve button click
 */
async function handleApprove(): Promise<void> {
  if (!currentRequest) return;

  const elements = getElements();
  const password = elements.password.value;

  if (!password) {
    showToast('Please enter your password', 'error');
    return;
  }

  showLoading(currentRequest.type === 'sign_message' ? 'Signing message...' : 'Sending transaction...');

  try {
    const response = await sendMessage({
      type: MSG.APPROVE_SIGNING_REQUEST,
      payload: {
        requestId: currentRequest.id,
        password,
      },
    });

    hideLoading();

    if (response.success) {
      if (currentRequest.type === 'sign_message') {
        showToast('Message signed successfully', 'success');
      } else {
        showToast('Transaction sent successfully', 'success');
      }

      // Check for more pending requests
      const hasMore = await checkPendingRequests();
      if (!hasMore) {
        hideSigningRequestView();
      }
    } else {
      showToast(response.error || 'Failed to approve request', 'error');
    }
  } catch (error) {
    hideLoading();
    showToast('Failed to approve request', 'error');
  }
}

/**
 * Handle reject button click
 */
async function handleReject(): Promise<void> {
  if (!currentRequest) return;

  try {
    await sendMessage({
      type: MSG.REJECT_SIGNING_REQUEST,
      payload: {
        requestId: currentRequest.id,
      },
    });

    showToast('Request rejected', 'success');

    // Check for more pending requests
    const hasMore = await checkPendingRequests();
    if (!hasMore) {
      hideSigningRequestView();
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

/**
 * Escape HTML to prevent XSS
 */
function escapeHtml(text: string): string {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}
