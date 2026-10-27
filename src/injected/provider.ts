/**
 * IronDivi Provider - Injected into web pages
 * Similar to window.ethereum for Ethereum dApps
 */

// The content script and this provider talk over a private MessageChannel,
// never window.postMessage: every script on the page sees what is posted to
// the window and could read a request id and answer first (a fake txid or
// signature). Both run at document_start, before any page script, and the
// port changes hands then. Which of the two runs first is not fixed, so:
//   - the provider offers a port in an 'irondivi:port' event; a content script
//     already listening takes it and cancels the event;
//   - if nobody took it, the provider waits for the content script's
//     'irondivi:ready' event and offers again, once.
import { CAPABILITIES, ERR, errorCode } from '../shared/provider-errors';

const PORT_EVENT = 'irondivi:port';
const READY_EVENT = 'irondivi:ready';

type EventCallback = (...args: any[]) => void;

// What a site may do: on the default list, allowed or refused by the user,
// not (yet) allowed, or blocked
export type AccessStatus = 'default' | 'allowed' | 'not_allowed' | 'denied' | 'blocked';

interface TransactionRequest {
  to: string;
  // DIVI: a decimal string ("1234.5") is exact; a number must have at
  // most 8 decimals and be below 90,000,000
  amount: number | string;
  fee?: number;
  fromAddresses?: string[];
  // UTF-8, 1 to 599 bytes, sent unchanged in one OP_RETURN output ("memo")
  memo?: string;
  // The same as memo, by the name the Divi Name Service page uses
  opReturn?: string;
}

// A failed request: message, and the IronDivi Connect code (4001 rejected,
// 4100 not connected, 4200 unsupported, 4900 locked, 4901 network mismatch),
// or IronDivi's own site-access codes (4300 the site must ask with
// requestAccess first, 4301 the site is blocked)
export class ProviderRpcError extends Error {
  constructor(message: string, readonly code: number) {
    super(message);
    this.name = 'ProviderRpcError';
  }
}

const SEND_OPTIONS = ['to', 'amount', 'fee', 'fromAddresses', 'memo', 'opReturn'];

class IronDiviProvider {
  // Properties
  readonly isIronDivi = true;
  readonly version = '1.0.0';
  // What this wallet does beyond the base API; "memo": sendTransaction
  // attaches memo. A site must check before relying on one.
  readonly capabilities: readonly string[] = CAPABILITIES;

  private pendingRequests = new Map<string, {
    resolve: (value: any) => void;
    reject: (error: Error) => void;
  }>();
  private eventListeners = new Map<string, Set<EventCallback>>();

  private port: MessagePort;

  constructor() {
    const channel = new MessageChannel();
    this.port = channel.port1;
    this.port.onmessage = (event) => {
      const { id, response } = event.data ?? {};
      const pending = this.pendingRequests.get(id);

      if (pending && response) {
        this.pendingRequests.delete(id);
        if (response.success) {
          pending.resolve(response.data);
        } else {
          const message = response.error || 'Request failed';
          const code = typeof response.code === 'number' ? response.code : errorCode(message);
          pending.reject(new ProviderRpcError(message, code));
        }
      }
    };

    const offer = () => window.dispatchEvent(new MessageEvent(PORT_EVENT, { ports: [channel.port2], cancelable: true }));
    if (offer()) {
      // Not taken yet: hand it over when the content script says it is ready
      const onReady = () => {
        if (!offer()) window.removeEventListener(READY_EVENT, onReady);
      };
      window.addEventListener(READY_EVENT, onReady);
    }
  }

  /**
   * Send a request to the extension
   */
  private async sendRequest(method: string, params?: any): Promise<any> {
    // Use cryptographically random UUID for request ID to prevent prediction attacks
    const id = crypto.randomUUID();

    return new Promise((resolve, reject) => {
      // Set timeout
      const timeout = setTimeout(() => {
        this.pendingRequests.delete(id);
        reject(new ProviderRpcError('Request timeout', ERR.INTERNAL));
      }, 5 * 60 * 1000); // 5 minutes

      this.pendingRequests.set(id, {
        resolve: (value) => {
          clearTimeout(timeout);
          resolve(value);
        },
        reject: (error) => {
          clearTimeout(timeout);
          reject(error);
        },
      });

      this.port.postMessage({ id, method, params });
    });
  }

  // ============ Site Access ============

  /**
   * What this site may do, without asking the user. Every other method
   * fails with 4300 unless this is "default" or "allowed".
   */
  async getAccessStatus(): Promise<AccessStatus> {
    const result = await this.sendRequest('GET_ACCESS_STATUS');
    return result.status;
  }

  /**
   * Ask the user whether this site may use the wallet. Opens one window only
   * for a site that is "not_allowed" and has not been told "Not now" in the
   * last 24 hours; resolves with the status afterwards.
   */
  async requestAccess(params?: { reason?: string }): Promise<AccessStatus> {
    const reason = typeof params?.reason === 'string' ? params.reason : undefined;
    const result = await this.sendRequest('REQUEST_ACCESS', reason === undefined ? undefined : { reason });
    return result.status;
  }

  // ============ Connection Methods ============

  /**
   * Check if connected to the wallet
   */
  async isConnected(): Promise<boolean> {
    const result = await this.sendRequest('IS_CONNECTED');
    return result?.connected === true;
  }

  /**
   * Request connection to the wallet
   */
  async connect(params?: { network?: 'mainnet' | 'testnet' }): Promise<{ address: string; network: string; capabilities: string[] }> {
    const result = await this.sendRequest('CONNECT', params?.network === undefined ? undefined : { network: params.network });
    this.emit('connect', { address: result.address });
    return result;
  }

