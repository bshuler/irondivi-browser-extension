import { storage } from './browser-polyfill';
import { encryptWithPassword, decryptWithPassword } from './crypto-utils';
import type { NetworkType } from './constants';

// Storage schema types
export interface Account {
  id: string;
  name: string;
  createdAt: number;
  network: NetworkType;
  addresses: AccountAddress[];
  addressIndex: number;
}

export interface AccountAddress {
  index: number;
  address: string;
  path: string;
}

export interface EncryptedSecrets {
  encrypted: string;
  iv: string;
  salt: string;
  version?: number;
}

export interface Contact {
  id: string;
  name: string;
  address: string;
  network: NetworkType;
  notes?: string;
  createdAt: number;
  lastUsed?: number;
}

export interface TransactionLimits {
  // Absolute limit in DIVI (0 = no limit)
  maxAmountAbsolute: number;
  // Percentage of total balance (0-100, 0 = no limit)
  maxAmountPercent: number;
  // Daily limit in DIVI (0 = no limit)
  dailyLimitAbsolute: number;
  // Daily limit as percentage of balance (0 = no limit)
  dailyLimitPercent: number;
}

export interface Settings {
  network: NetworkType;
  authTimeoutMinutes: number;
  currency: string;
  hideBalance: boolean;
  // Site allowlist patterns (glob-style, e.g. "*.divi.domains", "localhost:*")
  allowedSites: string[];
  // Transaction limits for security
  transactionLimits: TransactionLimits;
}

export interface Connection {
  connected: boolean;
  connectedAt: number;
  permissions: string[];
}

export interface CachedBalance {
  totalBalance: number;
  utxos: any[];
  lastUpdated: number;
}

// Storage access functions
export async function getAccounts(): Promise<Account[]> {
  const { accounts } = await storage.local.get<{ accounts: Account[] }>('accounts');
  return accounts || [];
}

export async function saveAccounts(accounts: Account[]): Promise<void> {
  await storage.local.set({ accounts });
}

export async function getSecrets(): Promise<Record<string, EncryptedSecrets>> {
  const { secrets } = await storage.local.get<{ secrets: Record<string, EncryptedSecrets> }>('secrets');
  return secrets || {};
}

export async function saveSecret(accountId: string, mnemonic: string, password: string): Promise<void> {
  const secrets = await getSecrets();
  secrets[accountId] = await encryptWithPassword(mnemonic, password);
  await storage.local.set({ secrets });
}

/**
 * Migrate a single secret from legacy iterations (100K) to current iterations (600K).
 * The operation is atomic: storage is only updated after successful re-encryption.
 * If any step fails, the original encrypted data is left untouched.
 */
export async function migrateSecret(accountId: string, password: string): Promise<void> {
  const secrets = await getSecrets();
  const secret = secrets[accountId];
  if (!secret) throw new Error('Account not found');

  // Already migrated - nothing to do
  if (secret.version && secret.version >= 2) return;

  // Decrypt with legacy iterations
  const plaintext = await decryptWithPassword(secret, password);

  // Re-encrypt with current iterations (version 2)
  const migrated = await encryptWithPassword(plaintext, password);

  // Atomically write back - only the single entry is replaced
  const updatedSecrets = { ...secrets, [accountId]: migrated };
  await storage.local.set({ secrets: updatedSecrets });
}

export async function getDecryptedSecret(accountId: string, password: string): Promise<string> {
  const secrets = await getSecrets();
  const secret = secrets[accountId];
  if (!secret) throw new Error('Account not found');

  const plaintext = await decryptWithPassword(secret, password);

  // Transparently migrate legacy data in the background - failures are non-fatal
  if (!secret.version || secret.version < 2) {
    migrateSecret(accountId, password).catch(() => {
      // Migration failure is non-fatal; data is still readable with legacy iterations
    });
  }

  return plaintext;
}

export async function deleteSecret(accountId: string): Promise<void> {
  const secrets = await getSecrets();
  delete secrets[accountId];
  await storage.local.set({ secrets });
}

export async function getAddressBook(): Promise<Contact[]> {
  const { addressBook } = await storage.local.get<{ addressBook: Contact[] }>('addressBook');
  return addressBook || [];
}

export async function saveAddressBook(addressBook: Contact[]): Promise<void> {
  await storage.local.set({ addressBook });
}

export const DEFAULT_SETTINGS: Settings = {
  network: 'testnet',
  authTimeoutMinutes: 5,
  currency: 'USD',
  hideBalance: false,
  // Default allowed sites - *.divi.domains and localhost for development
  allowedSites: ['*.divi.domains', 'localhost', '127.0.0.1'],
  // Default transaction limits - 10% of balance per transaction
  transactionLimits: {
    maxAmountAbsolute: 0, // No absolute limit
    maxAmountPercent: 10, // 10% of balance
    dailyLimitAbsolute: 0, // No daily absolute limit
    dailyLimitPercent: 0, // No daily percentage limit
  },
};

export async function getSettings(): Promise<Settings> {
  const { settings } = await storage.local.get<{ settings: Settings }>('settings');
  // Merge with defaults to ensure new fields are present
  return { ...DEFAULT_SETTINGS, ...settings };
}

export async function saveSettings(settings: Settings): Promise<void> {
  await storage.local.set({ settings });
}

export async function getSelectedAccountId(): Promise<string | null> {
  const { selectedAccountId } = await storage.local.get<{ selectedAccountId: string }>('selectedAccountId');
  return selectedAccountId || null;
}

export async function setSelectedAccountId(accountId: string): Promise<void> {
  await storage.local.set({ selectedAccountId: accountId });
}

export async function getConnections(): Promise<Record<string, Record<string, Connection>>> {
  const { connections } = await storage.local.get<{ connections: Record<string, Record<string, Connection>> }>('connections');
  return connections || {};
}

export async function saveConnections(connections: Record<string, Record<string, Connection>>): Promise<void> {
  await storage.local.set({ connections });
}

export async function getCachedBalance(accountId: string): Promise<CachedBalance | null> {
  const { cache } = await storage.local.get<{ cache: Record<string, CachedBalance> }>('cache');
  return cache?.[accountId] || null;
}

export async function saveCachedBalance(accountId: string, balance: CachedBalance): Promise<void> {
  const { cache } = await storage.local.get<{ cache: Record<string, CachedBalance> }>('cache');
  const newCache = { ...cache, [accountId]: balance };
  await storage.local.set({ cache: newCache });
}
