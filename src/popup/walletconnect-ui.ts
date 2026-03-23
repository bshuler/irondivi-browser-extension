/**
 * WalletConnect UI Module
 *
 * Handles the popup UI for WalletConnect session proposals and
 * session requests (divi_sendTransaction, divi_signMessage).
 *
 * When the popup is opened with `?wc_proposal=true` or `?wc_request=true`,
 * this module fetches the pending item from the background and renders
 * an approval view inside the existing signing-request view DOM.
 */

import { showLoading, hideLoading, showToast, showView, formatAddress, formatAmount } from './ui-state';
import { sendMessage } from './message-api';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface WcProposal {
  id: number;
  params: {
    proposer: {
      metadata: {
        name: string;
        url: string;
        description?: string;
        icons?: string[];
      };
    };
    requiredNamespaces?: Record<string, unknown>;
    optionalNamespaces?: Record<string, unknown>;
  };
  timestamp: number;
}

interface WcRequest {
  id: number;
  topic: string;
  method: string;
  params: any;
  timestamp: number;
}

// ---------------------------------------------------------------------------
// Initialization check
// ---------------------------------------------------------------------------

/**
 * Check URL params for WalletConnect flows. Call during popup init.
 * Returns true if a WC flow was activated (caller should skip normal init).
 */
export async function checkWalletConnectParams(): Promise<boolean> {
  const params = new URLSearchParams(window.location.search);

  if (params.get('wc_proposal') === 'true') {
    return await showProposalApproval();
  }

  if (params.get('wc_request') === 'true') {
    return await showRequestApproval();
  }

  return false;
}

// ---------------------------------------------------------------------------
// Session Proposal approval
// ---------------------------------------------------------------------------

async function showProposalApproval(): Promise<boolean> {
  try {
    const proposal: WcProposal | null = await sendMessage('WC_GET_PENDING_PROPOSAL');
    if (!proposal) {
      // Proposal already handled or expired
      return false;
    }

    const { proposer } = proposal.params;
    const meta = proposer.metadata;

    // Reuse the signing-request view
    const view = document.getElementById('view-signing-request') as HTMLDivElement;
    if (!view) return false;

    const originEl = document.getElementById('signing-origin') as HTMLDivElement;
    const typeEl = document.getElementById('signing-type') as HTMLDivElement;
    const detailsEl = document.getElementById('signing-details') as HTMLDivElement;
    const warningEl = document.getElementById('signing-warning-text') as HTMLSpanElement;
    const passwordGroup = (document.getElementById('signing-password') as HTMLInputElement)
      ?.closest('.form-group') as HTMLElement | null;
    const approveBtn = document.getElementById('approve-request-btn') as HTMLButtonElement;
    const rejectBtn = document.getElementById('reject-request-btn') as HTMLButtonElement;

    // Populate UI
    originEl.textContent = meta.url || meta.name;

    typeEl.textContent = 'WalletConnect Session';
    typeEl.className = 'signing-type connect';

    const iconHtml = meta.icons?.[0]
      ? `<img src="${escapeAttr(meta.icons[0])}" alt="" style="width:32px;height:32px;border-radius:6px;margin-right:8px;vertical-align:middle;">`
      : '';

    detailsEl.innerHTML = `
      <div class="signing-detail-row" style="text-align:center;padding:8px 0;align-items:center;justify-content:center;">
        ${iconHtml}
        <span style="font-weight:600;">${escapeHtml(meta.name)}</span>
      </div>
      ${meta.description ? `<div class="signing-detail-row" style="text-align:center;padding:4px 0;"><span style="color:var(--text-secondary);font-size:13px;">${escapeHtml(meta.description)}</span></div>` : ''}
      <div class="signing-detail-row" style="text-align:center;padding:8px 0;">
        <span style="color:var(--text-secondary);">This dApp wants to connect via WalletConnect. Allow it to see your address and request approvals?</span>
      </div>
    `;

    warningEl.textContent = 'Only connect to dApps you trust.';

    // No password needed for proposals
    if (passwordGroup) passwordGroup.style.display = 'none';

    // Wire up buttons
    const approveHandler = async () => {
      showLoading('Connecting...');
      try {
        await sendMessage('WC_APPROVE_PROPOSAL', { proposalId: proposal.id });
        hideLoading();
        showToast('Connected via WalletConnect', 'success');
        setTimeout(() => window.close(), 500);
      } catch (err) {
        hideLoading();
        showToast(err instanceof Error ? err.message : 'Failed to connect', 'error');
      }
    };

    const rejectHandler = async () => {
      try {
        await sendMessage('WC_REJECT_PROPOSAL', { proposalId: proposal.id });
        showToast('Connection rejected', 'success');
        setTimeout(() => window.close(), 500);
      } catch {
        showToast('Failed to reject', 'error');
      }
    };

    // Replace handlers (clone to remove old listeners)
    replaceButton(approveBtn, approveHandler);
    replaceButton(rejectBtn, rejectHandler);

    showView(view);
    return true;
  } catch (err) {
    console.error('[WC-UI] Failed to show proposal approval', err);
    return false;
  }
}

