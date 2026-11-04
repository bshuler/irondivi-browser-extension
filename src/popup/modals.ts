/**
 * Modal management - password, passkey re-auth, wallet unlock, confirmation, mnemonic display
 */

import { runtime } from '../shared/browser-polyfill';
import { MSG, type PasskeyAuthInput } from '../shared/constants';
import { elements } from './elements';
import { state } from './state';
import { clearPasswordInput } from './ui-state';
import {
  assertPasskeyInWindow,
  fetchPasskeySlots,
  isTransientToolbarPopup,
  openPasskeyCeremonyWindow,
} from './passkey-client';

export interface AuthModalResult {
  password?: string;
  passkeyAuth?: PasskeyAuthInput;
}

/**
 * Show the mnemonic modal with a blurred recovery phrase
 */
export function showMnemonicModal(mnemonic: string, title = 'Recovery Phrase'): Promise<void> {
  return new Promise(resolve => {
    state.mnemonicModalResolver = resolve;

    elements.mnemonicModalTitle.textContent = title;

    const words = mnemonic.trim().split(/\s+/);
    elements.mnemonicGrid.innerHTML = '';
    words.forEach((word, i) => {
      const wordEl = document.createElement('div');
      wordEl.className = 'mnemonic-word';
      const numSpan = document.createElement('span');
      numSpan.className = 'word-num';
      numSpan.textContent = `${i + 1}.`;
      const textSpan = document.createElement('span');
      textSpan.className = 'word-text';
      textSpan.textContent = word;
      wordEl.appendChild(numSpan);
      wordEl.appendChild(textSpan);
      elements.mnemonicGrid.appendChild(wordEl);
    });

    // Start blurred
    elements.mnemonicGrid.classList.add('blurred');
    elements.mnemonicToggleBtn.textContent = 'Show Phrase';

    elements.mnemonicModal.classList.remove('hidden');
  });
}

/**
 * Hide the mnemonic modal and resolve the promise
 */
export function hideMnemonicModal(): void {
  elements.mnemonicModal.classList.add('hidden');
  elements.mnemonicGrid.innerHTML = '';
  if (state.mnemonicModalResolver) {
    state.mnemonicModalResolver();
    state.mnemonicModalResolver = null;
  }
}

/**
 * Show a confirmation modal for destructive actions
 */
export function showConfirmModal(title: string, message: string, okLabel = 'Delete'): Promise<boolean> {
  return new Promise(resolve => {
    const modal = document.getElementById('confirm-modal') as HTMLDivElement;
    const titleEl = document.getElementById('confirm-modal-title') as HTMLHeadingElement;
    const messageEl = document.getElementById('confirm-modal-message') as HTMLParagraphElement;
    const cancelBtn = document.getElementById('confirm-modal-cancel') as HTMLButtonElement;
    const okBtn = document.getElementById('confirm-modal-ok') as HTMLButtonElement;

    titleEl.textContent = title;
    messageEl.textContent = message;
    okBtn.textContent = okLabel;
    modal.classList.remove('hidden');

    const cleanup = () => {
      modal.classList.add('hidden');
    };

    okBtn.onclick = () => {
      cleanup();
      resolve(true);
    };

    cancelBtn.onclick = () => {
      cleanup();
      resolve(false);
    };
  });
}

/**
 * Show a text input modal for general input (e.g., rename)
 */
export function showInputModal(title: string, placeholder: string, defaultValue = ''): Promise<string | null> {
  return new Promise(resolve => {
    const modal = document.getElementById('input-modal') as HTMLDivElement;
    const titleEl = document.getElementById('input-modal-title') as HTMLHeadingElement;
    const input = document.getElementById('input-modal-input') as HTMLInputElement;
    const cancelBtn = document.getElementById('input-modal-cancel') as HTMLButtonElement;
    const submitBtn = document.getElementById('input-modal-submit') as HTMLButtonElement;

    titleEl.textContent = title;
    input.placeholder = placeholder;
    input.value = defaultValue;
    modal.classList.remove('hidden');
    input.focus();
    input.select();

    const cleanup = () => {
      modal.classList.add('hidden');
      input.value = '';
    };

    const handleSubmit = () => {
      const value = input.value.trim();
      cleanup();
      resolve(value || null);
    };

    const handleCancel = () => {
      cleanup();
      resolve(null);
    };

    submitBtn.onclick = handleSubmit;
    cancelBtn.onclick = handleCancel;
    input.onkeydown = (e) => {
      if (e.key === 'Enter') handleSubmit();
      if (e.key === 'Escape') handleCancel();
    };
  });
}

