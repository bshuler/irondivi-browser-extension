// Types for the vendored build of @divi/electrum-client (see vendor/README.md).
import type { Backend, Network, ServerCheck } from '../src/background/backend/types';

export const GENESIS: Readonly<Record<Network, string>>;
export function addressToScripthash(address: string, network: Network): string;
export function addressToScriptPubKey(address: string, network: Network): string;

export interface ElectrumClientLike {
  request<T = any>(method: string, params?: unknown[]): Promise<T>;
}

export class ElectrumBackend implements Backend {
  constructor(options: { url: string; network: Network; lastSeenTip?: number; WebSocket?: unknown; client?: object });
  readonly kind: 'electrum';
  readonly network: Network;
  readonly url: string;
  /** The one WebSocket, for the calls the Backend contract has no method for */
  readonly client: ElectrumClientLike;
  connect(): Promise<ServerCheck>;
  close(): void;
  getTipHeight(): Promise<number>;
  getBalance(addresses: string[]): Promise<{ confirmed: number; unconfirmed: number }>;
  listUnspent(addresses: string[]): ReturnType<Backend['listUnspent']>;
  getHistory(addresses: string[]): ReturnType<Backend['getHistory']>;
  getTransaction(txid: string): Promise<object>;
  broadcast(rawTxHex: string): Promise<string>;
  onNewBlock(cb: (height: number) => void): () => void;
  onAddressChange(addresses: string[], cb: (address: string) => void): () => void;
}

export function checkServer(url: string, network: Network, lastSeenTip?: number | null, options?: { WebSocket?: unknown }): Promise<ServerCheck>;
