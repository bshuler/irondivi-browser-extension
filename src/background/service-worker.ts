
import { runtime, alarms } from '../shared/browser-polyfill';
import { MSG, NETWORKS, DAPP_METHODS } from '../shared/constants';
import { getSettings, saveSettings, getSelectedAccountId, type Account, type AccountAddress } from '../shared/storage';
import { accountManager } from './account-manager';
import { signingSession } from './signing-session';
import { addressBook } from './address-book';
import { walletCore, type BuiltTransaction, type TransactionRequest } from './wallet-core';
import { rpcClient } from './rpc-client';
import { connectionManager } from './connection-manager';
import { secureWipe } from '../shared/crypto-utils';
import { isAllowedDappOrigin, isValidDappOrigin } from '../shared/origin';

const NOT_CONNECTED = { success: false, error: 'Site not connected. Please connect first.' };

// True only for the extension's own pages (action popup, approval window).
// A content script's messages carry our extension ID too, so the ID alone
// cannot tell a web page from the popup. sender.url can: for a content script
// it is the page's URL, for an extension page it is under our own base URL
// (chrome-extension://, moz-extension:// or safari-web-extension://).
// sender.tab cannot be used: the approval window is an extension page in a tab.
function isExtensionPage(sender: chrome.runtime.MessageSender): boolean {
  return sender.id === chrome.runtime.id &&
    typeof sender.url === 'string' &&
    sender.url.startsWith(runtime.getURL(''));
}

/**
 * Build (unsigned) a send from the account, enforcing the transaction limits.
 * Throws with a user-facing message if the send is not allowed.
 */
async function buildSend(account: Account, request: TransactionRequest): Promise<BuiltTransaction> {
  const addresses = account.addresses.map(a => a.address);
  const utxos = await rpcClient.getUtxos(addresses);

  // Enforce transaction limits
  const settings = await getSettings();
  const limits = settings.transactionLimits;
  const totalBalance = walletCore.calculateBalance(utxos);

  // Check absolute limit
  if (limits.maxAmountAbsolute > 0 && request.amount > limits.maxAmountAbsolute) {
    throw new Error(`Transaction exceeds maximum amount limit of ${limits.maxAmountAbsolute} DIVI`);
  }

  // Check percentage limit
  if (limits.maxAmountPercent > 0) {
    const maxAllowed = (totalBalance * limits.maxAmountPercent) / 100;
    if (request.amount > maxAllowed) {
      throw new Error(`Transaction exceeds ${limits.maxAmountPercent}% of balance (max: ${maxAllowed.toFixed(8)} DIVI)`);
    }
  }

  return walletCore.buildTransaction(utxos, account.addresses, {
    to: request.to,
    amount: request.amount,
    fee: request.fee,
    fromAddresses: request.fromAddresses,
  }, account.network);
}

/**
 * Build, sign with the unlocked session and broadcast a send.
 */
async function sendFromAccount(account: Account, request: TransactionRequest): Promise<{ txid: string; fee: number }> {
  const built = await buildSend(account, request);

  // Get seed from signing session
  const seed = await signingSession.getSeed();
  if (!seed) throw new Error('Not authenticated');

  try {
    // Derive private keys for inputs
    const coinType = NETWORKS[account.network].coinType;
    const { HDKey } = await import('../lib/hdkey');
    const hdkey = await HDKey.fromMasterSeed(seed);
    const privateKeys = await Promise.all(built.inputIndices.map(async index => {
      const path = `m/44'/${coinType}'/0'/0/${index}`;
      return (await hdkey.derive(path)).privateKey!;
    }));

    // Sign and broadcast
    const signedHex = await walletCore.signTransaction(built.hex, privateKeys);
    const txid = await rpcClient.broadcastTransaction(signedHex);
    return { txid, fee: built.fee };
  } finally {
    secureWipe(seed);
  }
}

/**
 * The account address a dApp asked for: by address, else by index, else the
 * first. Throws if the account does not own it.
 */
function resolveAddress(account: Account, address?: unknown, addressIndex?: unknown): AccountAddress {
  let found: AccountAddress | undefined;
  if (address !== undefined && address !== null && address !== '') {
    found = account.addresses.find(a => a.address === address);
  } else if (addressIndex !== undefined && addressIndex !== null) {
    found = account.addresses.find(a => a.index === addressIndex);
  } else {
    found = account.addresses[0];
  }
  if (!found) throw new Error('Address is not in this wallet');
  return found;
}

// Message handler type
interface Message {
  type: string;
  payload?: any;
}

interface MessageResponse {
  success: boolean;
  data?: unknown;
  error?: string;
}

