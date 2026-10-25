
import { runtime, alarms, idle, browserAPI } from '../shared/browser-polyfill';
import { MSG, NETWORKS, DAPP_METHODS, UI_PORT, type NetworkType } from '../shared/constants';
import { getSettings, saveSettings, getAccounts, getSelectedAccountId, type Account, type AccountAddress } from '../shared/storage';
import { accountManager } from './account-manager';
import { signingSession } from './signing-session';
import { addressBook } from './address-book';
import { walletCore, diviToSatoshis, satoshisToDivi, p2pkhScript, type BuiltTransaction, type TransactionRequest } from './wallet-core';
import { Transaction, bytesToHex } from '../lib/transaction';
import { recordSpend, spentToday } from './spend-ledger';
import { highWaterBalance, recordBalance } from './balance-record';
import { rpcClient } from './rpc-client';
import { addPendingTx, getPendingTxids, prunePendingTxs } from './pending-txs';
import { connectionManager, type PendingRequest } from './connection-manager';
import { secureWipe } from '../shared/crypto-utils';
import { isAllowedDappOrigin } from '../shared/origin';
import { checkGameTx, checkMessageShape, checkMessageToSign, gameTxid } from './sign-policy';
import { checkSettingsUpdate } from '../shared/settings-check';
import { syncSiteScripts } from './site-scripts';
import { checkRecipient, recipientNote } from '../popup/recipient-check';
import { installRecordsSeal, getRecordsWarning, dismissRecordsWarning } from './records-seal';

// Every write of the unencrypted records goes through the seal (EXT-3)
installRecordsSeal();

const NOT_CONNECTED = { success: false, error: 'Site not connected. Please connect first.' };
const PASSWORD_NEEDED = { success: false, error: 'Enter your password to confirm' };
// What a site is told when a payment it asks for cannot be made
const CANNOT_PAY = 'The wallet cannot make this payment';

/**
 * Unlock with the password given for one send or signature from the popup.
 * The signing session stays open for the auto-lock time, but nothing that
 * moves funds or signs uses it without the password (EXT-2).
 */
async function authenticateAction(accountId: string, password: unknown): Promise<boolean> {
  if (typeof password !== 'string' || !password) return false;
  return signingSession.authenticate(accountId, password);
}

// A wallet made by 0.0.1 on one network has no addresses on the other until
// its owner unlocks it there once.
function noAddressesOn(account: Account) {
  const name = NETWORKS[account.network].name;
  return {
    success: false,
    error: `This wallet has no ${name} address yet. Open IronDivi Wallet and unlock it once on ${name}.`,
  };
}

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

// A percentage as basis points, so limits compare in whole satoshis
function basisPoints(percent: number): bigint {
  return BigInt(Math.round(Math.min(100, Math.max(0, percent)) * 100));
}

function diviText(sats: bigint): string {
  return satoshisToDivi(sats).toFixed(8).replace(/\.?0+$/, '');
}

/**
 * Build (unsigned) a send from the account, enforcing the transaction limits
 * on what leaves the wallet: the amount plus the fee.
 * Throws with a user-facing message if the send is not allowed.
 */
