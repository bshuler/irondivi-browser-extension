import { runtime } from '../shared/browser-polyfill';
import { MSG, UI_PORT } from '../shared/constants';
import { sendMessage } from './message-api';
import {
  assertPasskeyInWindow,
  createAndVerifyPasskeyInWindow,
  fetchPasskeySlots,
} from './passkey-client';

// Keep UI port alive while the standalone ceremony window is open
try {
  runtime.connect({ name: UI_PORT });
} catch {
  // Ignore if port connect unavailable
}

const params = new URLSearchParams(window.location.search);
const mode = params.get('mode') || 'unlock';
const accountIdParam = params.get('accountId') || '';
const tokenParam = params.get('token') || '';

const titleEl = document.getElementById('passkey-title')!;
const subtitleEl = document.getElementById('passkey-subtitle')!;
const enrolFieldsEl = document.getElementById('passkey-enrol-fields')!;
const enrolLabelInput = document.getElementById('passkey-enrol-label') as HTMLInputElement;
const sendSummaryEl = document.getElementById('passkey-send-summary')!;
const sendAccountEl = document.getElementById('passkey-send-account')!;
const sendToEl = document.getElementById('passkey-send-to')!;
const sendAmountEl = document.getElementById('passkey-send-amount')!;
const sendFeeEl = document.getElementById('passkey-send-fee')!;
const sendTotalEl = document.getElementById('passkey-send-total')!;
const sendMemoRowEl = document.getElementById('passkey-send-memo-row')!;
const sendMemoEl = document.getElementById('passkey-send-memo')!;
const errorEl = document.getElementById('passkey-error')!;
const statusEl = document.getElementById('passkey-status')!;
const actionBtn = document.getElementById('passkey-ceremony-btn') as HTMLButtonElement;
const cancelBtn = document.getElementById('passkey-cancel-btn') as HTMLButtonElement;

let enrolContext: {
  accountId: string;
  accountName: string;
  label: string;
  existingCredentialIds: string[];
} | null = null;

let stagedSendAccountId = '';

function showError(message: string): void {
  errorEl.textContent = message;
  errorEl.classList.remove('hidden');
  statusEl.classList.add('hidden');
}

function clearError(): void {
  errorEl.textContent = '';
  errorEl.classList.add('hidden');
}

function showSuccess(message: string): void {
  clearError();
  statusEl.textContent = message;
  statusEl.classList.remove('hidden');
}

async function initCeremony(): Promise<void> {
  clearError();

  if (mode === 'enrol') {
    titleEl.textContent = 'Add Passkey';
    subtitleEl.textContent = 'Create a local passkey to unlock and verify transactions on this device.';
    actionBtn.textContent = 'Create Passkey';

    if (!tokenParam) {
      actionBtn.disabled = true;
      showError('Missing enrolment session. Start again from Settings.');
      return;
    }

    try {
      const info = await sendMessage<{
        accountId: string;
        accountName: string;
        label: string;
        existingCredentialIds: string[];
      }>(MSG.GET_PASSKEY_ENROL_INFO, { token: tokenParam });
      enrolContext = info;
      enrolLabelInput.value = info.label || 'Passkey 1';
      enrolFieldsEl.classList.remove('hidden');
    } catch (err) {
      actionBtn.disabled = true;
      showError(
        err instanceof Error
          ? err.message
          : 'Passkey enrolment session expired. Start again from Settings.',
      );
    }
    return;
  }

  if (mode === 'confirm-send') {
    titleEl.textContent = 'Confirm Send with Passkey';
    subtitleEl.textContent = 'Review the transaction details below, then verify with your passkey.';
    actionBtn.textContent = 'Verify with Passkey & Send';

    if (!tokenParam) {
      actionBtn.disabled = true;
      showError('Missing transaction session. Start the send again.');
      return;
    }

    try {
      const data = await sendMessage<{
        accountId: string;
        accountName: string;
        summary: {
          to: string;
          amount: string;
          fee: number;
          total: string;
          network: string;
          memo?: string;
        };
      }>(MSG.GET_STAGED_PASSKEY_SEND, { token: tokenParam });
      stagedSendAccountId = data.accountId;
      sendAccountEl.textContent = `${data.accountName} (${data.summary.network})`;
      sendToEl.textContent = data.summary.to;
      sendAmountEl.textContent = `${data.summary.amount} DIVI`;
      sendFeeEl.textContent = `${data.summary.fee} DIVI`;
      sendTotalEl.textContent = `${data.summary.total} DIVI`;
      if (data.summary.memo) {
        sendMemoEl.textContent = data.summary.memo;
        sendMemoRowEl.classList.remove('hidden');
      }
      sendSummaryEl.classList.remove('hidden');
    } catch (err) {
      actionBtn.disabled = true;
      showError(
        err instanceof Error
          ? err.message
          : 'Pending transaction expired. Start the send again.',
      );
    }
    return;
  }

  // Default: mode === 'unlock'
  titleEl.textContent = 'Unlock Wallet';
  subtitleEl.textContent = 'Use your enrolled passkey to unlock IronDivi Wallet.';
  actionBtn.textContent = 'Unlock with Passkey';
}