/**
 * Handle messages from popup and content scripts
 */
async function handleMessage(
  message: Message,
  sender: chrome.runtime.MessageSender
): Promise<MessageResponse> {
  const { type, payload } = message;

  // Only our own pages may send anything but the dApp methods. Everything
  // else comes from a content script in a tab, i.e. from a web page.
  const fromExtensionPage = isExtensionPage(sender);
  if (!fromExtensionPage && (!sender.tab || !DAPP_METHODS.includes(type))) {
    return { success: false, error: 'Unauthorized sender' };
  }

  // Origin of the web page; empty for our own pages. A page must pass the
  // same origin rule the content script uses, for every message.
  let origin = '';
  if (!fromExtensionPage) {
    try {
      origin = sender.origin || new URL(sender.url || '').origin;
    } catch {
      return { success: false, error: 'Invalid sender URL' };
    }
    const { allowedSites } = await getSettings();
    if (!isAllowedDappOrigin(origin, allowedSites)) {
      return { success: false, error: 'Invalid origin' };
    }
  }

  // Connection messages only make sense for a web page
  if ([MSG.CONNECT, MSG.IS_CONNECTED, MSG.DISCONNECT].includes(type as any) && !origin) {
    return { success: false, error: 'Invalid origin' };
  }

  try {
    switch (type) {
      // ============ Account Operations ============
      case MSG.GET_ACCOUNTS: {
        const accountList = await accountManager.listAccounts();
        const currentAccountId = await getSelectedAccountId();
        return {
          success: true,
          data: {
            accounts: accountList,
            currentAccountId
          }
        };
      }

      case MSG.SELECT_ACCOUNT:
        await accountManager.selectAccount(payload.accountId);
        return { success: true };

      case MSG.GENERATE_MNEMONIC: {
        const { Mnemonic } = await import('../lib/mnemonic');
        const mnemonic = await Mnemonic.generate(
          payload?.wordCount || 12,
          payload?.language || 'english'
        );
        return { success: true, data: { mnemonic } };
      }

      case MSG.CREATE_ACCOUNT: {
        // Generate mnemonic
        const { Mnemonic } = await import('../lib/mnemonic');
        const mnemonic = await Mnemonic.generate(
          payload.wordCount || 12,
          payload.language || 'english'
        );

        // Import using generated mnemonic
        const newAccount = await accountManager.importAccount(
          payload.name,
          mnemonic,
          payload.password,
          payload.network
        );

        return { success: true, data: { account: newAccount, mnemonic } };
      }

      case MSG.IMPORT_ACCOUNT: {
        const imported = await accountManager.importAccount(
          payload.name,
          payload.mnemonic,
          payload.password,
          payload.network
        );
        return { success: true, data: { account: imported } };
      }

      case MSG.DELETE_ACCOUNT:
        await accountManager.deleteAccount(payload.accountId, payload.password);
        return { success: true };

      case MSG.RENAME_ACCOUNT:
        await accountManager.renameAccount(payload.accountId, payload.name);
        return { success: true };

      case MSG.EXPORT_MNEMONIC:
        const mnemonic = await accountManager.exportMnemonic(payload.accountId, payload.password);
        return { success: true, data: { mnemonic } };

      // ============ Wallet Operations ============
      case MSG.GET_BALANCE: {
        const account = await accountManager.getSelectedAccount();
        if (!account) return { success: false, error: 'No account selected' };
        if (origin && !(await connectionManager.isConnected(origin, account.id))) return NOT_CONNECTED;

        // One address if asked for (it must be ours), else the whole account
        const addresses = payload?.address
          ? [resolveAddress(account, payload.address).address]
          : account.addresses.map(a => a.address);
        const balance = await rpcClient.getBalance(addresses);
        return { success: true, data: { balance } };
      }

      case MSG.GET_ADDRESSES: {
        const account = await accountManager.getSelectedAccount();
        if (!account) return { success: false, error: 'No account selected' };
        if (origin && !(await connectionManager.isConnected(origin, account.id))) return NOT_CONNECTED;
        return { success: true, data: account.addresses };
      }

      case MSG.GET_TRANSACTIONS: {
        const account = await accountManager.getSelectedAccount();
        if (!account) return { success: false, error: 'No account selected' };

        const ourAddresses = account.addresses.map(a => a.address);
        const ourAddressSet = new Set(ourAddresses);
        const history = await rpcClient.getTransactionHistory(ourAddresses, payload?.limit || 50);

        // Map to UI Transaction format
        const transactions = history.map(tx => {
          // Find the "other" address (not ours) for display
          // For sends: show destination address
          // For receives: show sender address
          let displayAddress = '';
          if (tx.type === 'send') {
            // Find first address that isn't ours
            displayAddress = tx.addresses.find(a => !ourAddressSet.has(a)) || tx.addresses[0] || '';
          } else {
            // For receives, show the sender (vin address) - but we only have vout addresses here
            // So show the first address that isn't ours, or first address
            displayAddress = tx.addresses.find(a => !ourAddressSet.has(a)) || tx.addresses[0] || '';
          }

          return {
            txid: tx.txid,
            type: tx.type,
            amount: tx.amount,
            address: displayAddress,
            timestamp: tx.time * 1000, // Convert seconds to milliseconds
            confirmations: tx.confirmations,
          };
        });

        return { success: true, data: { transactions } };
      }

      case MSG.GENERATE_NEW_ADDRESS: {
        const newAddress = await accountManager.generateNewAddress(
          payload.accountId,
          payload.password
        );
        return { success: true, data: { address: newAddress } };
      }

      // ============ Signing Operations ============
      case MSG.AUTHENTICATE:
        const authenticated = await signingSession.authenticate(
          payload.accountId,
          payload.password
        );
        return { success: authenticated, error: authenticated ? undefined : 'Invalid password' };

      case MSG.SIGN_MESSAGE: {
        // From a dApp (has origin): needs a connection, then the user's approval
        if (origin) {
          const account = await accountManager.getSelectedAccount();
          if (!account) return { success: false, error: 'No account selected' };

          const isConnected = await connectionManager.isConnected(origin, account.id);
          if (!isConnected) return NOT_CONNECTED;

          // Sign with the address the site asked for, which must be ours
          const signer = resolveAddress(account, payload?.address, payload?.addressIndex);

          try {
            // Create signing request and wait for user approval
            const result = await connectionManager.createSigningRequest(
              'sign_message',
              origin,
              account.id,
              {
                message: payload.message,
                address: signer.address,
                addressIndex: signer.index,
              }
            );
            return { success: true, data: result };
          } catch (error) {
            return {
              success: false,
              error: error instanceof Error ? error.message : 'Signing rejected'
            };
          }
        }

        // From the popup (no origin), after AUTHENTICATE - sign directly
        const signature = await signingSession.signMessage(
          payload.message,
          payload.addressIndex,
          payload.network
        );
        return { success: true, data: { signature } };
      }

      case MSG.SEND_TRANSACTION: {
        const account = await accountManager.getSelectedAccount();
        if (!account) return { success: false, error: 'No account selected' };

        const request: TransactionRequest = {
          to: payload.to,
          amount: payload.amount,
          fee: payload.fee,
          fromAddresses: payload.fromAddresses,
        };

        // From a dApp (has origin): needs a connection, then the user's approval
        if (origin) {
          const isConnected = await connectionManager.isConnected(origin, account.id);
          if (!isConnected) return NOT_CONNECTED;

          const hasPermission = await connectionManager.hasPermission(origin, account.id, 'send_transaction');
          if (!hasPermission) {
            return { success: false, error: 'Site does not have send_transaction permission' };
          }

          // Check the send can be made before asking, and show the real fee
          const built = await buildSend(account, request);

          try {
            const result = await connectionManager.createSigningRequest(
              'send_transaction',
              origin,
              account.id,
              { ...request, fee: built.fee }
            );
            return { success: true, data: result };
          } catch (error) {
            return {
              success: false,
              error: error instanceof Error ? error.message : 'Transaction rejected'
            };
          }
        }

        // From the popup, after AUTHENTICATE
        const sent = await sendFromAccount(account, request);
        return { success: true, data: sent };
      }

      // ============ Address Book ============
      case MSG.GET_CONTACTS: {
        const contactList = await addressBook.listContacts(payload?.network);
        return { success: true, data: { contacts: contactList } };
      }

      case MSG.ADD_CONTACT:
        const contact = await addressBook.addContact(
          payload.name,
          payload.address,
          payload.network,
          payload.notes
        );
        return { success: true, data: contact };

      case MSG.UPDATE_CONTACT: {
        // Support both formats for backward compatibility
        const contactId = payload.contactId || payload.id;
        const updates = payload.updates || {
          name: payload.name,
          address: payload.address,
          notes: payload.notes,
        };
        const updated = await addressBook.updateContact(contactId, updates);
        return { success: true, data: updated };
      }

      case MSG.DELETE_CONTACT:
        await addressBook.deleteContact(payload.contactId);
        return { success: true };

      case MSG.GET_RECENT_CONTACTS: {
        const recentContacts = await addressBook.getRecentContacts(payload?.limit || 5);
        return { success: true, data: { contacts: recentContacts } };
      }

      case MSG.MARK_CONTACT_USED:
        await addressBook.markAsUsed(payload.contactId);
        return { success: true };

      case MSG.VALIDATE_ADDRESS: {
        const isValid = await rpcClient.validateAddress(payload.address);
        return { success: true, data: { isValid } };
      }

      // ============ Settings ============
      case MSG.GET_SETTINGS: {
        const currentSettings = await getSettings();
        return { success: true, data: { settings: currentSettings } };
      }

      case MSG.GET_NETWORK: {
        // The network the wallet is set to; all a dApp needs from the settings
        const { network } = await getSettings();
        return { success: true, data: { network } };
      }

      case MSG.UPDATE_SETTINGS:
        const currentSettings = await getSettings();
        const newSettings = { ...currentSettings, ...payload };
        await saveSettings(newSettings);

        // Update RPC client network if changed
        if (payload.network) {
          rpcClient.setNetwork(payload.network);
        }

        return { success: true, data: newSettings };

      // ============ dApp Connection ============
      case MSG.CONNECT: {
        const accountId = await getSelectedAccountId();
        if (!accountId) return { success: false, error: 'No account selected' };

        const isConnected = await connectionManager.isConnected(origin, accountId);
        if (isConnected) {
          const account = await accountManager.getSelectedAccount();
          return {
            success: true,
            data: {
              address: account?.addresses[0]?.address,
              connected: true
            }
          };
        }

        // Create connection request and wait for approval
        try {
          await connectionManager.requestConnection(origin, accountId);
          // Connection approved - return address
          const account = await accountManager.getSelectedAccount();
          return {
            success: true,
            data: {
              address: account?.addresses[0]?.address,
              connected: true
            }
          };
        } catch (error) {
          // Connection rejected or timed out
          return {
            success: false,
            error: error instanceof Error ? error.message : 'Connection rejected'
          };
        }
      }

      case MSG.IS_CONNECTED: {
        const accountId = await getSelectedAccountId();
        if (!accountId) return { success: true, data: { connected: false } };

        const connected = await connectionManager.isConnected(origin, accountId);
        return { success: true, data: { connected } };
      }

      case MSG.GET_CONNECTED_SITES: {
        const accountId = await getSelectedAccountId();
        if (!accountId) return { success: true, data: [] };

        const sites = await connectionManager.getConnectedSites(accountId);
        return { success: true, data: sites };
      }

      case MSG.REVOKE_SITE: {
        const accountId = await getSelectedAccountId();
        if (!accountId) return { success: false, error: 'No account selected' };

        await connectionManager.revokeConnection(payload.origin, accountId);
        return { success: true };
      }

      // ============ Faucet ============
      case MSG.REQUEST_FAUCET: {
        const account = await accountManager.getSelectedAccount();
        if (!account) return { success: false, error: 'No account selected' };

        const settings = await getSettings();
        const result = await rpcClient.requestFaucet(payload.address, settings.network);
        return { success: result.success, data: result };
      }

      // ============ Disconnect ============
      case MSG.DISCONNECT: {
        const accountId = await getSelectedAccountId();
        if (!accountId) return { success: true };

        await connectionManager.revokeConnection(origin, accountId);
        return { success: true };
      }

      // ============ Signing Request Approval ============
      case MSG.GET_PENDING_SIGNING_REQUESTS: {
        // Include all pending requests (connect, sign_message, send_transaction)
        const requests = connectionManager.getAllPendingRequests().map(r => ({
          id: r.id,
          type: r.type,
          origin: r.origin,
          accountId: r.accountId,
          data: r.data,
          createdAt: r.createdAt,
        }));
        return { success: true, data: { requests } };
      }

      case MSG.APPROVE_SIGNING_REQUEST: {
        const request = connectionManager.getPendingRequest(payload.requestId);
        if (!request) {
          return { success: false, error: 'Request not found' };
        }

        // Handle connection approval (no password needed)
        if (request.type === 'connect' || payload.isConnection) {
          try {
            await connectionManager.approveConnection(payload.requestId);
            return { success: true, data: { connected: true } };
          } catch (error) {
            return {
              success: false,
              error: error instanceof Error ? error.message : 'Failed to approve connection'
            };
          }
        }

        // Authenticate with provided password for signing requests
        const authSuccess = await signingSession.authenticate(
          request.accountId,
          payload.password
        );
        if (!authSuccess) {
          return { success: false, error: 'Invalid password' };
        }

        try {
          let result: { signature?: string; txid?: string; fee?: number } | undefined;

          if (!request.data) {
            return { success: false, error: 'Request data missing' };
          }

          // The site may have been disconnected while the popup was open
          const stillAllowed = await connectionManager.hasPermission(request.origin, request.accountId, request.type);
          if (!stillAllowed) {
            return { success: false, error: 'Site is no longer connected' };
          }

          const account = (await accountManager.listAccounts()).find(a => a.id === request.accountId);
          if (!account) {
            return { success: false, error: 'Account not found' };
          }

          if (request.type === 'sign_message') {
            if (!request.data.message) {
              return { success: false, error: 'Message is required for sign_message' };
            }
            const signature = await signingSession.signMessage(
              request.data.message,
              request.data.addressIndex || 0,
              account.network
            );
            result = { signature };
          } else if (request.type === 'send_transaction') {
            if (!request.data.to || request.data.amount === undefined) {
              return { success: false, error: 'to and amount are required for send_transaction' };
            }
            result = await sendFromAccount(account, {
              to: request.data.to,
              amount: request.data.amount,
              fee: request.data.fee,
              fromAddresses: request.data.fromAddresses,
            });
          }

          // Approve the request with the result
          connectionManager.approveRequest(payload.requestId, result);
          return { success: true, data: result };
        } catch (error) {
          return {
            success: false,
            error: error instanceof Error ? error.message : 'Failed to process request'
          };
        }
      }

      case MSG.REJECT_SIGNING_REQUEST: {
        try {
          connectionManager.rejectRequest(payload.requestId);
          return { success: true };
        } catch (error) {
          return {
            success: false,
            error: error instanceof Error ? error.message : 'Failed to reject request'
          };
        }
      }

      default:
        return { success: false, error: `Unknown message type: ${type}` };
    }
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error'
    };
  }
}

