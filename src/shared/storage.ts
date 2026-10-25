import { storage } from './browser-polyfill';
import { encryptWithPassword, decryptWithPassword } from './crypto-utils';
import type { NetworkType } from './constants';
import { defaultAllowedSites, effectiveAllowedSites } from './origin';

// Storage schema types
export interface Account {
  id: string;
  name: string;
  createdAt: number;
  // The network the account was created on. Its addresses on that network
  // are also kept in `addresses` and `addressIndex`, as 0.0.1 stored them.
  network: NetworkType;
  addresses: AccountAddress[];
  addressIndex: number;
  // The account's addresses on each network it has been set up for.
  networks?: Partial<Record<NetworkType, NetworkAddresses>>;
}

export interface NetworkAddresses {
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
  // 2 from 0.0.5, when a daily limit became the default. Settings saved
  // earlier have the daily limits off because that was the default then.
  limitsVersion?: number;
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

// Every change to the secrets map reads the whole map and writes it back, so
// two changes running at once can lose one of them: a background migration
// could put back a secret that was just deleted, or drop one just added. They
// run one after another instead.
let secretsQueue: Promise<unknown> = Promise.resolve();

function withSecretsLock<T>(fn: () => Promise<T>): Promise<T> {
  const run = secretsQueue.then(fn, fn);
  secretsQueue = run.catch(() => {});
  return run;
}

export async function saveSecret(accountId: string, mnemonic: string, password: string): Promise<void> {
  const blob = await encryptWithPassword(mnemonic, password);
  await withSecretsLock(async () => {
    const secrets = await getSecrets();
    secrets[accountId] = blob;
    await storage.local.set({ secrets });
  });
}

/**
 * Re-encrypt one secret from the legacy 100K iterations to the current 600K.
 * The new blob is decrypted and compared with the phrase before anything is
 * written, and it replaces the old one only if the old one is still what is
 * stored. A single storage write replaces the map whole, so a crash leaves
 * either the old blob or the new one, never a mix.
 */
export async function migrateSecret(accountId: string, password: string): Promise<void> {
  const before = (await getSecrets())[accountId];
  if (!before) throw new Error('Account not found');
  if (before.version && before.version >= 2) return;

  const plaintext = await decryptWithPassword(before, password);
  const migrated = await encryptWithPassword(plaintext, password);
  if (await decryptWithPassword(migrated, password) !== plaintext) {
    throw new Error('Re-encrypted secret did not decrypt to the original');
  }

  await withSecretsLock(async () => {
    const secrets = await getSecrets();
    const current = secrets[accountId];
    // Deleted, replaced or already migrated meanwhile: leave it alone
    if (!current || current.encrypted !== before.encrypted || current.salt !== before.salt) return;
    secrets[accountId] = migrated;
    await storage.local.set({ secrets });
  });
}

export async function getDecryptedSecret(accountId: string, password: string): Promise<string> {
  const secrets = await getSecrets();
  const secret = secrets[accountId];
  if (!secret) throw new Error('Account not found');

  const plaintext = await decryptWithPassword(secret, password);

  // Upgrade a legacy secret before returning, so the worker cannot be stopped
  // part way through. A failure is not fatal: the legacy secret still opens.
  if (!secret.version || secret.version < 2) {
    await migrateSecret(accountId, password).catch(() => {});
  }

  return plaintext;
}

export async function deleteSecret(accountId: string): Promise<void> {
  await withSecretsLock(async () => {
    const secrets = await getSecrets();
    delete secrets[accountId];
    await storage.local.set({ secrets });
  });
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
  // The production dApp hosts, plus localhost in a development build
  allowedSites: defaultAllowedSites(),
  // Default transaction limits: 10% of the balance per transaction, 25% a day
  transactionLimits: {
    maxAmountAbsolute: 0, // No absolute limit
    maxAmountPercent: 10, // 10% of balance
    dailyLimitAbsolute: 0, // No daily absolute limit
    dailyLimitPercent: 25, // 25% of balance in any 24 hours
  },
  limitsVersion: 2,
};

export async function getSettings(): Promise<Settings> {
  const { settings } = await storage.local.get<{ settings: Settings }>('settings');
  // Merge with defaults to ensure new fields are present
  const merged = { ...DEFAULT_SETTINGS, ...settings };
  const limits = { ...DEFAULT_SETTINGS.transactionLimits, ...settings?.transactionLimits };
  // Turn the default daily limit on for settings saved before it existed. Once
  // saved with limitsVersion 2, a daily limit of 0 is the owner's choice.
  if (settings && (settings.limitsVersion ?? 1) < 2 && !limits.dailyLimitAbsolute && !limits.dailyLimitPercent) {
    limits.dailyLimitPercent = DEFAULT_SETTINGS.transactionLimits.dailyLimitPercent;
  }
  return {
    ...merged,
    transactionLimits: limits,
    limitsVersion: 2,
    allowedSites: effectiveAllowedSites(settings?.allowedSites),
  };
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