async function buildSend(account: Account, request: TransactionRequest): Promise<BuiltTransaction & { balanceSats: bigint }> {
  const addresses = account.addresses.map(a => a.address);
  const utxos = await rpcClient.getUtxos(addresses);

  const built = walletCore.buildTransaction(utxos, account.addresses, {
    to: request.to,
    amount: request.amount,
    fee: request.fee,
    fromAddresses: request.fromAddresses,
  }, account.network);

  const limits = (await getSettings()).transactionLimits;
  const spend = built.amountSats + built.feeSats;
  // Percentages are of the larger of what the node reports now and the most
  // the wallet has seen this week, so a node that hides coins cannot block
  // sends. One that invents coins cannot spend them (sendFromAccount checks
  // the previous transactions) but does loosen the percentages; the absolute
  // limits are the control for that.
  const reported = utxos.reduce((sum, u) => sum + u.satoshis, 0n);
  await recordBalance(account.id, account.network, reported);
  const seen = await highWaterBalance(account.id, account.network);
  const balance = seen > reported ? seen : reported;

  if (limits.maxAmountAbsolute > 0 && spend > diviToSatoshis(limits.maxAmountAbsolute)) {
    throw new Error(`Transaction exceeds maximum amount limit of ${limits.maxAmountAbsolute} DIVI (amount plus fee)`);
  }
  if (limits.maxAmountPercent > 0) {
    const bp = basisPoints(limits.maxAmountPercent);
    if (spend * 10000n > balance * bp) {
      throw new Error(`Transaction exceeds ${limits.maxAmountPercent}% of balance (max: ${diviText(balance * bp / 10000n)} DIVI including the fee)`);
    }
  }

  if (limits.dailyLimitAbsolute > 0 || limits.dailyLimitPercent > 0) {
    const spent = await spentToday(account.id, account.network);
    if (limits.dailyLimitAbsolute > 0 && spent + spend > diviToSatoshis(limits.dailyLimitAbsolute)) {
      throw new Error(`Transaction exceeds the daily limit of ${limits.dailyLimitAbsolute} DIVI (sent in the last 24 hours: ${diviText(spent)} DIVI)`);
    }
    if (limits.dailyLimitPercent > 0) {
      // The balance 24 hours ago is roughly today's plus what was sent since
      const bp = basisPoints(limits.dailyLimitPercent);
      if ((spent + spend) * 10000n > (balance + spent) * bp) {
        throw new Error(`Transaction exceeds the daily limit of ${limits.dailyLimitPercent}% of balance`);
      }
    }
  }

  return { ...built, balanceSats: reported };
}

/**
 * Which account a request pays or signs from, and for a payment what the
 * popup's own send screen says about the recipient (EXT-8)
 */
async function requestContext(request: PendingRequest, network: NetworkType, accounts: Account[]) {
  const account = accounts.find(a => a.id === request.accountId);
  const own = (a: Account) => (a.networks?.[network]?.addresses ?? (a.network === network ? a.addresses : []));
  const addresses = account ? own(account) : [];
  const from = account ? {
    name: account.name,
    address: request.data?.address ?? addresses[0]?.address ?? '',
    addressCount: addresses.length,
  } : undefined;
  if (request.type !== 'send_transaction' || typeof request.data?.to !== 'string') return { from };
  const contacts = await addressBook.listContacts(network);
  const check = checkRecipient(request.data.to, contacts, accounts.flatMap(a => own(a).map(x => x.address)));
  return { from, recipient: recipientNote(check) };
}

/**
 * Approve a pending site request from the approval window. The caller has
 * claimed it, so no other approval of it runs at the same time.
 */
async function approveSigningRequest(request: PendingRequest, payload: any): Promise<{ success: boolean; data?: unknown; error?: string }> {
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
    let result: { signature?: string; address?: string; txid?: string; fee?: number } | undefined;

    if (!request.data) {
      return { success: false, error: 'Request data missing' };
    }

    // Sign on the network the site asked on, and only while it is still
    // the wallet's network, so the site gets what it asked for
    const network = (await getSettings()).network;
    if (request.data.network && request.data.network !== network) {
      return { success: false, error: 'The wallet changed network since this request. Ask the site again.' };
    }

    // The site may have been disconnected while the popup was open
    const stillAllowed = await connectionManager.isConnected(request.origin, request.accountId, network);
    if (!stillAllowed) {
      return { success: false, error: 'Site is no longer connected' };
    }
    const account = await accountManager.getAccount(request.accountId, network);
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
        account.network,
        request.accountId
      );
      result = { signature };
    } else if (request.type === 'sign_game_tx') {
      // Checked again against the account as it is now
      const body = request.data.message;
      const { tx } = checkGameTx(body, request.origin, account.network, account.addresses.map(a => a.address));
      const signer = resolveAddress(account, tx.from);
      const signature = await signingSession.signMessage(body!, signer.index, account.network, request.accountId);
      result = { signature, address: signer.address, txid: gameTxid(body!) };
    } else if (request.type === 'send_transaction') {
      if (!request.data.to || request.data.amount === undefined) {
        return { success: false, error: 'to and amount are required for send_transaction' };
      }
      // Rebuilt now, as the coins may have changed since the owner was
      // asked; it must not cost more than the fee they were shown
      if (typeof request.data.fee !== 'number' || !Number.isFinite(request.data.fee)) {
        return { success: false, error: 'Request fee missing' };
      }
      result = await sendFromAccount(account, {
        to: request.data.to,
        amount: request.data.amount,
        fromAddresses: request.data.fromAddresses,
      }, diviToSatoshis(request.data.fee));
    }

    // Approve the request with the result; the site has now been
    // allowed this kind of request
    await connectionManager.grantPermission(request.origin, request.accountId, request.type);
    connectionManager.approveRequest(payload.requestId, result);
    return { success: true, data: result };
  } catch (error) {
    if (error instanceof FeeRoseError) {
      // Tell the site at once, so it can ask again with the new fee
      connectionManager.rejectRequest(payload.requestId, error.message);
    }
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Failed to process request'
    };
  }

}

