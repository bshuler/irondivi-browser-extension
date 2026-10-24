/**
 * Divi chain parameters for each network the wallet can switch between.
 * These must match IronDivi (crates/divi-wallet/src/address.rs, hd.rs) —
 * IronDivi in its default `divi` chain mode is consensus-compatible with Divi.
 * The popup's network switcher selects between these at runtime.
 */
export const NETWORKS = {
  mainnet: {
    name: 'Mainnet',
    rpcUrl: 'https://services.divi.domains/api/rpc/',
    explorerUrl: 'https://services.divi.domains/explorer/tx/',
    coinType: 301,
    addressPrefix: 0x1e, // pubKeyHash, 'D'
    scriptPrefix: 0x0d, // scriptHash (13)
    addressFirstChar: 'D',
  },
  testnet: {
    name: 'Testnet',
    rpcUrl: 'https://services.divi.domains/api/testnet/rpc/',
    explorerUrl: 'https://services.divi.domains/testnet/explorer/tx/',
    coinType: 1,
    addressPrefix: 0x8b, // pubKeyHash, 'x' or 'y'
    scriptPrefix: 0x13, // scriptHash (19)
    addressFirstChar: 'y',
  },
} as const;

export type NetworkType = keyof typeof NETWORKS;

// Smallest output Divi nodes relay: 3 * fee(182 bytes). A send below it is
// accepted by a node but never relayed, so the wallet refuses it.
export const DUST_THRESHOLD = 0.0000546;

// Message types for communication
export const MSG = {
  // Account operations
  GET_ACCOUNTS: 'GET_ACCOUNTS',
  SELECT_ACCOUNT: 'SELECT_ACCOUNT',
  GENERATE_MNEMONIC: 'GENERATE_MNEMONIC',
  CREATE_ACCOUNT: 'CREATE_ACCOUNT',
  IMPORT_ACCOUNT: 'IMPORT_ACCOUNT',
  DELETE_ACCOUNT: 'DELETE_ACCOUNT',
  RENAME_ACCOUNT: 'RENAME_ACCOUNT',
  EXPORT_MNEMONIC: 'EXPORT_MNEMONIC',
  ADD_NETWORK_ADDRESSES: 'ADD_NETWORK_ADDRESSES',

  // Wallet operations
  GET_BALANCE: 'GET_BALANCE',
  GET_ADDRESSES: 'GET_ADDRESSES',
  GET_TRANSACTIONS: 'GET_TRANSACTIONS',
  GENERATE_NEW_ADDRESS: 'GENERATE_NEW_ADDRESS',

  // Signing (requires auth)
  AUTHENTICATE: 'AUTHENTICATE',
  SIGN_MESSAGE: 'SIGN_MESSAGE',
  SIGN_TRANSACTION: 'SIGN_TRANSACTION',
  SEND_TRANSACTION: 'SEND_TRANSACTION',

  // Faucet
  REQUEST_FAUCET: 'REQUEST_FAUCET',

  // Address book
  GET_CONTACTS: 'GET_CONTACTS',
  GET_RECENT_CONTACTS: 'GET_RECENT_CONTACTS',
  ADD_CONTACT: 'ADD_CONTACT',
  UPDATE_CONTACT: 'UPDATE_CONTACT',
  DELETE_CONTACT: 'DELETE_CONTACT',
  MARK_CONTACT_USED: 'MARK_CONTACT_USED',
  VALIDATE_ADDRESS: 'VALIDATE_ADDRESS',

  // Settings
  GET_SETTINGS: 'GET_SETTINGS',
  GET_NETWORK: 'GET_NETWORK',
  UPDATE_SETTINGS: 'UPDATE_SETTINGS',

  // dApp connection
  CONNECT: 'CONNECT',
  DISCONNECT: 'DISCONNECT',
  IS_CONNECTED: 'IS_CONNECTED',
  GET_CONNECTED_SITES: 'GET_CONNECTED_SITES',
  REVOKE_SITE: 'REVOKE_SITE',
  // Content script only: may this page use the wallet at all?
  SITE_ALLOWED: 'SITE_ALLOWED',

  // Signing request approval
  GET_PENDING_SIGNING_REQUESTS: 'GET_PENDING_SIGNING_REQUESTS',
  APPROVE_SIGNING_REQUEST: 'APPROVE_SIGNING_REQUEST',
  REJECT_SIGNING_REQUEST: 'REJECT_SIGNING_REQUEST',
} as const;

