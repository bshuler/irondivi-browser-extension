/**
 * Signing Request UI Module
 *
 * Handles the display and user interaction for dApp signing requests
 * (sign_message and send_transaction).
 */

import { MSG, sendMessage } from '../shared/constants';
import { showLoading, hideLoading, showToast, showView, hideView, formatAmount } from './ui-state';

// Type for a pending request (connection, signing, or transaction)
export interface SigningRequest {
  id: string;
  type: 'connect' | 'sign_message' | 'send_transaction';
  origin: string;
  accountId: string;
  data?: {
    message?: string;
    address?: string;
    to?: string;
    amount?: number;
    fee?: number;
    addressIndex?: number;
    opReturn?: string;
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
    warningText: document.getElementById('signing-warning-text') as HTMLSpanElement,
    password: document.getElementById('signing-password') as HTMLInputElement,
    rejectBtn: document.getElementById('reject-request-btn') as HTMLButtonElement,
    approveBtn: document.getElementById('approve-request-btn') as HTMLButtonElement,
  };
}

/**
 * Check for pending signing requests and show UI if any exist
 * @param requestId - Optional specific request ID to show
 * Returns true if there are pending requests
 */
export async function checkPendingRequests(requestId?: string): Promise<boolean> {
  try {
    const response = await sendMessage({
      type: MSG.GET_PENDING_SIGNING_REQUESTS,
    });

    const data = response.data as { requests?: SigningRequest[] } | undefined;
    if (response.success && data?.requests && data.requests.length > 0) {
      // If a specific requestId is provided, find that request
      let request: SigningRequest | undefined;
      if (requestId) {
        request = data.requests.find(r => r.id === requestId);
      }
      // Fallback to first request if specific one not found
      if (!request) {
        request = data.requests[0];
      }
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

  // Set type label and warning message based on request type
  if (request.type === 'connect') {
    elements.type.textContent = 'Connect Site';
    elements.type.className = 'signing-type connect';
    elements.warningText.textContent = 'This will share your wallet address with the site. No funds will be sent.';
  } else if (request.type === 'sign_message') {
    elements.type.textContent = 'Sign Message';
    elements.type.className = 'signing-type sign-message';
    elements.warningText.textContent = 'This creates a signature to verify your identity. No funds will be sent.';
  } else {
    elements.type.textContent = 'Send Transaction';
    elements.type.className = 'signing-type send-transaction';
    elements.warningText.textContent = 'This will send funds from your wallet. Please verify the details carefully.';
  }

  // Build details content
  let detailsHtml = '';

  if (request.type === 'connect') {
    // Keep it simple - the warning text explains what happens
    detailsHtml = `
      <div class="signing-detail-row" style="text-align: center; padding: 8px 0;">
        <span style="color: var(--text-secondary);">Allow this site to see your address and request approvals?</span>
      </div>
    `;
  } else if (request.type === 'sign_message') {
    const message = request.data?.message || '';
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
    if (request.data?.address) {
      detailsHtml += `
      <div class="signing-detail-row">
        <span class="signing-detail-label">Address:</span>
        <span class="signing-detail-value address">${escapeHtml(request.data.address)}</span>
      </div>
    `;
    }
  } else if (request.type === 'send_transaction') {
    const to = request.data?.to || '';
    const amount = request.data?.amount || 0;
    const fee = request.data?.fee || 0.00005;
    // Escape all user-provided values to prevent XSS. Show the whole
    // destination: a shortened one can hide a look-alike address.
    const escapedTo = escapeHtml(to);
    const escapedAmount = escapeHtml(formatAmount(amount));
    const escapedFee = escapeHtml(formatAmount(fee));
    const escapedTotal = escapeHtml(formatAmount(amount + fee));
    detailsHtml = `
      <div class="signing-detail-row">
        <span class="signing-detail-label">To:</span>
        <span class="signing-detail-value address">${escapedTo}</span>
      </div>
      <div class="signing-detail-row">
        <span class="signing-detail-label">Amount:</span>
        <span class="signing-detail-value amount">${escapedAmount} DIVI</span>
      </div>
      <div class="signing-detail-row">
        <span class="signing-detail-label">Fee:</span>
        <span class="signing-detail-value">${escapedFee} DIVI</span>
      </div>
      <div class="signing-detail-row total">
        <span class="signing-detail-label">Total:</span>
        <span class="signing-detail-value amount">${escapedTotal} DIVI</span>
      </div>
    `;
    if (request.data?.opReturn) {
      detailsHtml += `<div class="signing-detail-row"><span class="signing-detail-label">OP_RETURN</span><span class="signing-detail-value" style="font-size:11px;word-break:break-all">${escapeHtml(request.data.opReturn)}</span></div>`;
    }
  }

  elements.details.innerHTML = detailsHtml;

  // Clear password field
  elements.password.value = '';

  // Hide password field for connection requests (they don't need password)
  const passwordFormGroup = elements.password.closest('.form-group') as HTMLElement | null;
  if (passwordFormGroup) {
    passwordFormGroup.style.display = request.type === 'connect' ? 'none' : 'block';
  }

  // Show the view
  showView(elements.view);
}

/**
 * Handle approve button click
 */
async function handleApprove(): Promise<void> {
  if (!currentRequest) return;

  const elements = getElements();

  // Connection requests don't need password
  if (currentRequest.type === 'connect') {
    showLoading('Connecting...');

    try {
      await sendMessage({
        type: MSG.APPROVE_SIGNING_REQUEST,
        payload: {
          requestId: currentRequest.id,
          isConnection: true,
        },
      });

      hideLoading();
      showToast('Site connected successfully', 'success');

      // Close the approval window after a short delay
      setTimeout(() => {
        window.close();
      }, 500);
    } catch (error) {
      hideLoading();
      showToast(error instanceof Error ? error.message : 'Failed to connect', 'error');
    }
    return;
  }

  // Signing requests need password
  const password = elements.password.value;

  if (!password) {
    showToast('Please enter your password', 'error');
    return;
  }

  showLoading(currentRequest.type === 'sign_message' ? 'Signing message...' : 'Sending transaction...');

  try {
    await sendMessage({
      type: MSG.APPROVE_SIGNING_REQUEST,
      payload: {
        requestId: currentRequest.id,
        password,
      },
    });

    hideLoading();

    if (currentRequest.type === 'sign_message') {
      showToast('Message signed successfully', 'success');
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