/**
 * Check each coin a send spends against the transaction that made it: the
 * node's word for the amount is not enough, because the signature does not
 * cover input amounts and a node that overstated one would turn the
 * difference into fee. The transaction is fetched raw and must hash to the
 * txid being spent.
 */
async function verifyInputs(built: BuiltTransaction): Promise<void> {
  const byTxid = new Map<string, Transaction>();
  for (const input of built.inputs) {
    let prev = byTxid.get(input.txid);
    if (!prev) {
      prev = Transaction.fromHex(await rpcClient.getRawTransactionHex(input.txid));
      if (prev.txid() !== input.txid) {
        throw new Error('Node returned a different transaction than the coin being spent');
      }
      byTxid.set(input.txid, prev);
    }
    const output = prev.outputs[input.vout];
    if (!output || output.value !== input.satoshis ||
        bytesToHex(output.script as Uint8Array) !== p2pkhScript(input.address)) {
      throw new Error('A coin the node reported does not match the transaction that made it');
    }
  }
}

/**
 * Build, check, sign with the unlocked session and broadcast a send.
 * maxFeeSats: refuse if the fee is now above this (the fee the owner was shown).
 */
// Asking again cannot help: the same coins give the same higher fee
class FeeRoseError extends Error {
  constructor() {
    super('The fee went up since you were asked (the wallet\'s coins changed). Ask the site to send again.');
  }
}

