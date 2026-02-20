/**
 * Cached DOM element references for the popup
 * Uses lazy initialization to avoid querying DOM at import time.
 */

interface ElementCache {
  // Header
  settingsBtn: HTMLButtonElement;

  // Account selector
  accountDropdown: HTMLButtonElement;
  currentAccountName: HTMLSpanElement;
  accountMenu: HTMLDivElement;
  accountList: HTMLDivElement;
  addAccountBtn: HTMLButtonElement;

  // Network
  networkBadge: HTMLDivElement;

  // Balance
  balanceAmount: HTMLSpanElement;
  hideBalanceBtn: HTMLButtonElement;

  // Action buttons
  sendBtn: HTMLButtonElement;
  receiveBtn: HTMLButtonElement;

  // Tabs
  tabs: NodeListOf<HTMLButtonElement>;
  tabActivity: HTMLDivElement;
  tabContacts: HTMLDivElement;

  // Transaction list
  transactionList: HTMLDivElement;

  // Contact list
  contactSearch: HTMLInputElement;
  contactList: HTMLDivElement;
  addContactBtn: HTMLButtonElement;

  // Views
  viewSend: HTMLDivElement;
  viewSendConfirm: HTMLDivElement;
  viewReceive: HTMLDivElement;
  viewSettings: HTMLDivElement;
  viewAddAccount: HTMLDivElement;
  viewCreateAccount: HTMLDivElement;
  viewImportAccount: HTMLDivElement;
  viewAddContact: HTMLDivElement;
  viewOnboarding: HTMLDivElement;

  // Loading
  loading: HTMLDivElement;
  loadingMessage: HTMLSpanElement;

  // Toast
  toast: HTMLDivElement;

  // Connected sites
  connectedSitesList: HTMLDivElement;

  // Mnemonic modal
  mnemonicModal: HTMLDivElement;
  mnemonicGrid: HTMLDivElement;
  mnemonicModalTitle: HTMLHeadingElement;
  mnemonicToggleBtn: HTMLButtonElement;
  mnemonicCopyBtn: HTMLButtonElement;
  mnemonicConfirmBtn: HTMLButtonElement;
}

let _elements: ElementCache | null = null;

function getElements(): ElementCache {
  if (!_elements) {
    _elements = {
      // Header
      settingsBtn: document.getElementById('settings-btn') as HTMLButtonElement,

      // Account selector
      accountDropdown: document.getElementById('account-dropdown') as HTMLButtonElement,
      currentAccountName: document.getElementById('current-account-name') as HTMLSpanElement,
      accountMenu: document.getElementById('account-menu') as HTMLDivElement,
      accountList: document.getElementById('account-list') as HTMLDivElement,
      addAccountBtn: document.getElementById('add-account-btn') as HTMLButtonElement,

      // Network
      networkBadge: document.getElementById('network-badge') as HTMLDivElement,

      // Balance
      balanceAmount: document.getElementById('balance-amount') as HTMLSpanElement,
      hideBalanceBtn: document.getElementById('hide-balance-btn') as HTMLButtonElement,

      // Action buttons
      sendBtn: document.getElementById('send-btn') as HTMLButtonElement,
      receiveBtn: document.getElementById('receive-btn') as HTMLButtonElement,

      // Tabs
      tabs: document.querySelectorAll('.tab') as NodeListOf<HTMLButtonElement>,
      tabActivity: document.getElementById('tab-activity') as HTMLDivElement,
      tabContacts: document.getElementById('tab-contacts') as HTMLDivElement,

      // Transaction list
      transactionList: document.getElementById('transaction-list') as HTMLDivElement,

      // Contact list
      contactSearch: document.getElementById('contact-search') as HTMLInputElement,
      contactList: document.getElementById('contact-list') as HTMLDivElement,
      addContactBtn: document.getElementById('add-contact-btn') as HTMLButtonElement,

      // Views
      viewSend: document.getElementById('view-send') as HTMLDivElement,
      viewSendConfirm: document.getElementById('view-send-confirm') as HTMLDivElement,
      viewReceive: document.getElementById('view-receive') as HTMLDivElement,
      viewSettings: document.getElementById('view-settings') as HTMLDivElement,
      viewAddAccount: document.getElementById('view-add-account') as HTMLDivElement,
      viewCreateAccount: document.getElementById('view-create-account') as HTMLDivElement,
      viewImportAccount: document.getElementById('view-import-account') as HTMLDivElement,
      viewAddContact: document.getElementById('view-add-contact') as HTMLDivElement,
      viewOnboarding: document.getElementById('view-onboarding') as HTMLDivElement,

      // Loading
      loading: document.getElementById('loading') as HTMLDivElement,
      loadingMessage: document.getElementById('loading-message') as HTMLSpanElement,

      // Toast
      toast: document.getElementById('toast') as HTMLDivElement,

      // Connected sites
      connectedSitesList: document.getElementById('connected-sites-list') as HTMLDivElement,

      // Mnemonic modal
      mnemonicModal: document.getElementById('mnemonic-modal') as HTMLDivElement,
      mnemonicGrid: document.getElementById('mnemonic-grid') as HTMLDivElement,
      mnemonicModalTitle: document.getElementById('mnemonic-modal-title') as HTMLHeadingElement,
      mnemonicToggleBtn: document.getElementById('mnemonic-toggle-blur') as HTMLButtonElement,
      mnemonicCopyBtn: document.getElementById('mnemonic-copy-btn') as HTMLButtonElement,
      mnemonicConfirmBtn: document.getElementById('mnemonic-confirm-btn') as HTMLButtonElement,
    };
  }
  return _elements;
}

export const elements = new Proxy({} as ElementCache, {
  get(_target, prop: string | symbol) {
    return getElements()[prop as keyof ElementCache];
  },
});
