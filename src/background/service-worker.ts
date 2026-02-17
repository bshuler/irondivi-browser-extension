import { runtime, alarms } from '../shared/browser-polyfill';
import { MSG } from '../shared/constants';
import { getSettings, saveSettings, getSelectedAccountId } from '../shared/storage';
import { accountManager } from './account-manager';
import { signingSession } from './signing-session';
import { addressBook } from './address-book';
import { walletCore } from './wallet-core';
import { rpcClient } from './rpc-client';
import { connectionManager } from './connection-manager';
import { secureWipe } from '../shared/crypto-utils';

// Origin validation helper
function isValidOrigin(origin: string): boolean {
  try {
    const url = new URL(origin);
    // Only allow https (or http for localhost development)
    if (url.protocol !== 'https:' &&
        !(url.protocol === 'http:' && url.hostname === 'localhost')) {
      return false;
    }
    return true;
  } catch {
    return false;
  }
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

  // Extract origin properly from sender
  let origin = '';
  if (sender.origin) {
    origin = sender.origin;
  } else if (sender.url) {
    try {
      origin = new URL(sender.url).origin;
    } catch {
      return { success: false, error: 'Invalid sender URL' };
    }
  }

  // For dApp connection messages, require valid origin
  if ([MSG.CONNECT, MSG.IS_CONNECTED, MSG.DISCONNECT].includes(type as any)) {
    if (!origin || !isValidOrigin(origin)) {
      return { success: false, error: 'Invalid origin' };
    }
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

        const addresses = account.addresses.map(a => a.address);
        const balance = await rpcClient.getBalance(addresses);
        return { success: true, data: { balance } };
      }

      case MSG.GET_ADDRESSES: {
        const account = await accountManager.getSelectedAccount();
        if (!account) return { success: false, error: 'No account selected' };
        return { success: true, data: account.addresses };
      }

      case MSG.GET_TRANSACTIONS: {
        const account = await accountManager.getSelectedAccount();
        if (!account) return { success: false, error: 'No account selected' };

        const addresses = account.addresses.map(a => a.address);
        const history = await rpcClient.getTransactionHistory(addresses, payload?.limit || 50);
        return { success: true, data: { transactions: history } };
      }

      // ============ Signing Operations ============
      case MSG.AUTHENTICATE:
        const authenticated = await signingSession.authenticate(
          payload.accountId,
          payload.password
        );
        return { success: authenticated, error: authenticated ? undefined : 'Invalid password' };

      case MSG.SIGN_MESSAGE: {
        // If called from a dApp (has origin), verify permission
        if (origin && isValidOrigin(origin)) {
          const accountId = await getSelectedAccountId();
          if (!accountId) return { success: false, error: 'No account selected' };

          const isConnected = await connectionManager.isConnected(origin, accountId);
          if (!isConnected) {
            return { success: false, error: 'Site not connected. Please connect first.' };
          }

          const hasPermission = await connectionManager.hasPermission(origin, accountId, 'sign_message');
          if (!hasPermission) {
            return { success: false, error: 'Site does not have sign_message permission' };
          }
        }

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

        // If called from a dApp (has origin), verify permission
        if (origin && isValidOrigin(origin)) {
          const accountId = await getSelectedAccountId();
          if (!accountId) return { success: false, error: 'No account selected' };

          const isConnected = await connectionManager.isConnected(origin, accountId);
          if (!isConnected) {
            return { success: false, error: 'Site not connected. Please connect first.' };
          }

          const hasPermission = await connectionManager.hasPermission(origin, accountId, 'send_transaction');
          if (!hasPermission) {
            return { success: false, error: 'Site does not have send_transaction permission' };
          }
        }

        // Get UTXOs
        const addresses = account.addresses.map(a => a.address);
        const utxos = await rpcClient.getUtxos(addresses);

        // Build transaction
        const built = walletCore.buildTransaction(utxos, account.addresses, {
          to: payload.to,
          amount: payload.amount,
          fee: payload.fee,
        }, account.network);

        // Get seed from signing session
        const seed = await signingSession.getSeed();
        if (!seed) return { success: false, error: 'Not authenticated' };

        try {
          // Derive private keys for inputs
          const coinType = account.network === 'mainnet' ? 301 : 1;
          const { HDKey } = await import('../lib/hdkey');
          const hdkey = await HDKey.fromMasterSeed(seed);
          const privateKeys = await Promise.all(built.inputIndices.map(async index => {
            const path = `m/44'/${coinType}'/0'/0/${index}`;
            return (await hdkey.derive(path)).privateKey!;
          }));

          // Sign and broadcast
          const signedHex = await walletCore.signTransaction(built.hex, privateKeys);
          const txid = await rpcClient.broadcastTransaction(signedHex);

          return { success: true, data: { txid, fee: built.fee } };
        } finally {
          secureWipe(seed);
        }
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

        // Create connection request (will open popup)
        await connectionManager.requestConnection(origin, accountId);
        return { success: true, data: { pending: true } };
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
        const requests = connectionManager.getPendingSigningRequests();
        return { success: true, data: { requests } };
      }

      case MSG.APPROVE_SIGNING_REQUEST: {
        const request = connectionManager.getPendingRequest(payload.requestId);
        if (!request) {
          return { success: false, error: 'Request not found' };
        }

        // Authenticate with provided password
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

          if (request.type === 'sign_message') {
            // Sign the message
            const account = await accountManager.getSelectedAccount();
            if (!account) {
              return { success: false, error: 'No account selected' };
            }
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
            // Build and send transaction
            const account = await accountManager.getSelectedAccount();
            if (!account) {
              return { success: false, error: 'No account selected' };
            }
            if (!request.data.to || request.data.amount === undefined) {
              return { success: false, error: 'to and amount are required for send_transaction' };
            }

            const addresses = account.addresses.map(a => a.address);
            const utxos = await rpcClient.getUtxos(addresses);

            const built = walletCore.buildTransaction(utxos, account.addresses, {
              to: request.data.to,
              amount: request.data.amount,
              fee: request.data.fee,
            }, account.network);

            const seed = await signingSession.getSeed();
            if (!seed) {
              return { success: false, error: 'Not authenticated' };
            }

            try {
              const coinType = account.network === 'mainnet' ? 301 : 1;
              const { HDKey } = await import('../lib/hdkey');
              const hdkey = await HDKey.fromMasterSeed(seed);
              const privateKeys = await Promise.all(built.inputIndices.map(async index => {
                const path = `m/44'/${coinType}'/0'/0/${index}`;
                return (await hdkey.derive(path)).privateKey!;
              }));

              const signedHex = await walletCore.signTransaction(built.hex, privateKeys);
              const txid = await rpcClient.broadcastTransaction(signedHex);

              result = { txid, fee: built.fee };
            } finally {
              secureWipe(seed);
            }
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
    console.error('Message handler error');
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

// Initialize on startup
async function initialize() {
  const settings = await getSettings();
  rpcClient.setNetwork(settings.network);
  console.log('PrivateDivi Wallet initialized');
}

initialize();
