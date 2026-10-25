/**
 * Modal management - password, confirmation, mnemonic display
 */

import { elements } from './elements';
import { state } from './state';
import { clearPasswordInput } from './ui-state';

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
 * Show a password input modal (replaces browser prompt())
 */
export function showPasswordModal(title: string): Promise<string | null> {
  return new Promise(resolve => {
    const modal = document.getElementById('password-modal') as HTMLDivElement;
    const titleEl = document.getElementById('password-modal-title') as HTMLHeadingElement;
    const input = document.getElementById('password-modal-input') as HTMLInputElement;
    const cancelBtn = document.getElementById('password-modal-cancel') as HTMLButtonElement;
    const submitBtn = document.getElementById('password-modal-submit') as HTMLButtonElement;

    titleEl.textContent = title;
    input.value = '';
    modal.classList.remove('hidden');
    input.focus();

    const cleanup = () => {
      modal.classList.add('hidden');
      clearPasswordInput(input);
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