// Set up message listener
runtime.onMessage.addListener((message: Message, sender: chrome.runtime.MessageSender, sendResponse: (response: MessageResponse) => void) => {
  handleMessage(message, sender)
    .then(sendResponse)
    .catch(err => sendResponse({ success: false, error: err.message }));
  return true; // Keep channel open for async response
});

// Set up alarm listener for signing session timeout
alarms.onAlarm.addListener(async (alarm: chrome.alarms.Alarm) => {
  if (alarm.name === 'signing-session-timeout') {
    await signingSession.handleAlarmTimeout();
  }
});

// Programmatic content script injection for better compatibility
// Uses webNavigation.onCommitted which fires reliably when page navigation is committed
chrome.webNavigation.onCommitted.addListener(async (details) => {
  // Only inject for main frame (not iframes)
  if (details.frameId !== 0) return;

  // Only inject on pages the wallet serves at all
  try {
    if (!isValidDappOrigin(new URL(details.url).origin)) return;
  } catch {
    return;
  }

  try {
    // Inject content script programmatically
    await chrome.scripting.executeScript({
      target: { tabId: details.tabId },
      files: ['content-script.js'],
      injectImmediately: true,
    });
  } catch (error) {
    // Ignore errors for pages where we can't inject (chrome://, etc.)
  }
});