async function runCeremony(): Promise<void> {
  clearError();
  const originalLabel = actionBtn.textContent || 'Continue with Passkey';
  actionBtn.disabled = true;
  actionBtn.textContent = 'Waiting for passkey...';

  try {
    if (mode === 'enrol') {
      if (!enrolContext) {
        throw new Error('Passkey enrolment session expired. Start again from Settings.');
      }
      const chosenLabel = enrolLabelInput.value.trim() || enrolContext.label || 'Passkey 1';
      const created = await createAndVerifyPasskeyInWindow({
        accountName: enrolContext.accountName,
        label: chosenLabel,
        existingCredentialIds: enrolContext.existingCredentialIds,
      });

      const finish = await sendMessage<{ slot?: unknown }>(MSG.FINISH_PASSKEY_ENROL, {
        token: tokenParam,
        credentialId: created.credentialId,
        prfSalt: created.prfSalt,
        prfOutput: created.prfOutput,
        label: chosenLabel,
      });

      await sendMessage(MSG.PASSKEY_CEREMONY_DONE, {
        mode: 'enrol',
        accountId: enrolContext.accountId,
        result: finish,
      }).catch(() => {});

      showSuccess('Passkey added!');
      cancelBtn.textContent = 'Close';
      setTimeout(() => window.close(), 450);
      return;
    }

    if (mode === 'confirm-send') {
      const slots = await fetchPasskeySlots(stagedSendAccountId || accountIdParam || undefined);
      const passkeyAuth = await assertPasskeyInWindow(slots);
      const txData = await sendMessage<{ txid?: string }>(MSG.EXECUTE_STAGED_PASSKEY_SEND, {
        token: tokenParam,
        passkeyAuth,
      });
      await sendMessage(MSG.PASSKEY_CEREMONY_DONE, {
        mode: 'confirm-send',
        accountId: stagedSendAccountId,
        result: txData,
      }).catch(() => {});

      showSuccess(txData?.txid ? `Transaction sent! TXID: ${txData.txid.slice(0, 16)}...` : 'Transaction sent!');
      cancelBtn.textContent = 'Done';
      setTimeout(() => window.close(), 800);
      return;
    }

    // Unlock mode
    const slots = await fetchPasskeySlots(accountIdParam || undefined);
    const passkeyAuth = await assertPasskeyInWindow(slots);
    await sendMessage(MSG.UNLOCK_WALLET_PASSKEY, {
      accountId: accountIdParam,
      credentialId: passkeyAuth.credentialId,
      prfOutput: passkeyAuth.prfOutput,
      passkeyAuth,
    });

    await sendMessage(MSG.PASSKEY_CEREMONY_DONE, {
      mode: 'unlock',
      accountId: accountIdParam || undefined,
    }).catch(() => {});

    showSuccess('Wallet unlocked!');
    cancelBtn.textContent = 'Close';
    setTimeout(() => window.close(), 400);
  } catch (err) {
    showError(err instanceof Error ? err.message : 'Passkey operation failed');
    actionBtn.disabled = false;
    actionBtn.textContent = originalLabel;
  }
}

actionBtn.addEventListener('click', () => {
  void runCeremony();
});

cancelBtn.addEventListener('click', () => {
  if (mode === 'enrol' && tokenParam) {
    void sendMessage(MSG.CANCEL_PASSKEY_ENROL, { token: tokenParam }).finally(() => window.close());
    return;
  }
  window.close();
});

void initCeremony();