/**
 * Show a password input modal (strictly password only, e.g. passkey enrolment)
 */
export function showPasswordModal(title: string): Promise<string | null> {
  return new Promise(resolve => {
    const modal = document.getElementById('password-modal') as HTMLDivElement;
    const titleEl = document.getElementById('password-modal-title') as HTMLHeadingElement;
    const input = document.getElementById('password-modal-input') as HTMLInputElement;
    const cancelBtn = document.getElementById('password-modal-cancel') as HTMLButtonElement;
    const submitBtn = document.getElementById('password-modal-submit') as HTMLButtonElement;
    const passkeyWrap = document.getElementById('password-modal-passkey-wrap') as HTMLDivElement | null;
    const passkeyBtn = document.getElementById('password-modal-passkey-btn') as HTMLButtonElement | null;
    const errorEl = document.getElementById('password-modal-error') as HTMLDivElement | null;

    if (passkeyWrap) passkeyWrap.classList.add('hidden');
    if (passkeyBtn) delete passkeyBtn.dataset.testid;
    if (errorEl) {
      errorEl.textContent = '';
      errorEl.classList.add('hidden');
    }

    titleEl.textContent = title;
    input.value = '';
    modal.classList.remove('hidden');
    input.focus();

    const cleanup = () => {
      modal.classList.add('hidden');
      clearPasswordInput(input);
      if (errorEl) {
        errorEl.textContent = '';
        errorEl.classList.add('hidden');
      }
    };

    const handleSubmit = () => {
      const password = input.value;
      cleanup();
      resolve(password || null);
    };

    const handleCancel = () => {
      cleanup();
      resolve(null);
    };

    submitBtn.onclick = handleSubmit;
    cancelBtn.onclick = handleCancel;
    input.onkeydown = (e) => {
      if (e.key === 'Enter') handleSubmit();
      if (e.key === 'Escape') handleCancel();
    };
  });
}

/**
 * Show a re-authentication modal offering "Verify with Passkey" whenever the
 * account has 1+ enrolled passkey slots, alongside password verification.
 */
