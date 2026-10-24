import { NETWORKS, FAUCET_URLS, type NetworkType } from '../shared/constants';

// Most mempool transactions to look through for ours on each history load.
const MEMPOOL_SCAN_LIMIT = 200;

interface RPCResponse<T = any> {
  result?: T;
  error?: { code: number; message: string };
  id: string | number;
}

// What the RPC actually returns
interface RPCUTXOResponse {
  txid: string;
  outputIndex: number;  // vout
  address: string;
  satoshis: number;
  script: string;       // scriptPubKey
  height: number;
}

// Normalized UTXO format used by wallet
export interface UTXOResponse {
  txid: string;
  vout: number;
  address: string;
  satoshis: bigint;
  amount: number;        // In DIVI, for display only
  confirmations: number;
}

// A UTXO is only used if every field is well formed and it is at the address
// that was asked about; anything else means the node is broken or lying
function normaliseUtxo(rpcUtxo: RPCUTXOResponse, address: string, currentHeight: number): UTXOResponse {
  const u = rpcUtxo as any;
  if (!u || typeof u !== 'object' ||
      typeof u.txid !== 'string' || !/^[0-9a-fA-F]{64}$/.test(u.txid) ||
      !Number.isInteger(u.outputIndex) || u.outputIndex < 0 || u.outputIndex > 0xffffffff ||
      !Number.isSafeInteger(u.satoshis) || u.satoshis <= 0 ||
      u.address !== address) {
    throw new Error('Node returned an invalid UTXO');
  }
  const height = Number.isInteger(u.height) ? u.height : 0;
  return {
    txid: u.txid.toLowerCase(),
    vout: u.outputIndex,
    address,
    satoshis: BigInt(u.satoshis),
    amount: u.satoshis / 100000000,
    confirmations: currentHeight > 0 && height > 0 ? currentHeight - height + 1 : 0,
  };
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

interface AddressBalanceResponse {
  balance: number;  // In satoshis
  received: number; // In satoshis
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
   * Returns balance in DIVI (not satoshis)
   */
  async getBalance(addresses: string[]): Promise<number> {
    const results = await Promise.allSettled(
      addresses.map(address =>
        this.rpc<AddressBalanceResponse>('getaddressbalance', [address])
      )
    );

    let totalSatoshis = 0;
    const errors: string[] = [];

    for (let i = 0; i < results.length; i++) {
      const result = results[i];
      if (result.status === 'fulfilled') {
        // RPC returns {balance: satoshis, received: satoshis}
        totalSatoshis += result.value.balance;
      } else {
        const message = result.reason instanceof Error ? result.reason.message : String(result.reason);
        console.warn(`Failed to get balance for ${addresses[i]}`);
        errors.push(`${addresses[i]}: ${message}`);
      }
    }

    if (errors.length > 0 && totalSatoshis === 0) {
      throw new Error(`Failed to fetch balance: ${errors[0]}`);
    }

    // Convert satoshis to DIVI
    return totalSatoshis / 100000000;
  }

  /**
   * Get UTXOs for multiple addresses
   * Converts from RPC format to normalized format
   */
  async getUtxos(addresses: string[]): Promise<UTXOResponse[]> {
    // Get current block height for confirmations calculation
    let currentHeight = 0;
    try {
      currentHeight = await this.getBlockCount();
    } catch (e) {
      console.warn('Failed to get block height for confirmations');
    }

    const results = await Promise.allSettled(
      addresses.map(address =>
        this.rpc<RPCUTXOResponse[]>('getaddressutxos', [address])
      )
    );

    const allUtxos: UTXOResponse[] = [];
    const errors: string[] = [];

    for (let i = 0; i < results.length; i++) {
      const result = results[i];
      if (result.status === 'fulfilled') {
        if (!Array.isArray(result.value)) {
          throw new Error('Node returned an invalid UTXO list');
        }
        allUtxos.push(...result.value.map(rpcUtxo => normaliseUtxo(rpcUtxo, addresses[i], currentHeight)));
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
   * Get transaction history for addresses. The address index only lists mined
   * transactions, so unconfirmed ones come from the node's mempool and from
   * `extraTxids` (ones this wallet sent or asked the faucet for); those are kept
   * only if they pay or spend one of our addresses. Unconfirmed come first.
   */
  async getTransactionHistory(addresses: string[], limit: number = 50, extraTxids: string[] = []): Promise<TransactionHistoryItem[]> {
    try {
      // Get transaction IDs for addresses
      const txids = await this.rpc<string[]>('getaddresstxids', [{ addresses }]);
      const confirmed = new Set(txids);

      let mempool: string[] = [];
      try {
        mempool = (await this.rpc<string[]>('getrawmempool', [])) || [];
      } catch {
        console.warn('Failed to read the mempool');
      }
      const unconfirmed = [...new Set([...extraTxids, ...mempool.slice(0, MEMPOOL_SCAN_LIMIT)])]
        .filter(txid => !confirmed.has(txid));

      // Get details for each transaction (limit to most recent)
      const recentTxids = txids.slice(-limit).reverse();
      const candidates = [...unconfirmed, ...recentTxids];
      const maybeOurs = new Set(unconfirmed);
      const pending: TransactionHistoryItem[] = [];
      const transactions: TransactionHistoryItem[] = [];

      const BATCH_SIZE = 10;
      for (let i = 0; i < candidates.length; i += BATCH_SIZE) {
        const batch = candidates.slice(i, i + BATCH_SIZE);
        const results = await Promise.allSettled(
          batch.map(txid => this.rpc<any>('getrawtransaction', [txid, 1]))
        );
        for (let j = 0; j < results.length; j++) {
          const result = results[j];
          if (result.status === 'fulfilled' && result.value) {
            const tx = result.value;
            if (maybeOurs.has(batch[j]) && !this.touchesAddresses(tx, addresses)) continue;
            const netAmount = this.calculateTxAmount(tx, addresses);
            const item: TransactionHistoryItem = {
              txid: tx.txid,
              time: tx.time || tx.blocktime || Date.now() / 1000,
              confirmations: tx.confirmations || 0,
              amount: Math.abs(netAmount),
              fee: tx.fee || 0,
              addresses: this.extractTxAddresses(tx),
              type: netAmount >= 0 ? 'receive' : 'send',
            };
            (item.confirmations === 0 ? pending : transactions).push(item);
          } else if (result.status === 'rejected' && !maybeOurs.has(batch[j])) {
            console.warn(`Failed to get transaction ${batch[j]}`);
          }
        }
      }

      return [...pending, ...transactions];
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
    return this.rpc('getrawtransaction', [txid, verbose ? 1 : 0]);
  }

  /**
   * The serialised transaction, as hex. Callers parse it and check its txid
   * themselves, so a node cannot swap in a different transaction.
   */
  async getRawTransactionHex(txid: string): Promise<string> {
    const hex = await this.rpc<unknown>('getrawtransaction', [txid, 0]);
    if (typeof hex !== 'string') {
      throw new Error('Node returned an invalid transaction');
    }
    return hex;
  }

  /**
   * Whether a transaction pays or spends any of the given addresses
   */
  private touchesAddresses(tx: any, ourAddresses: string[]): boolean {
    const ourSet = new Set(ourAddresses);
    return (tx.vout || []).some((v: any) => (v.scriptPubKey?.addresses || []).some((a: string) => ourSet.has(a)))
      || (tx.vin || []).some((v: any) => v.address && ourSet.has(v.address));
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
    // DIVI RPC returns address and value directly on vin, not in prevout
    for (const vin of tx.vin || []) {
      if (vin.address && ourSet.has(vin.address)) {
        sent += vin.value || 0;
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

    // DIVI RPC returns address directly on vin
    for (const vin of tx.vin || []) {
      if (vin.address) {
        addresses.add(vin.address);
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
