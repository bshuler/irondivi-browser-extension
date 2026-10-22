/**
 * IronDivi Provider - Injected into web pages
 * Similar to window.ethereum for Ethereum dApps
 */

const PROVIDER_MESSAGE = 'IRONDIVI_PROVIDER_MESSAGE';
const PROVIDER_RESPONSE = 'IRONDIVI_PROVIDER_RESPONSE';
const pageOrigin = window.location.origin;

type EventCallback = (...args: any[]) => void;

interface TransactionRequest {
  to: string;
  amount: number;
  fee?: number;
  fromAddresses?: string[];
}

interface ProviderResponse {
  success: boolean;
  data?: any;
  error?: string;
}

class IronDiviProvider {
  // Properties
  readonly isIronDivi = true;
  readonly version = '1.0.0';

  private pendingRequests = new Map<string, {
    resolve: (value: any) => void;
    reject: (error: Error) => void;
  }>();
  private eventListeners = new Map<string, Set<EventCallback>>();

  constructor() {
    // Listen for responses from content script
    window.addEventListener('message', (event) => {
      if (event.source !== window) return;
      if (event.data?.type !== PROVIDER_RESPONSE) return;

      const { id, response } = event.data;
      const pending = this.pendingRequests.get(id);

      if (pending) {
        this.pendingRequests.delete(id);
        if (response.success) {
          pending.resolve(response.data);
        } else {
          pending.reject(new Error(response.error || 'Request failed'));
        }
      }
    });
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
        reject(new Error('Request timeout'));
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

      window.postMessage({
        type: PROVIDER_MESSAGE,
        id,
        method,
        params,
      }, pageOrigin);
    });
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
  async connect(): Promise<{ address: string; publicKey?: string }> {
    const result = await this.sendRequest('CONNECT');
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
      throw new Error('Not connected. Call connect() first.');
    }
    // Without an address the wallet signs with the account's first address
    const result = await this.sendRequest('SIGN_MESSAGE', { message, address });
    return result?.signature;
  }

  /**
   * Send a transaction
   */
  async sendTransaction(tx: TransactionRequest): Promise<string> {
    const connected = await this.isConnected();
    if (!connected) {
      throw new Error('Not connected. Call connect() first.');
    }
    const result = await this.sendRequest('SEND_TRANSACTION', {
      to: tx.to,
      amount: tx.amount,
      fee: tx.fee,
      fromAddresses: tx.fromAddresses,
    });
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
      'irondivi_sendTransaction': 'SEND_TRANSACTION',
    };

    if (args.method === 'irondivi_getNetwork') {
      return this.getNetwork();
    }

    const internalMethod = methodMap[args.method];
    if (!internalMethod) {
      throw new Error(`Unknown method: ${args.method}`);
    }

    return this.sendRequest(internalMethod, args.params);
  }
}

// Create and expose the provider
const provider = new IronDiviProvider();

// Attach to window
(window as any).irondivi = provider;

// Dispatch event to notify dApps
window.dispatchEvent(new CustomEvent('irondivi#initialized'));

// Also dispatch on DOMContentLoaded for late listeners
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', () => {
    window.dispatchEvent(new CustomEvent('irondivi#initialized'));
  });
}