export type MessageType = typeof MSG[keyof typeof MSG];

/**
 * The only message types a web page may send (through the content script).
 * These are the methods window.irondivi uses; every other message type is for
 * the extension's own pages (popup, approval window) only.
 */
export const DAPP_METHODS: readonly string[] = [
  MSG.CONNECT,
  MSG.DISCONNECT,
  MSG.IS_CONNECTED,
  MSG.GET_ADDRESSES,
  MSG.GET_BALANCE,
  MSG.GET_NETWORK,
  MSG.SIGN_MESSAGE,
  MSG.SEND_TRANSACTION,
];

// ============================================================
// Payload types for each message
// ============================================================

// Account operations
export interface GetAccountsPayload {}
export interface SelectAccountPayload { accountId: string }
export interface GenerateMnemonicPayload { wordCount?: number; language?: string }
export interface CreateAccountPayload {
  name: string;
  password: string;
  network?: NetworkType;
  wordCount?: number;
  language?: string;
}
export interface ImportAccountPayload {
  name: string;
  mnemonic: string;
  password: string;
  network?: NetworkType;
}
export interface DeleteAccountPayload { accountId: string; password: string }
export interface RenameAccountPayload { accountId: string; name: string }
export interface ExportMnemonicPayload { accountId: string; password: string }

// Wallet operations
export interface GetBalancePayload {}
export interface GetAddressesPayload {}
export interface GetTransactionsPayload { limit?: number }
export interface GenerateNewAddressPayload { accountId: string; password: string }

// Signing operations
export interface AuthenticatePayload { accountId: string; password: string }
export interface SignMessagePayload {
  message: string;
  // From the popup: the account to sign with, which must be the unlocked one
  accountId?: string;
  address?: string;
  addressIndex?: number;
}
export interface SignTransactionPayload {
  to: string;
  amount: number;
  fee?: number;
}
export interface SendTransactionPayload {
  to: string;
  amount: number;
  fee?: number;
  fromAddresses?: string[];
  opReturn?: string;
}

// Faucet
export interface RequestFaucetPayload { address: string }

// Address book
export interface GetContactsPayload { network?: NetworkType }
export interface GetRecentContactsPayload { limit?: number }
export interface AddContactPayload {
  name: string;
  address: string;
  network: NetworkType;
  notes?: string;
}
export interface UpdateContactPayload {
  contactId: string;
  updates?: Partial<{ name: string; notes: string }>;
  // Legacy flat format (backward compat)
  id?: string;
  name?: string;
  address?: string;
  notes?: string;
}
export interface DeleteContactPayload { contactId: string }
export interface MarkContactUsedPayload { contactId: string }
export interface ValidateAddressPayload { address: string }

// Settings
export interface GetSettingsPayload {}
export interface UpdateSettingsPayload {
  network?: NetworkType;
  authTimeoutMinutes?: number;
  currency?: string;
  hideBalance?: boolean;
}

// dApp connection
export interface ConnectPayload {}
export interface DisconnectPayload {}
export interface IsConnectedPayload {}
export interface GetConnectedSitesPayload {}
export interface RevokeSitePayload { origin: string }

// Signing request approval
export interface GetPendingSigningRequestsPayload {}
export interface ApproveSigningRequestPayload { requestId: string; password: string }
export interface RejectSigningRequestPayload { requestId: string }

