import { NETWORKS, FAUCET_URLS, type NetworkType } from '../shared/constants';

interface RPCResponse<T = any> {
  result?: T;
  error?: { code: number; message: string };
  id: string | number;
}

export interface UTXOResponse {
  txid: string;
  vout: number;
  address: string;
  amount: number;
  satoshis: number;
  scriptPubKey: string;
  confirmations: number;
}

export interface TransactionHistoryItem {
  txid: string;
  time: number;
  confirmations: number;
  amount: number;
  fee: number;
  addresses: string[];
  type: 'send' | 'receive';
}

export interface AddressBalance {
  address: string;
  balance: number;
  received: number;
  sent: number;
}

export class RPCClient {
  private readonly TIMEOUT_MS = 30000; // 30 seconds
  private network: NetworkType = 'testnet';

  setNetwork(network: NetworkType): void {
    this.network = network;
  }

  getNetwork(): NetworkType {
    return this.network;
  }

  /**
   * Make an RPC call
   */
  private async rpc<T = any>(method: string, params: any[] = []): Promise<T> {
    const url = NETWORKS[this.network].rpcUrl;

    // Create AbortController for timeout
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), this.TIMEOUT_MS);

    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          jsonrpc: '2.0',
          method,
          params,
          id: Date.now(),
        }),
        signal: controller.signal,
      });

      if (!response.ok) {
        throw new Error(`RPC request failed: ${response.status} ${response.statusText}`);
      }

      const data: RPCResponse<T> = await response.json();

      if (data.error) {
        throw new Error(`RPC error: ${data.error.message} (code: ${data.error.code})`);
      }

      return data.result as T;
    } catch (error) {
      if (error instanceof Error && error.name === 'AbortError') {
        throw new Error(`RPC request timed out after ${this.TIMEOUT_MS}ms`);
      }
      throw error;
    } finally {
      clearTimeout(timeoutId);
    }
  }

  /**
   * Get balance for multiple addresses
   */
  async getBalance(addresses: string[]): Promise<number> {
    const results = await Promise.allSettled(
      addresses.map(address =>
        this.rpc<number>('getaddressbalance', [address])
      )
    );

    let total = 0;
    const errors: string[] = [];

    for (let i = 0; i < results.length; i++) {
      const result = results[i];
      if (result.status === 'fulfilled') {
        total += result.value;
      } else {
        const message = result.reason instanceof Error ? result.reason.message : String(result.reason);
        console.warn(`Failed to get balance for ${addresses[i]}`);
        errors.push(`${addresses[i]}: ${message}`);
      }
    }

    if (errors.length > 0 && total === 0) {
      throw new Error(`Failed to fetch balance: ${errors[0]}`);
    }

    return total;
  }

  /**
   * Get UTXOs for multiple addresses
   */
  async getUtxos(addresses: string[]): Promise<UTXOResponse[]> {
    const results = await Promise.allSettled(
      addresses.map(address =>
        this.rpc<UTXOResponse[]>('getaddressutxos', [address])
      )
    );

    const allUtxos: UTXOResponse[] = [];
    const errors: string[] = [];

    for (let i = 0; i < results.length; i++) {
      const result = results[i];
      if (result.status === 'fulfilled') {
        allUtxos.push(...result.value);
      } else {
        const message = result.reason instanceof Error ? result.reason.message : String(result.reason);
        console.warn(`Failed to get UTXOs for ${addresses[i]}`);
        errors.push(`${addresses[i]}: ${message}`);
      }
    }

    if (errors.length > 0 && allUtxos.length === 0) {
      throw new Error(`Failed to fetch UTXOs: ${errors[0]}`);
    }

    return allUtxos;
  }

  /**
   * Get transaction history for addresses
   */
  async getTransactionHistory(addresses: string[], limit: number = 50): Promise<TransactionHistoryItem[]> {
    try {
      // Get transaction IDs for addresses
      const txids = await this.rpc<string[]>('getaddresstxids', [{ addresses }]);

      // Get details for each transaction (limit to most recent)
      const recentTxids = txids.slice(-limit).reverse();
      const transactions: TransactionHistoryItem[] = [];

      const BATCH_SIZE = 10;
      for (let i = 0; i < recentTxids.length; i += BATCH_SIZE) {
        const batch = recentTxids.slice(i, i + BATCH_SIZE);
        const results = await Promise.allSettled(
          batch.map(txid => this.rpc<any>('getrawtransaction', [txid, true]))
        );
        for (let j = 0; j < results.length; j++) {
          const result = results[j];
          if (result.status === 'fulfilled' && result.value) {
            const tx = result.value;
            const netAmount = this.calculateTxAmount(tx, addresses);
            transactions.push({
              txid: tx.txid,
              time: tx.time || tx.blocktime || Date.now() / 1000,
              confirmations: tx.confirmations || 0,
              amount: Math.abs(netAmount),
              fee: tx.fee || 0,
              addresses: this.extractTxAddresses(tx),
              type: netAmount >= 0 ? 'receive' : 'send',
            });
          } else if (result.status === 'rejected') {
            console.warn(`Failed to get transaction ${batch[j]}`);
          }
        }
      }

      return transactions;
    } catch (e) {
      console.error('Failed to get transaction history');
      throw new Error(`Failed to fetch transaction history: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  /**
   * Broadcast a signed transaction
   */
  async broadcastTransaction(hexTx: string): Promise<string> {
    return this.rpc<string>('sendrawtransaction', [hexTx]);
  }

  /**
   * Validate an address
   */
  async validateAddress(address: string): Promise<boolean> {
    try {
      const result = await this.rpc<{ isvalid: boolean }>('validateaddress', [address]);
      return result.isvalid;
    } catch (e) {
      return false;
    }
  }

  /**
   * Get current block height
   */
  async getBlockCount(): Promise<number> {
    return this.rpc<number>('getblockcount');
  }

  /**
   * Get network info
   */
  async getNetworkInfo(): Promise<any> {
    return this.rpc('getnetworkinfo');
  }

  /**
   * Check if an address has any transactions
   */
  async hasTransactions(address: string): Promise<boolean> {
    try {
      const txids = await this.rpc<string[]>('getaddresstxids', [{ addresses: [address] }]);
      return txids.length > 0;
    } catch (e) {
      return false;
    }
  }

  /**
   * Get raw transaction
   */
  async getRawTransaction(txid: string, verbose: boolean = true): Promise<any> {
    return this.rpc('getrawtransaction', [txid, verbose]);
  }

  /**
   * Calculate net amount for a transaction relative to our addresses
   */
  private calculateTxAmount(tx: any, ourAddresses: string[]): number {
    const ourSet = new Set(ourAddresses);
    let received = 0;
    let sent = 0;

    // Sum outputs going to our addresses
    for (const vout of tx.vout || []) {
      const addresses = vout.scriptPubKey?.addresses || [];
      for (const addr of addresses) {
        if (ourSet.has(addr)) {
          received += vout.value || 0;
        }
      }
    }

    // Sum inputs from our addresses
    for (const vin of tx.vin || []) {
      if (vin.prevout) {
        const addresses = vin.prevout.scriptPubKey?.addresses || [];
        for (const addr of addresses) {
          if (ourSet.has(addr)) {
            sent += vin.prevout.value || 0;
          }
        }
      }
    }

    return received - sent;
  }

  /**
   * Extract all addresses involved in a transaction
   */
  private extractTxAddresses(tx: any): string[] {
    const addresses = new Set<string>();

    for (const vout of tx.vout || []) {
      const addrs = vout.scriptPubKey?.addresses || [];
      for (const addr of addrs) {
        addresses.add(addr);
      }
    }

    for (const vin of tx.vin || []) {
      if (vin.prevout) {
        const addrs = vin.prevout.scriptPubKey?.addresses || [];
        for (const addr of addrs) {
          addresses.add(addr);
        }
      }
    }

    return Array.from(addresses);
  }

  /**
   * Get explorer URL for a transaction
   */
  getExplorerUrl(txid: string): string {
    return `${NETWORKS[this.network].explorerUrl}${txid}`;
  }

  /**
   * Request test coins from the faucet
   */
  async requestFaucet(address: string, network: 'mainnet' | 'testnet'): Promise<{ success: boolean; txid?: string; error?: string }> {
    const url = network === 'testnet' ? FAUCET_URLS.testnet : FAUCET_URLS.mainnet;
    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ address }),
      });
      return response.json();
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : 'Unknown error' };
    }
  }
}

// Singleton instance
export const rpcClient = new RPCClient();