  /**
   * Disconnect from the wallet
   */
  async disconnect(): Promise<void> {
    await this.sendRequest('DISCONNECT');
    this.emit('disconnect');
  }

  // ============ Account Methods ============

  /**
   * Get connected accounts
   */
  async getAccounts(): Promise<string[]> {
    const addresses = await this.sendRequest('GET_ADDRESSES');
    return addresses?.map((a: any) => a.address) || [];
  }

  /**
   * Get current network
   */
  async getNetwork(): Promise<'mainnet' | 'testnet'> {
    const result = await this.sendRequest('GET_NETWORK');
    if (result?.network !== 'mainnet' && result?.network !== 'testnet') {
      throw new Error('Wallet did not report its network');
    }
    return result.network;
  }

  /**
   * Get balance for address
   */
  async getBalance(address?: string): Promise<number> {
    const result = await this.sendRequest('GET_BALANCE', { address });
    return result?.balance || 0;
  }

  // ============ Signing Methods ============

  /**
   * Sign a message
   */
  async signMessage(message: string, address?: string): Promise<string> {
    const connected = await this.isConnected();
    if (!connected) {
      throw new ProviderRpcError('Not connected. Call connect() first.', ERR.NOT_CONNECTED);
    }
    // Without an address the wallet signs with the account's first address
    const result = await this.sendRequest('SIGN_MESSAGE', { message, address });
    return result?.signature;
  }

  /**
   * Sign a Divi Games chain transaction: the exact JSON text of its body.
   * The owner is shown it as a transaction. Only the Divi Games site may ask.
   */
  async signGameTx(body: string): Promise<{ signature: string; address: string; txid: string }> {
    const connected = await this.isConnected();
    if (!connected) {
      throw new ProviderRpcError('Not connected. Call connect() first.', ERR.NOT_CONNECTED);
    }
    return this.sendRequest('SIGN_GAME_TX', { body });
  }

  /**
   * Send a transaction
   */
  async sendTransaction(tx: TransactionRequest): Promise<string> {
    const connected = await this.isConnected();
    if (!connected) {
      throw new ProviderRpcError('Not connected. Call connect() first.', ERR.NOT_CONNECTED);
    }
    // An option this wallet does not know is refused, never dropped
    const unknown = Object.keys(tx ?? {}).filter(k => !SEND_OPTIONS.includes(k));
    if (unknown.length > 0) {
      throw new ProviderRpcError(`Unsupported option: ${unknown.join(', ')}`, ERR.UNSUPPORTED);
    }
    const params: TransactionRequest = { to: tx.to, amount: tx.amount, fee: tx.fee, fromAddresses: tx.fromAddresses };
    if (tx.memo !== undefined) params.memo = tx.memo;
    if (tx.opReturn !== undefined) params.opReturn = tx.opReturn;
    const result = await this.sendRequest('SEND_TRANSACTION', params);
    return result?.txid;
  }

  // ============ Event Methods ============

  /**
   * Subscribe to events
   */
  on(event: string, callback: EventCallback): void {
    if (!this.eventListeners.has(event)) {
      this.eventListeners.set(event, new Set());
    }
    this.eventListeners.get(event)!.add(callback);
  }

  /**
   * Unsubscribe from events
   */
  off(event: string, callback: EventCallback): void {
    this.eventListeners.get(event)?.delete(callback);
  }

  /**
   * Emit an event
   */
  private emit(event: string, ...args: any[]): void {
    this.eventListeners.get(event)?.forEach(callback => {
      try {
        callback(...args);
      } catch (e) {
        console.error('Event callback error:', e);
      }
    });
  }

  // ============ Generic Request Method (EIP-1193 style) ============

  /**
   * Generic request method
   */
  async request(args: { method: string; params?: any }): Promise<any> {
    const methodMap: Record<string, string> = {
      'irondivi_connect': 'CONNECT',
      'irondivi_disconnect': 'DISCONNECT',
      'irondivi_accounts': 'GET_ADDRESSES',
      'irondivi_getBalance': 'GET_BALANCE',
      'irondivi_signMessage': 'SIGN_MESSAGE',
      'irondivi_signGameTx': 'SIGN_GAME_TX',
      'irondivi_sendTransaction': 'SEND_TRANSACTION',
    };

    if (args.method === 'irondivi_getNetwork') {
      return this.getNetwork();
    }
    if (args.method === 'irondivi_getAccessStatus') return this.getAccessStatus();
    if (args.method === 'irondivi_requestAccess') return this.requestAccess(args.params);

    const internalMethod = methodMap[args.method];
    if (!internalMethod) {
      throw new ProviderRpcError(`Unsupported method: ${args.method}`, ERR.UNSUPPORTED);
    }

    return this.sendRequest(internalMethod, args.params);
  }
}

// Create and expose the provider, once. A second copy of this script (an
// extension reload, a page that loads it again) must not add a second message
// listener or replace the provider a dApp already holds.
if (!(window as any).irondivi?.isIronDivi) {
  const provider = new IronDiviProvider();

  // Not writable or configurable: a later script cannot swap in a fake
  Object.defineProperty(window, 'irondivi', {
    value: provider,
    writable: false,
    configurable: false,
    enumerable: true,
  });

  // Dispatch event to notify dApps
  window.dispatchEvent(new CustomEvent('irondivi#initialized'));

  // Also dispatch on DOMContentLoaded for late listeners
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => {
      window.dispatchEvent(new CustomEvent('irondivi#initialized'));
    });
  }
}