// ============================================================
// Discriminated union — WalletMessage
// ============================================================
export type WalletMessage =
  | { type: typeof MSG.GET_ACCOUNTS; payload?: GetAccountsPayload }
  | { type: typeof MSG.SELECT_ACCOUNT; payload: SelectAccountPayload }
  | { type: typeof MSG.GENERATE_MNEMONIC; payload?: GenerateMnemonicPayload }
  | { type: typeof MSG.CREATE_ACCOUNT; payload: CreateAccountPayload }
  | { type: typeof MSG.IMPORT_ACCOUNT; payload: ImportAccountPayload }
  | { type: typeof MSG.DELETE_ACCOUNT; payload: DeleteAccountPayload }
  | { type: typeof MSG.RENAME_ACCOUNT; payload: RenameAccountPayload }
  | { type: typeof MSG.EXPORT_MNEMONIC; payload: ExportMnemonicPayload }
  | { type: typeof MSG.GET_BALANCE; payload?: GetBalancePayload }
  | { type: typeof MSG.GET_ADDRESSES; payload?: GetAddressesPayload }
  | { type: typeof MSG.GET_TRANSACTIONS; payload?: GetTransactionsPayload }
  | { type: typeof MSG.GENERATE_NEW_ADDRESS; payload: GenerateNewAddressPayload }
  | { type: typeof MSG.AUTHENTICATE; payload: AuthenticatePayload }
  | { type: typeof MSG.SIGN_MESSAGE; payload: SignMessagePayload }
  | { type: typeof MSG.SIGN_TRANSACTION; payload: SignTransactionPayload }
  | { type: typeof MSG.SEND_TRANSACTION; payload: SendTransactionPayload }
  | { type: typeof MSG.REQUEST_FAUCET; payload: RequestFaucetPayload }
  | { type: typeof MSG.GET_CONTACTS; payload?: GetContactsPayload }
  | { type: typeof MSG.GET_RECENT_CONTACTS; payload?: GetRecentContactsPayload }
  | { type: typeof MSG.ADD_CONTACT; payload: AddContactPayload }
  | { type: typeof MSG.UPDATE_CONTACT; payload: UpdateContactPayload }
  | { type: typeof MSG.DELETE_CONTACT; payload: DeleteContactPayload }
  | { type: typeof MSG.MARK_CONTACT_USED; payload: MarkContactUsedPayload }
  | { type: typeof MSG.VALIDATE_ADDRESS; payload: ValidateAddressPayload }
  | { type: typeof MSG.GET_SETTINGS; payload?: GetSettingsPayload }
  | { type: typeof MSG.UPDATE_SETTINGS; payload: UpdateSettingsPayload }
  | { type: typeof MSG.CONNECT; payload?: ConnectPayload }
  | { type: typeof MSG.DISCONNECT; payload?: DisconnectPayload }
  | { type: typeof MSG.IS_CONNECTED; payload?: IsConnectedPayload }
  | { type: typeof MSG.GET_CONNECTED_SITES; payload?: GetConnectedSitesPayload }
  | { type: typeof MSG.REVOKE_SITE; payload: RevokeSitePayload }
  | { type: typeof MSG.GET_PENDING_SIGNING_REQUESTS; payload?: GetPendingSigningRequestsPayload }
  | { type: typeof MSG.APPROVE_SIGNING_REQUEST; payload: ApproveSigningRequestPayload }
  | { type: typeof MSG.REJECT_SIGNING_REQUEST; payload: RejectSigningRequestPayload };

// ============================================================
// Generic response wrapper
// ============================================================
export interface MessageResponse<T = unknown> {
  success: boolean;
  data?: T;
  error?: string;
}

// ============================================================
// Type-safe sendMessage helper (for popup / content scripts)
// ============================================================
type PayloadOf<M extends WalletMessage> = M extends { payload: infer P }
  ? P
  : M extends { payload?: infer P }
  ? P | undefined
  : never;

type SendMessageFn = <M extends WalletMessage>(
  message: { type: M['type']; payload?: PayloadOf<M> }
) => Promise<MessageResponse>;

/**
 * Thin wrapper around chrome.runtime.sendMessage with WalletMessage types.
 * Usage:
 *   await sendMessage({ type: MSG.SELECT_ACCOUNT, payload: { accountId: '...' } });
 */
export const sendMessage: SendMessageFn = (message) =>
  new Promise((resolve, reject) => {
    chrome.runtime.sendMessage(message, (response: MessageResponse) => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
      } else {
        resolve(response);
      }
    });
  });

// Faucet URLs
export const FAUCET_URLS = {
  testnet: 'https://services.divi.domains/testnet/faucet/api/request',
  mainnet: 'https://vps1.divi.domains/faucet/api/request',
};