// ---------------------------------------------------------------------------
// Session Request approval (divi_sendTransaction / divi_signMessage)
// ---------------------------------------------------------------------------

async function showRequestApproval(): Promise<boolean> {
  try {
    const request: WcRequest | null = await sendMessage('WC_GET_PENDING_REQUEST');
    if (!request) return false;

    const view = document.getElementById('view-signing-request') as HTMLDivElement;
    if (!view) return false;

    const originEl = document.getElementById('signing-origin') as HTMLDivElement;
    const typeEl = document.getElementById('signing-type') as HTMLDivElement;
    const detailsEl = document.getElementById('signing-details') as HTMLDivElement;
    const warningEl = document.getElementById('signing-warning-text') as HTMLSpanElement;
    const passwordInput = document.getElementById('signing-password') as HTMLInputElement;
    const passwordGroup = passwordInput?.closest('.form-group') as HTMLElement | null;
    const approveBtn = document.getElementById('approve-request-btn') as HTMLButtonElement;
    const rejectBtn = document.getElementById('reject-request-btn') as HTMLButtonElement;

    // Try to get the session for origin info
    let sessionOrigin = 'WalletConnect dApp';
    try {
      const sessionsResult = await sendMessage<{ sessions: Record<string, any> }>('WC_GET_SESSIONS');
      if (sessionsResult?.sessions) {
        const session = (sessionsResult.sessions as Record<string, any>)[request.topic];
        if (session?.peer?.metadata?.url) {
          sessionOrigin = session.peer.metadata.url;
        } else if (session?.peer?.metadata?.name) {
          sessionOrigin = session.peer.metadata.name;
        }
      }
    } catch {
      // use default origin
    }

    originEl.textContent = sessionOrigin;

    if (request.method === 'divi_sendTransaction') {
      typeEl.textContent = 'Send Transaction (WC)';
      typeEl.className = 'signing-type send-transaction';
      warningEl.textContent = 'This will send funds from your wallet. Verify the details carefully.';

      const txParams = request.params?.[0] || request.params || {};
      const to = txParams.to || '';
      const amount = txParams.amount || 0;
      const fee = txParams.fee || 0.00005;

      detailsEl.innerHTML = `
        <div class="signing-detail-row">
          <span class="signing-detail-label">To:</span>
          <span class="signing-detail-value address">${escapeHtml(formatAddress(to, 12))}</span>
        </div>
        <div class="signing-detail-row">
          <span class="signing-detail-label">Amount:</span>
          <span class="signing-detail-value amount">${escapeHtml(formatAmount(amount))} PDIVI</span>
        </div>
        <div class="signing-detail-row">
          <span class="signing-detail-label">Fee:</span>
          <span class="signing-detail-value">${escapeHtml(formatAmount(fee))} PDIVI</span>
        </div>
        <div class="signing-detail-row total">
          <span class="signing-detail-label">Total:</span>
          <span class="signing-detail-value amount">${escapeHtml(formatAmount(amount + fee))} PDIVI</span>
        </div>
      `;
    } else if (request.method === 'divi_signMessage') {
      typeEl.textContent = 'Sign Message (WC)';
      typeEl.className = 'signing-type sign-message';
      warningEl.textContent = 'This creates a signature to verify your identity. No funds will be sent.';

      const msgParams = request.params?.[0] || request.params || {};
      const message = typeof msgParams === 'string' ? msgParams : (msgParams.message || '');
      const displayMessage = message.length > 200 ? message.substring(0, 200) + '...' : message;

      detailsEl.innerHTML = `
        <div class="signing-detail-row">
          <span class="signing-detail-label">Message:</span>
          <div class="signing-message-content">${escapeHtml(displayMessage)}</div>
        </div>
      `;
    } else {
      typeEl.textContent = `Unknown Method: ${request.method}`;
      typeEl.className = 'signing-type';
      detailsEl.innerHTML = '<div class="signing-detail-row"><span>This method is not supported.</span></div>';
      warningEl.textContent = 'This request cannot be processed.';
    }

    // Password is needed for signing/sending
    if (passwordGroup) passwordGroup.style.display = 'block';
    if (passwordInput) passwordInput.value = '';

    // Wire up buttons
    const approveHandler = async () => {
      const password = passwordInput?.value;
      if (!password) {
        showToast('Please enter your password', 'error');
        return;
      }

      // Get current account ID
      let accountId: string | undefined;
      try {
        const response = await chrome.runtime.sendMessage({ type: 'GET_ACCOUNTS' });
        accountId = response?.data?.currentAccountId;
      } catch {
        showToast('Failed to get account', 'error');
        return;
      }

      if (!accountId) {
        showToast('No account selected', 'error');
        return;
      }

      showLoading(request.method === 'divi_sendTransaction' ? 'Sending transaction...' : 'Signing message...');

      try {
        await sendMessage('WC_APPROVE_REQUEST', {
          topic: request.topic,
          requestId: request.id,
          method: request.method,
          params: request.params,
          accountId,
          password,
        });

        hideLoading();
        showToast(
          request.method === 'divi_sendTransaction'
            ? 'Transaction sent via WalletConnect'
            : 'Message signed via WalletConnect',
          'success',
        );
        setTimeout(() => window.close(), 500);
      } catch (err) {
        hideLoading();
        if (passwordInput) passwordInput.value = '';
        showToast(err instanceof Error ? err.message : 'Request failed', 'error');
      }
    };

    const rejectHandler = async () => {
      try {
        await sendMessage('WC_REJECT_REQUEST', {
          topic: request.topic,
          requestId: request.id,
          message: 'User rejected',
        });
        showToast('Request rejected', 'success');
        setTimeout(() => window.close(), 500);
      } catch {
        showToast('Failed to reject', 'error');
      }
    };

    replaceButton(approveBtn, approveHandler);
    replaceButton(rejectBtn, rejectHandler);

    // Allow Enter key to submit
    if (passwordInput) {
      const keyHandler = (e: KeyboardEvent) => {
        if (e.key === 'Enter') approveHandler();
      };
      passwordInput.removeEventListener('keypress', keyHandler);
      passwordInput.addEventListener('keypress', keyHandler);
    }

    showView(view);
    return true;
  } catch (err) {
    console.error('[WC-UI] Failed to show request approval', err);
    return false;
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function escapeHtml(text: string): string {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

function escapeAttr(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/'/g, '&#39;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/**
 * Replace a button element with a clone (to strip old event listeners)
 * then attach the new handler.
 */
function replaceButton(btn: HTMLButtonElement, handler: () => void) {
  if (!btn) return;
  const clone = btn.cloneNode(true) as HTMLButtonElement;
  btn.parentNode?.replaceChild(clone, btn);
  clone.addEventListener('click', handler);
}