async function sendFromAccount(
  account: Account,
  request: TransactionRequest,
  maxFeeSats?: bigint
): Promise<{ txid: string; fee: number }> {
  const built = await buildSend(account, request);
  if (maxFeeSats !== undefined && built.feeSats > maxFeeSats) {
    throw new FeeRoseError();
  }
  await verifyInputs(built);

  // Get seed from signing session
  const seed = await signingSession.getSeed();
  if (!seed) throw new Error('Not authenticated');

  const privateKeys: Uint8Array[] = [];
  // Every key made here, master first, so all of them are wiped afterwards
  const keys: Array<{ wipe(): void }> = [];
  try {
    // Derive private keys for inputs
    const coinType = NETWORKS[account.network].coinType;
    const { HDKey } = await import('../lib/hdkey');
    const hdkey = await HDKey.fromMasterSeed(seed);
    keys.push(hdkey);
    for (const index of built.inputIndices) {
      const path = `m/44'/${coinType}'/0'/0/${index}`;
      const derived = await hdkey.derive(path);
      keys.push(derived);
      privateKeys.push(derived.privateKey!);
    }

    // Sign what the owner asked for, and only that, then broadcast
    const signedHex = await walletCore.signTransaction(built, privateKeys, {
      to: request.to,
      amountSats: diviToSatoshis(request.amount),
      ownAddresses: account.addresses.map(a => a.address),
      network: account.network,
    });
    const txid = await rpcClient.broadcastTransaction(signedHex);
    await recordSpend(account.id, account.network, built.amountSats + built.feeSats);
    await addPendingTx(account.network, txid);
    return { txid, fee: built.fee };
  } finally {
    secureWipe(seed);
    privateKeys.forEach(key => key && secureWipe(key));
    keys.forEach(key => key.wipe());
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

  // The content script asks whether its own page may use the wallet before it
  // injects window.irondivi. The answer is about the sender's origin only.
  if (!fromExtensionPage && sender.tab && type === MSG.SITE_ALLOWED) {
    try {
      const pageOrigin = sender.origin || new URL(sender.url || '').origin;
      const { allowedSites } = await getSettings();
      return { success: true, data: { allowed: isAllowedDappOrigin(pageOrigin, allowedSites) } };
    } catch {
      return { success: true, data: { allowed: false } };
    }
  }

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

      case MSG.ADD_NETWORK_ADDRESSES: {
        const account = await accountManager.setUpNetwork(payload.accountId, payload.password);
        return { success: true, data: { account } };
      }

      case MSG.EXPORT_MNEMONIC:
        const mnemonic = await accountManager.exportMnemonic(payload.accountId, payload.password);
        return { success: true, data: { mnemonic } };

      // ============ Wallet Operations ============
      case MSG.GET_BALANCE: {
        const account = await accountManager.getSelectedAccount();
        if (!account) return { success: false, error: 'No account selected' };
        if (origin && !(await connectionManager.isConnected(origin, account.id, account.network))) return NOT_CONNECTED;

        // One address if asked for (it must be ours), else the whole account
        const addresses = payload?.address
          ? [resolveAddress(account, payload.address).address]
          : account.addresses.map(a => a.address);
        const balance = await rpcClient.getBalance(addresses);
        if (!payload?.address && Number.isFinite(balance) && balance > 0) {
          await recordBalance(account.id, account.network, diviToSatoshis(balance));
        }
        return { success: true, data: { balance } };
      }

      case MSG.GET_ADDRESSES: {
        const account = await accountManager.getSelectedAccount();
        if (!account) return { success: false, error: 'No account selected' };
        if (origin && !(await connectionManager.isConnected(origin, account.id, account.network))) return NOT_CONNECTED;
        return { success: true, data: account.addresses };
      }

      case MSG.GET_TRANSACTIONS: {
        const account = await accountManager.getSelectedAccount();
        if (!account) return { success: false, error: 'No account selected' };

        const ourAddresses = account.addresses.map(a => a.address);
        const ourAddressSet = new Set(ourAddresses);
        const pendingTxids = await getPendingTxids(account.network);
        const history = await rpcClient.getTransactionHistory(ourAddresses, payload?.limit || 50, pendingTxids);
        await prunePendingTxs(account.network, new Set(history.filter(tx => tx.confirmations > 0).map(tx => tx.txid)));

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

          const isConnected = await connectionManager.isConnected(origin, account.id, account.network);
          if (!isConnected) return NOT_CONNECTED;
          if (account.addresses.length === 0) return noAddressesOn(account);

          // Sign with the address the site asked for, which must be ours
          const signer = resolveAddress(account, payload?.address, payload?.addressIndex);

          try {
            // A game transaction is refused here; a session grant comes only
            // from the games site and is shown as one
            const { session } = checkMessageToSign(payload?.message, origin, account.network);
            // Create signing request and wait for user approval
            const result = await connectionManager.createSigningRequest(
              'sign_message',
              origin,
              account.id,
              {
                message: payload.message,
                address: signer.address,
                addressIndex: signer.index,
                network: account.network,
                session,
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

        // From the popup (no origin). The popup names the account, and the
        // address and network come from that account. Every signature needs
        // the password, so an open session alone signs nothing
        const account = typeof payload?.accountId === 'string'
          ? await accountManager.getAccount(payload.accountId)
          : null;
        if (!account) return { success: false, error: 'Name the account to sign with' };
        if (!(await authenticateAction(account.id, payload?.password))) return PASSWORD_NEEDED;
        if (account.addresses.length === 0) return noAddressesOn(account);
        try {
          checkMessageShape(payload.message);
        } catch (error) {
          return { success: false, error: (error as Error).message };
        }
        const signer = resolveAddress(account, payload.address, payload.addressIndex);
        const signature = await signingSession.signMessage(payload.message, signer.index, account.network, account.id);
        return { success: true, data: { signature, address: signer.address } };
      }

      case MSG.SIGN_GAME_TX: {
        // Only a site, and only the Divi Games site: the popup has no use for it
        if (!origin) return { success: false, error: 'Game transactions come from the Divi Games site' };
        const account = await accountManager.getSelectedAccount();
        if (!account) return { success: false, error: 'No account selected' };
        if (!(await connectionManager.isConnected(origin, account.id, account.network))) return NOT_CONNECTED;
        if (account.addresses.length === 0) return noAddressesOn(account);

        try {
          const { tx, summary } = checkGameTx(
            payload?.body, origin, account.network, account.addresses.map(a => a.address));
          const signer = resolveAddress(account, tx.from);
          const result = await connectionManager.createSigningRequest(
            'sign_game_tx',
            origin,
            account.id,
            {
              message: payload.body,
              address: signer.address,
              addressIndex: signer.index,
              network: account.network,
              gameTx: summary,
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

      case MSG.SEND_TRANSACTION: {
        const account = await accountManager.getSelectedAccount();
        if (!account) return { success: false, error: 'No account selected' };
        if (account.addresses.length === 0) return noAddressesOn(account);

        const request: TransactionRequest = {
          to: payload.to,
          amount: payload.amount,
          // Only the owner, in the popup, may choose the fee; a site's is ignored
          fee: origin ? undefined : payload.fee,
          fromAddresses: payload.fromAddresses,
        };

        // From a dApp (has origin): needs a connection, then the user's approval
        if (origin) {
          const isConnected = await connectionManager.isConnected(origin, account.id, account.network);
          if (!isConnected) return NOT_CONNECTED;

          // Check the send can be made before asking, and show the real fee.
          // Why it cannot be made (the balance, the limits, which coins) is
          // the owner's to know, not the site's
          walletCore.checkRequest(request, account.network);
          let built: Awaited<ReturnType<typeof buildSend>>;
          try {
            built = await buildSend(account, request);
          } catch {
            return { success: false, error: CANNOT_PAY };
          }

          try {
            const result = await connectionManager.createSigningRequest(
              'send_transaction',
              origin,
              account.id,
              // What the approval window shows besides the request: the real
              // fee and what the account holds after it (EXT-8)
              {
                ...request,
                fee: built.fee,
                network: account.network,
                balanceAfter: diviText(built.balanceSats - built.amountSats - built.feeSats),
              }
            );
            return { success: true, data: result };
          } catch (error) {
            return {
              success: false,
              error: error instanceof Error ? error.message : 'Transaction rejected'
            };
          }
        }

        // From the popup: every send needs the password, so an open session
        // alone sends nothing
        if (!(await authenticateAction(account.id, payload?.password))) return PASSWORD_NEEDED;
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

      case MSG.GET_RECORDS_WARNING:
        return { success: true, data: { warning: await getRecordsWarning() } };

      case MSG.DISMISS_RECORDS_WARNING:
        await dismissRecordsWarning();
        return { success: true };

      case MSG.GET_NETWORK: {
        // The network the wallet is set to; all a dApp needs from the settings
        const { network } = await getSettings();
        return { success: true, data: { network } };
      }

      case MSG.UPDATE_SETTINGS: {
        // The password is only a check; never saved
        const { password, ...raw } = payload ?? {};
        const currentSettings = await getSettings();
        const checked = checkSettingsUpdate(raw, currentSettings);
        if (!checked.ok) return { success: false, error: checked.error };
        const { updates } = checked;
        const switching = !!updates.network && updates.network !== currentSettings.network;
        // Moving a wallet between Mainnet and Testnet, or loosening a
        // protection, needs its password; before there is a wallet there is
        // nothing to protect
        const accounts = switching || checked.loosens ? await getAccounts() : [];
        const accountId = accounts.length > 0 ? (await getSelectedAccountId()) ?? accounts[0].id : null;
        if (accountId) {
          if (typeof password !== 'string' || !password) {
            return { success: false, error: switching ? 'Enter your password to switch network' : 'Enter your password to change this setting' };
          }
          if (!(await signingSession.verifyPassword(accountId, password))) {
            return { success: false, error: 'Invalid password' };
          }
        }

        // Checking the password also checks the records, and may have put
        // back settings changed outside the wallet: build on what is stored now
        const base = accountId ? await getSettings() : currentSettings;
        const newSettings = { ...base, ...updates };
        await saveSettings(newSettings);

        // Update RPC client network if changed
        if (updates.network) {
          rpcClient.setNetwork(updates.network);
        }
        // The wallet's scripts follow the allowed sites
        if (updates.allowedSites) await syncSiteScripts();

        if (switching) {
          // Nothing unlocked on one network carries over to the other
          await signingSession.clearSession();
          // and the wallet has an address on the network it moved to
          if (accountId && password) await accountManager.setUpNetwork(accountId, password);
        }

        return { success: true, data: newSettings };
      }

      // ============ dApp Connection ============
      case MSG.CONNECT: {
        const accountId = await getSelectedAccountId();
        if (!accountId) return { success: false, error: 'No account selected' };
        const selected = await accountManager.getAccount(accountId);
        if (selected && selected.addresses.length === 0) return noAddressesOn(selected);

        if (!selected) return { success: false, error: 'No account selected' };
        const isConnected = await connectionManager.isConnected(origin, accountId, selected.network);
        if (isConnected) {
          return {
            success: true,
            data: {
              address: selected?.addresses[0]?.address,
              connected: true
            }
          };
        }

        // Create connection request and wait for approval
        try {
          await connectionManager.requestConnection(origin, accountId, selected.network);
          // Connection approved - return the address of the account the site
          // was connected to, even if the owner chose another meanwhile
          return {
            success: true,
            data: {
              address: selected?.addresses[0]?.address,
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

        const connected = await connectionManager.isConnected(origin, accountId, (await getSettings()).network);
        return { success: true, data: { connected } };
      }

      case MSG.GET_CONNECTED_SITES: {
        const accountId = await getSelectedAccountId();
        if (!accountId) return { success: true, data: [] };

        const sites = await connectionManager.getConnectedSites(accountId);
        return {
          success: true,
          data: sites.map(({ origin, connection }) => ({
            origin, connectedAt: connection.connectedAt, networks: connection.networks ?? [],
          })),
        };
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
        if (result.success && result.txid) await addPendingTx(settings.network, result.txid);
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
        // Include all pending requests (connect, sign_message, send_transaction).
        // Each shows the network the site asked on (a connect asks on the current one).
        const settings = await getSettings();
        const accounts = await getAccounts();
        const requests = await Promise.all(connectionManager.getAllPendingRequests().map(async r => {
          const network = r.data?.network ?? settings.network;
          return {
            id: r.id,
            type: r.type,
            origin: r.origin,
            accountId: r.accountId,
            network,
            data: r.data,
            firstUse: r.firstUse,
            createdAt: r.createdAt,
            ...(await requestContext(r, network, accounts)),
          };
        }));
        return { success: true, data: { requests } };
      }

      case MSG.APPROVE_SIGNING_REQUEST: {
        const request = connectionManager.getPendingRequest(payload.requestId);
        if (!request) {
          return { success: false, error: 'Request not found' };
        }
        // Taken before the first await, so a second click or a second window
        // cannot approve it again while the first approval is running
        if (!connectionManager.claimRequest(payload.requestId)) {
          return { success: false, error: 'This request is already being approved' };
        }
        try {
          return await approveSigningRequest(request, payload);
        } finally {
          connectionManager.releaseRequest(payload.requestId);
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

// The wallet's open windows. The phrase stays in memory only while one is
// open: closing the last popup or approval window locks the wallet.
const openUiPorts = new Set<chrome.runtime.Port>();
runtime.onConnect?.addListener((port: chrome.runtime.Port) => {
  // Only the extension's own pages; a content script's port has a web page URL
  if (port.name !== UI_PORT || !port.sender?.url?.startsWith(runtime.getURL(''))) return;
  openUiPorts.add(port);
  port.onDisconnect.addListener(() => {
    openUiPorts.delete(port);
    if (openUiPorts.size === 0) void signingSession.clearSession();
  });
});

// Lock when the screen locks
idle.onStateChanged?.addListener((state: string) => {
  if (state === 'locked') void signingSession.clearSession();
});

// Initialize on startup
async function initialize() {
  const settings = await getSettings();
  rpcClient.setNetwork(settings.network);
  // Registered scripts persist, but a browser that dropped them (or an
  // update that changed the scripts) gets them back here
  await syncSiteScripts();
}

browserAPI.runtime.onInstalled?.addListener(() => { void syncSiteScripts(); });
browserAPI.runtime.onStartup?.addListener(() => { void syncSiteScripts(); });

// Keep web pages' content scripts out of local storage, where the encrypted
// vault lives. They ask SITE_ALLOWED instead. Chrome and Edge support this for
// local storage; Firefox and Safari do not, and there the content script still
// never reads it. A failure is reported, not hidden.
function restrictLocalStorage(): void {
  const local = browserAPI.storage?.local;
  if (typeof local?.setAccessLevel !== 'function') {
    console.warn('IronDivi: this browser cannot keep content scripts out of local storage');
    return;
  }
  try {
    Promise.resolve(local.setAccessLevel({ accessLevel: 'TRUSTED_CONTEXTS' })).catch((error: unknown) => {
      console.warn('IronDivi: could not keep content scripts out of local storage', error);
    });
  } catch (error) {
    console.warn('IronDivi: could not keep content scripts out of local storage', error);
  }
}
restrictLocalStorage();

initialize();
