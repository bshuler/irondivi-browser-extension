/**
 * View switching, navigation, and loading state management
 */

import { elements } from './elements';

/**
 * Show a loading overlay with a message
 */
export function showLoading(message = 'Loading...'): void {
  elements.loadingMessage.textContent = message;
  elements.loading.classList.remove('hidden');
}

/**
 * Hide the loading overlay
 */
export function hideLoading(): void {
  elements.loading.classList.add('hidden');
}

/**
 * Show a toast notification
 */
export function showToast(message: string, type: 'success' | 'error' = 'success'): void {
  elements.toast.textContent = message;
  elements.toast.className = `toast ${type}`;
  elements.toast.classList.remove('hidden');

  setTimeout(() => {
    elements.toast.classList.add('hidden');
  }, 3000);
}

/**
 * Show a specific view, hiding the main content
 */
export function showView(viewElement: HTMLElement): void {
  // Hide all views
  document.querySelectorAll('.view').forEach(v => v.classList.add('hidden'));

  // Hide main content
  elements.accountDropdown.parentElement?.classList.add('hidden');
  elements.networkBadge.classList.add('hidden');
  elements.balanceAmount.parentElement?.parentElement?.classList.add('hidden');
  document.querySelector('.action-buttons')?.classList.add('hidden');
  document.querySelector('.tabs')?.classList.add('hidden');
  elements.tabActivity.classList.add('hidden');
  elements.tabContacts.classList.add('hidden');

  // Show the view
  viewElement.classList.remove('hidden');
}

/**
 * Hide all views and show the main content
 */
export function hideView(): void {
  // Hide all views
  document.querySelectorAll('.view').forEach(v => v.classList.add('hidden'));

  // Show main content
  elements.accountDropdown.parentElement?.classList.remove('hidden');
  elements.networkBadge.classList.remove('hidden');
  elements.balanceAmount.parentElement?.parentElement?.classList.remove('hidden');
  document.querySelector('.action-buttons')?.classList.remove('hidden');
  document.querySelector('.tabs')?.classList.remove('hidden');

  // Hide both tab contents first
  elements.tabActivity.classList.add('hidden');
  elements.tabActivity.classList.remove('active');
  elements.tabContacts.classList.add('hidden');
  elements.tabContacts.classList.remove('active');

  // Show active tab
  const activeTab = document.querySelector('.tab.active') as HTMLButtonElement;
  const tabName = activeTab?.dataset.tab;
  if (tabName === 'activity') {
    elements.tabActivity.classList.remove('hidden');
    elements.tabActivity.classList.add('active');
  } else if (tabName === 'contacts') {
    elements.tabContacts.classList.remove('hidden');
    elements.tabContacts.classList.add('active');
  }
}

/**
 * Format an address for display (truncated)
 */
export function formatAddress(address: string, length = 8): string {
  if (address.length <= length * 2) return address;
  return `${address.slice(0, length)}...${address.slice(-length)}`;
}

/**
 * Format an amount for display (remove trailing zeros)
 */
export function formatAmount(amount: number | string | undefined | null): string {
  const num = typeof amount === 'number' ? amount : parseFloat(String(amount)) || 0;
  return num.toFixed(8).replace(/\.?0+$/, '');
}

/**
 * Securely clear a password input field.
 * Overwrites with random data first, then clears, to reduce the window
 * during which the password value sits in the DOM.
 */
export function clearPasswordInput(input: HTMLInputElement): void {
  // Overwrite with random string first, then clear
  input.value = crypto.getRandomValues(new Uint8Array(32)).toString();
  input.value = '';
}
