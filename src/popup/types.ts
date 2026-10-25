/**
 * Shared types for the popup UI
 */

export interface AccountAddress {
  index: number;
  address: string;
  path: string;
}

export interface Account {
  id: string;
  name: string;
  createdAt: number;
  network: string;
  addresses: AccountAddress[];
  addressIndex: number;
}

export interface Transaction {
  txid: string;
  type: 'send' | 'receive';
  amount: number;
  address: string;
  timestamp: number;
  confirmations: number;
}

export interface Contact {
  id: string;
  name: string;
  address: string;
  notes?: string;
  // Set when the wallet found its records changed outside it (records-seal.ts)
  unverified?: boolean;
}

export interface ConnectedSite {
  origin: string;
  connectedAt: number;
}

export interface TransactionLimits {
  maxAmountAbsolute: number;
  maxAmountPercent: number;
  dailyLimitAbsolute: number;
  dailyLimitPercent: number;
}

export interface Settings {
  network: NetworkType;
  authTimeoutMinutes: number;
  currency: string;
  hideBalance: boolean;
  allowedSites: string[];
  transactionLimits: TransactionLimits;
}

export interface PendingSendTx {
  to: string;
  amount: number;
  fee: number;
  fromAddresses?: string[]; // If set, only use UTXOs from these addresses
}

import { NetworkType } from '../shared/constants';

/**
 * Helper to get primary address from an account
 */
export function getPrimaryAddress(account: Account | null): string {
  if (!account || !account.addresses || account.addresses.length === 0) {
    return '';
  }
  return account.addresses[0].address;
}