export async function showAuthModal(title: string, accountId?: string): Promise<AuthModalResult | null> {
  const targetAccountId = accountId ?? state.currentAccount?.id;
  const slots = targetAccountId ? await fetchPasskeySlots(targetAccountId) : [];

  return new Promise(resolve => {
    const modal = document.getElementById('password-modal') as HTMLDivElement;
    const titleEl = document.getElementById('password-modal-title') as HTMLHeadingElement;
    const input = document.getElementById('password-modal-input') as HTMLInputElement;
    const cancelBtn = document.getElementById('password-modal-cancel') as HTMLButtonElement;
    const submitBtn = document.getElementById('password-modal-submit') as HTMLButtonElement;
    const passkeyWrap = document.getElementById('password-modal-passkey-wrap') as HTMLDivElement | null;
    const passkeyBtn = document.getElementById('password-modal-passkey-btn') as HTMLButtonElement | null;
    const errorEl = document.getElementById('password-modal-error') as HTMLDivElement | null;
    const sendPasskeyBtn = document.getElementById('send-passkey-btn') as HTMLButtonElement | null;
    const restoreSendTestId = sendPasskeyBtn?.dataset.testid === 'reauth-passkey-btn';

    if (errorEl) {
      errorEl.textContent = '';
      errorEl.classList.add('hidden');
    }

    if (slots.length > 0 && passkeyWrap && passkeyBtn) {
      if (restoreSendTestId && sendPasskeyBtn) {
        delete sendPasskeyBtn.dataset.testid;
      }
      passkeyBtn.textContent = 'Verify with Passkey';
      passkeyBtn.disabled = false;
      passkeyBtn.dataset.testid = 'reauth-passkey-btn';
      passkeyWrap.classList.remove('hidden');
    } else {
      passkeyWrap?.classList.add('hidden');
      if (passkeyBtn) delete passkeyBtn.dataset.testid;
    }

    titleEl.textContent = title;
    input.value = '';
    modal.classList.remove('hidden');
    input.focus();

    const cleanup = () => {
      modal.classList.add('hidden');
      clearPasswordInput(input);
      passkeyWrap?.classList.add('hidden');
      if (passkeyBtn) {
        delete passkeyBtn.dataset.testid;
        passkeyBtn.onclick = null;
      }
      if (restoreSendTestId && sendPasskeyBtn) {
        sendPasskeyBtn.dataset.testid = 'reauth-passkey-btn';
      }
      if (errorEl) {
        errorEl.textContent = '';
        errorEl.classList.add('hidden');
      }
    };

    const handleSubmit = () => {
      const password = input.value;
      if (!password) {
        if (errorEl) {
          errorEl.textContent = 'Please enter your password';
          errorEl.classList.remove('hidden');
        }
        return;
      }
      cleanup();
      resolve({ password });
    };

    const handleCancel = () => {
      cleanup();
      resolve(null);
    };

    if (passkeyBtn && slots.length > 0) {
      passkeyBtn.onclick = async () => {
        if (errorEl) {
          errorEl.textContent = '';
          errorEl.classList.add('hidden');
        }
        passkeyBtn.disabled = true;
        passkeyBtn.textContent = 'Waiting for passkey...';
        try {
          const passkeyAuth = await assertPasskeyInWindow(slots);
          cleanup();
          resolve({ passkeyAuth });
        } catch (err) {
          passkeyBtn.disabled = false;
          passkeyBtn.textContent = 'Verify with Passkey';
          if (errorEl) {
            errorEl.textContent = err instanceof Error ? err.message : 'Passkey verification failed';
            errorEl.classList.remove('hidden');
          }
        }
      };
    }

    submitBtn.onclick = handleSubmit;
    cancelBtn.onclick = handleCancel;
    input.onkeydown = (e) => {
      if (e.key === 'Enter') handleSubmit();
      if (e.key === 'Escape') handleCancel();
    };
  });
}

let unlockSuccessCallback: (() => void) | null = null;

export function hideUnlockModal(): void {
  const modal = document.getElementById('unlock-modal') as HTMLDivElement | null;
  const input = document.getElementById('unlock-password-input') as HTMLInputElement | null;
  const errorEl = document.getElementById('unlock-error-msg') as HTMLDivElement | null;
  if (input) clearPasswordInput(input);
  if (errorEl) {
    errorEl.textContent = '';
    errorEl.classList.add('hidden');
  }
  modal?.classList.add('hidden');
  const cb = unlockSuccessCallback;
  unlockSuccessCallback = null;
  cb?.();
}

/**
 * Show the wallet Unlock Modal. Offers "Unlock with Passkey" when the active
 * account has 1+ passkey slots, plus password unlock below.
 */