// Also inject when tab is activated (for already-loaded tabs)
chrome.tabs.onActivated.addListener(async (activeInfo) => {
  try {
    const tab = await chrome.tabs.get(activeInfo.tabId);
    if (!tab.url) return;

    if (!isValidDappOrigin(new URL(tab.url).origin)) return;

    // Check if provider is already injected
    const results = await chrome.scripting.executeScript({
      target: { tabId: activeInfo.tabId },
      func: () => !!(window as any).irondivi,
    });

    if (results && results[0] && !results[0].result) {
      // Provider not injected, inject now
      await chrome.scripting.executeScript({
        target: { tabId: activeInfo.tabId },
        files: ['content-script.js'],
        injectImmediately: true,
      });
    }
  } catch (error) {
    // Ignore errors
  }
});

// Initialize on startup
async function initialize() {
  const settings = await getSettings();
  rpcClient.setNetwork(settings.network);

  // Register content scripts programmatically for better compatibility
  // This ensures content scripts are registered even if declarative ones don't work
  try {
    // First, unregister any existing scripts to avoid duplicates
    await chrome.scripting.unregisterContentScripts({ ids: ['irondivi-provider'] }).catch(() => {});

    // Register the content script
    await chrome.scripting.registerContentScripts([{
      id: 'irondivi-provider',
      matches: ['<all_urls>'],
      js: ['content-script.js'],
      runAt: 'document_start',
      allFrames: false,
    }]);
  } catch {
    // Content script registration failed - manifest declaration is the fallback
  }
}

initialize();
