/**
 * Centralized state management for the popup
 */

import { Account, Transaction, Contact, Settings, PendingSendTx } from './types';

/**
 * PopupState holds all mutable state for the popup UI.
 * Using a class allows modules to share state by reference.
 */
class PopupState {
  currentAccount: Account | null = null;
  accounts: Account[] = [];
  transactions: Transaction[] = [];
  contacts: Contact[] = [];
  settings: Settings = {
    network: 'testnet',
    authTimeoutMinutes: 5,
    currency: 'USD',
    hideBalance: false,
  };
  balance: number = 0;
  balanceHidden: boolean = false;

  // Contact edit state
  editingContactId: string | null = null;

  // Send transaction state
  pendingSendTx: PendingSendTx | null = null;

  // Mnemonic modal resolver
  mnemonicModalResolver: (() => void) | null = null;
}

// Singleton instance
export const state = new PopupState();