export async function showUnlockModal(accountId?: string, onUnlocked?: () => void): Promise<void> {
  const targetId = accountId ?? state.currentAccount?.id;
  if (!targetId) return;

  const modal = document.getElementById('unlock-modal') as HTMLDivElement | null;
  const accountNameEl = document.getElementById('unlock-account-name') as HTMLParagraphElement | null;
  const passkeyGroup = document.getElementById('unlock-passkey-group') as HTMLDivElement | null;
  const passkeyBtn = document.getElementById('unlock-passkey-btn') as HTMLButtonElement | null;
  const passwordInput = document.getElementById('unlock-password-input') as HTMLInputElement | null;
  const passwordBtn = document.getElementById('unlock-password-btn') as HTMLButtonElement | null;
  const errorEl = document.getElementById('unlock-error-msg') as HTMLDivElement | null;
  if (!modal || !passwordInput || !passwordBtn) return;

  if (onUnlocked) unlockSuccessCallback = onUnlocked;

  const account = state.accounts.find(a => a.id === targetId) ?? state.currentAccount;
  if (accountNameEl) {
    accountNameEl.textContent = account ? account.name : '';
  }
  if (errorEl) {
    errorEl.textContent = '';
    errorEl.classList.add('hidden');
  }
  passwordInput.value = '';

  const slots = await fetchPasskeySlots(targetId);
  if (slots.length > 0 && passkeyGroup && passkeyBtn) {
    passkeyBtn.disabled = false;
    passkeyBtn.textContent = 'Unlock with Passkey';
    passkeyGroup.classList.remove('hidden');
  } else {
    passkeyGroup?.classList.add('hidden');
  }

  const showUnlockError = (msg: string) => {
    if (!errorEl) return;
    errorEl.textContent = msg;
    errorEl.classList.remove('hidden');
  };

  if (passkeyBtn && slots.length > 0) {
    passkeyBtn.onclick = async () => {
      if (errorEl) errorEl.classList.add('hidden');
      try {
        if (await isTransientToolbarPopup()) {
          await openPasskeyCeremonyWindow({ mode: 'unlock', accountId: targetId });
          return;
        }
        passkeyBtn.disabled = true;
        passkeyBtn.textContent = 'Waiting for passkey...';
        const passkeyAuth = await assertPasskeyInWindow(slots);
        const reply = await runtime.sendMessage({
          type: MSG.UNLOCK_WALLET_PASSKEY,
          payload: {
            accountId: targetId,
            credentialId: passkeyAuth.credentialId,
            prfOutput: passkeyAuth.prfOutput,
            passkeyAuth,
          },
        });
        if (!reply?.success) {
          throw new Error(reply?.error || 'Passkey verification failed');
        }
        hideUnlockModal();
      } catch (err) {
        passkeyBtn.disabled = false;
        passkeyBtn.textContent = 'Unlock with Passkey';
        showUnlockError(err instanceof Error ? err.message : 'Passkey verification failed');
      }
    };
  }

  const submitPasswordUnlock = async () => {
    const pw = passwordInput.value;
    if (!pw) {
      showUnlockError('Please enter your password');
      return;
    }
    passwordBtn.disabled = true;
    try {
      const reply = await runtime.sendMessage({
        type: MSG.AUTHENTICATE,
        payload: { accountId: targetId, password: pw },
      });
      if (!reply?.success) {
        clearPasswordInput(passwordInput);
        showUnlockError(reply?.error || 'Invalid password');
        return;
      }
      hideUnlockModal();
    } catch (err) {
      clearPasswordInput(passwordInput);
      showUnlockError(err instanceof Error ? err.message : 'Invalid password');
    } finally {
      passwordBtn.disabled = false;
    }
  };

  passwordBtn.onclick = () => void submitPasswordUnlock();
  passwordInput.onkeydown = (e) => {
    if (e.key === 'Enter') void submitPasswordUnlock();
  };

  modal.classList.remove('hidden');
  if (slots.length === 0) {
    passwordInput.focus();
  }
}

/**
 * Setup mnemonic modal button handlers
 */
export function setupMnemonicModalHandlers(): void {
  elements.mnemonicToggleBtn.addEventListener('click', () => {
    const isBlurred = elements.mnemonicGrid.classList.contains('blurred');
    if (isBlurred) {
      elements.mnemonicGrid.classList.remove('blurred');
      elements.mnemonicToggleBtn.textContent = 'Hide Phrase';
    } else {
      elements.mnemonicGrid.classList.add('blurred');
      elements.mnemonicToggleBtn.textContent = 'Show Phrase';
    }
  });

  elements.mnemonicConfirmBtn.addEventListener('click', () => {
    hideMnemonicModal();
  });
}
