/**
 * The Backend contract shared by the web wallet, the Telegram app and this
 * extension (wallet-server-choice-lanes.md, "The Backend contract"). Names,
 * arguments, units and errors are fixed there. Amounts are integer satoshis;
 * a height of 0 or less means unconfirmed.
 */

export type Network = 'mainnet' | 'testnet';

export interface Utxo {
  txid: string;
  vout: number;
  value: number;
  height: number;
  address: string;
  scriptPubKey: string;
}

export interface HistoryItem {
  txid: string;
  height: number;
  address: string;
}

export type ServerProblem = null | 'unreachable' | 'wrong-network' | 'behind' | 'bad-reply';

export interface ServerCheck {
  ok: boolean;
  network: Network | null;
  tip: number | null;
  software: string | null;
  problem: ServerProblem;
  message: string;
}

export interface Backend {
  readonly kind: 'rpc' | 'electrum';
  readonly network: Network;
  connect(): Promise<ServerCheck>;
  close(): void;
  getTipHeight(): Promise<number>;
  getBalance(addresses: string[]): Promise<{ confirmed: number; unconfirmed: number }>;
  listUnspent(addresses: string[]): Promise<Utxo[]>;
  getHistory(addresses: string[]): Promise<HistoryItem[]>;
  getTransaction(txid: string): Promise<object>;
  broadcast(rawTxHex: string): Promise<string>;
  onNewBlock(cb: (height: number) => void): () => void;
  onAddressChange(addresses: string[], cb: (address: string) => void): () => void;
}

export type BackendErrorCode = 'unreachable' | 'wrong-network' | 'behind' | 'bad-reply' | 'server-error';

export class BackendError extends Error {
  constructor(public readonly code: BackendErrorCode, message: string) {
    super(message);
    this.name = 'BackendError';
  }
}
