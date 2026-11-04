import { storage } from './browser-polyfill';
import {
  encryptWithPassword,
  decryptWithPassword,
  encryptVault,
  decryptVault,
  isVaultV4Doc,
  assertHasPasswordSlot,
  encryptVaultV4Payload,
  decryptVaultV4Payload,
  wrapDekWithPassword,
  unwrapDekWithPassword,
  wrapDekWithPrf,
  unwrapDekWithPrf,
  unb64url,
  secureWipe,
  type VaultV4Doc,
  type VaultV4SlotPassword,
  type VaultV4SlotPasskey,
  type PasskeyAuthPayload,
} from './crypto-utils';
import type { NetworkType } from './constants';
import { OLD_DEFAULT_PATTERNS } from './origin';
import { emptyAccess, migrateAllowedSites, normalizeAccess, type SiteAccess } from './site-access';

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
  // Set when the records were found changed outside the wallet and this
  // contact could not be checked; the owner is asked to check its address
  unverified?: boolean;
}

export interface TransactionLimits {
  // The Spending limits switch (ADR 0002): off, no limit below applies
  enabled: boolean;
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
  // What the user chose for sites that asked, and the sites the user
  // blocked (site-access.ts). The default list and the denylist are compiled
  // into the wallet and are not settings.
  siteAccess: SiteAccess;
  // Before 0.0.5: the allowed-site patterns, read once to carry the user's
  // own sites over to siteAccess, never written again
  allowedSites?: string[];
  // Transaction limits for security
  transactionLimits: TransactionLimits;
  // 2 from 0.0.5, when a daily limit became the default. Settings saved
  // earlier have the daily limits off because that was the default then.
  limitsVersion?: number;
  // The owner's own words, shown on every approval window so a page cannot
  // pass off a window of its own as the wallet's (EXT-18)
  securityPhrase?: string;
}

export interface Connection {
  connected: boolean;
  connectedAt: number;
  permissions: string[];
  // The networks the owner connected the site on (EXT-11). A connection
  // made before 0.0.5 has none, so the site asks again on either network
  networks?: NetworkType[];
}

export interface CachedBalance {
  totalBalance: number;
  utxos: any[];
  lastUpdated: number;
}

// The records a page could change on a browser that lets content scripts
// write storage.local. The background seals them (records-seal.ts) and
// installs its writer here; until then they are written as they are.
export interface RecordsPatch {
  accounts?: Account[];
  settings?: Settings;
  connections?: Record<string, Record<string, Connection>>;
  addressBook?: Contact[];
}

let recordsWriter: (patch: RecordsPatch) => Promise<void> = patch => storage.local.set(patch);

export function setRecordsWriter(writer: (patch: RecordsPatch) => Promise<void>): void {
  recordsWriter = writer;
}

// Storage access functions
export async function getAccounts(): Promise<Account[]> {
  const { accounts } = await storage.local.get<{ accounts: Account[] }>('accounts');
  return accounts || [];
}

export async function saveAccounts(accounts: Account[]): Promise<void> {
  await recordsWriter({ accounts });
}

export type StoredSecret = EncryptedSecrets | VaultV4Doc;

export interface PasskeySlotInfo {
  id: string;
  label: string;
  credentialId: string;
  prfSalt: string;
  createdAt: number;
}

export interface PreparedPasskeyEnrol {
  accountId: string;
  dek: Uint8Array;
  mnemonic: string;
  recordsKey?: string;
  passSlot: VaultV4SlotPassword | null;
}

export async function getSecrets(): Promise<Record<string, StoredSecret>> {
  const { secrets } = await storage.local.get<{ secrets: Record<string, StoredSecret> }>('secrets');
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

// A version 3/4 secret holds the records key with the phrase, so the key is
// only ever stored where the password/passkey guards it (records-seal.ts)
function secretPayload(mnemonic: string, recordsKey?: string): string {
  return JSON.stringify(recordsKey ? { m: mnemonic, k: recordsKey } : { m: mnemonic });
}

function sameStoredSecret(a: StoredSecret | undefined, b: StoredSecret): boolean {
  if (!a) return false;
  if (isVaultV4Doc(b)) {
    return isVaultV4Doc(a) &&
      a.encryptedPayload === b.encryptedPayload &&
      a.iv === b.iv &&
      a.slots.length === b.slots.length;
  }
  return !isVaultV4Doc(a) && a.encrypted === b.encrypted && a.salt === b.salt;
}

async function encryptSecret(mnemonic: string, password: string, recordsKey?: string): Promise<EncryptedSecrets> {
  return recordsKey
    ? encryptVault(secretPayload(mnemonic, recordsKey), password)
    : encryptWithPassword(mnemonic, password);
}

export async function saveSecret(accountId: string, mnemonic: string, password: string, recordsKey?: string): Promise<void> {
  const existing = (await getSecrets())[accountId];
  if (existing && isVaultV4Doc(existing) && recordsKey) {
    await storeRecordsKey(accountId, password, mnemonic, recordsKey, existing);
    return;
  }
  const blob = await encryptSecret(mnemonic, password, recordsKey);
  await withSecretsLock(async () => {
    const secrets = await getSecrets();
    secrets[accountId] = blob;
    await storage.local.set({ secrets });
  });
}

export async function saveSecretWithRecordsKey(
  accountId: string,
  mnemonic: string,
  recordsKey: string,
  password: string,
): Promise<void> {
  const current = (await getSecrets())[accountId];
  if (current) {
    await storeRecordsKey(accountId, password, mnemonic, recordsKey, current);
    return;
  }
  await saveSecret(accountId, mnemonic, password, recordsKey);
}

/**
 * Store the records key in a secret that was opened as `before`, if it is
 * still what is stored. For Vault v4 documents, unwraps the existing DEK via
 * the password slot and re-encrypts `{ m, k }` under that same DEK (fresh IV),
 * keeping all enrolled passkey PRF slots intact.
 */
export async function storeRecordsKey(
  accountId: string, password: string, mnemonic: string, recordsKey: string, before: StoredSecret,
): Promise<void> {
  const expected = secretPayload(mnemonic, recordsKey);
  let nextBlob: StoredSecret;
  if (isVaultV4Doc(before)) {
    const passSlot = assertHasPasswordSlot(before);
    const dek = await unwrapDekWithPassword(passSlot, password);
    try {
      const { iv, encryptedPayload } = await encryptVaultV4Payload(dek, expected);
      nextBlob = {
        version: 4,
        iv,
        encryptedPayload,
        slots: before.slots.map(s => structuredClone(s)),
      };
    } finally {
      secureWipe(dek);
    }
  } else {
    nextBlob = await encryptSecret(mnemonic, password, recordsKey);
  }
  const check = await decryptVault(nextBlob, password);
  if (check.plaintext !== expected) {
    throw new Error('Re-encrypted secret did not decrypt to the original');
  }
  await withSecretsLock(async () => {
    const secrets = await getSecrets();
    const current = secrets[accountId];
    if (!sameStoredSecret(current, before)) return;
    secrets[accountId] = nextBlob;
    await storage.local.set({ secrets });
  });
}

/**
 * Store or repair the records key on a Vault v4 document when unlocked via
 * passkey, unwrapping the existing DEK via the matching PRF slot and preserving
 * the required password slot and all PRF slots.
 */
export async function storeRecordsKeyViaPasskey(
  accountId: string,
  passkeyAuth: PasskeyAuthPayload,
  mnemonic: string,
  recordsKey: string,
  before: StoredSecret,
): Promise<void> {
  if (!isVaultV4Doc(before)) {
    throw new Error('Account does not use a passkey vault');
  }
  assertHasPasswordSlot(before);
  const prfSlot = before.slots.find(
    (s): s is VaultV4SlotPasskey => s.kind === 'prf' && s.credentialId === passkeyAuth.credentialId,
  );
  if (!prfSlot) throw new Error('Passkey slot not found');

  const expected = secretPayload(mnemonic, recordsKey);
  const prfBytes = unb64url(passkeyAuth.prfOutput);
  let nextDoc: VaultV4Doc;
  try {
    const dek = await unwrapDekWithPrf(prfSlot, prfBytes);
    try {
      const { iv, encryptedPayload } = await encryptVaultV4Payload(dek, expected);
      nextDoc = {
        version: 4,
        iv,
        encryptedPayload,
        slots: before.slots.map(s => structuredClone(s)),
      };
      const checkDek = await unwrapDekWithPrf(prfSlot, prfBytes);
      try {
        const checkPt = await decryptVaultV4Payload(checkDek, nextDoc.iv, nextDoc.encryptedPayload);
        if (checkPt !== expected) {
          throw new Error('Re-encrypted secret did not decrypt to the original');
        }
      } finally {
        secureWipe(checkDek);
      }
    } finally {
      secureWipe(dek);
    }
  } finally {
    secureWipe(prfBytes);
  }

  await withSecretsLock(async () => {
    const secrets = await getSecrets();
    const current = secrets[accountId];
    if (!sameStoredSecret(current, before)) return;
    secrets[accountId] = nextDoc;
    await storage.local.set({ secrets });
  });
}

/** Whether any account's secret holds a records key, by its label or v4 structure */
export async function anySecretHoldsRecordsKey(): Promise<boolean> {
  return Object.values(await getSecrets()).some(s => isVaultV4Doc(s) || (s?.version ?? 0) >= 3);
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
  if (isVaultV4Doc(before) || (before.version && before.version >= 2)) return;

  const plaintext = await decryptWithPassword(before, password);
  const migrated = await encryptWithPassword(plaintext, password);
  if (await decryptWithPassword(migrated, password) !== plaintext) {
    throw new Error('Re-encrypted secret did not decrypt to the original');
  }

  await withSecretsLock(async () => {
    const secrets = await getSecrets();
    const current = secrets[accountId];
    // Deleted, replaced or already migrated meanwhile: leave it alone
    if (!current || isVaultV4Doc(current) || current.encrypted !== before.encrypted || current.salt !== before.salt) return;
    secrets[accountId] = migrated;
    await storage.local.set({ secrets });
  });
}

export interface OpenedSecret {
  mnemonic: string;
  // The records key the secret holds (version 3 / 4), base64
  recordsKey?: string;
  // Whether the secret opened under legacy (<v2) KDF iterations
  legacy: boolean;
  // The secret's label did not match how it opened
  relabeled: boolean;
  // The blob that was opened, for a compare-and-swap rewrite
  blob: StoredSecret;
}

export async function openSecret(accountId: string, password: string): Promise<OpenedSecret> {
  const secrets = await getSecrets();
  const secret = secrets[accountId];
  if (!secret) throw new Error('Account not found');

  const { plaintext, version, relabeled } = await decryptVault(secret, password);
  let mnemonic = plaintext;
  let recordsKey: string | undefined;
  if (version >= 3) {
    const payload = JSON.parse(plaintext);
    mnemonic = payload.m;
    recordsKey = typeof payload.k === 'string' ? payload.k : undefined;
  }
  const legacy = version < 2;

  // Upgrade a legacy secret before returning, so the worker cannot be stopped
  // part way through. A failure is not fatal: the legacy secret still opens.
  if (legacy && !relabeled) {
    await migrateSecret(accountId, password).catch(() => {});
  }

  return { mnemonic, recordsKey, legacy, relabeled, blob: (await getSecrets())[accountId] ?? secret };
}

export async function openSecretWithPasskey(
  accountId: string,
  credentialId: string,
  prfOutputB64Url: string,
): Promise<OpenedSecret & { slotId: string }> {
  const secrets = await getSecrets();
  const secret = secrets[accountId];
  if (!secret) throw new Error('Account not found');
  if (!isVaultV4Doc(secret)) {
    throw new Error('No passkey enrolled for this account');
  }
  assertHasPasswordSlot(secret);
  const slot = secret.slots.find(
    (s): s is VaultV4SlotPasskey => s.kind === 'prf' && s.credentialId === credentialId,
  );
  if (!slot) {
    throw new Error('Decryption failed - unrecognized passkey');
  }

  const prfBytes = unb64url(prfOutputB64Url);
  if (prfBytes.byteLength !== 32) {
    secureWipe(prfBytes);
    throw new Error('Passkey PRF output must be 32 bytes');
  }

  let dek: Uint8Array | null = null;
  try {
    dek = await unwrapDekWithPrf(slot, prfBytes);
    const plaintext = await decryptVaultV4Payload(dek, secret.iv, secret.encryptedPayload);
    const payload = JSON.parse(plaintext);
    if (!payload || typeof payload.m !== 'string') {
      throw new Error('Decryption failed - malformed vault payload');
    }
    return {
      mnemonic: payload.m,
      recordsKey: typeof payload.k === 'string' ? payload.k : undefined,
      slotId: slot.id,
      legacy: false,
      relabeled: secret.version !== 4,
      blob: secret,
    };
  } finally {
    secureWipe(prfBytes);
    if (dek) secureWipe(dek);
  }
}

export async function getPasskeySlots(accountId: string): Promise<PasskeySlotInfo[]> {
  const secret = (await getSecrets())[accountId];
  if (!secret || !isVaultV4Doc(secret)) return [];
  return secret.slots
    .filter((s): s is VaultV4SlotPasskey => s?.kind === 'prf')
    .map(s => ({
      id: s.id,
      label: s.label,
      credentialId: s.credentialId,
      prfSalt: s.prfSalt,
      createdAt: s.createdAt,
    }));
}

export async function preparePasskeyEnrol(
  accountId: string,
  password: string,
  fallbackRecordsKey?: string,
): Promise<PreparedPasskeyEnrol> {
  const opened = await openSecret(accountId, password);
  const current = (await getSecrets())[accountId];
  if (!current) throw new Error('Account not found');

  const recordsKey = opened.recordsKey ?? fallbackRecordsKey;
  if (isVaultV4Doc(current)) {
    const passSlot = assertHasPasswordSlot(current);
    const dek = await unwrapDekWithPassword(passSlot, password);
    return {
      accountId,
      dek,
      mnemonic: opened.mnemonic,
      recordsKey,
      passSlot: null,
    };
  }

  const dek = crypto.getRandomValues(new Uint8Array(32));
  try {
    const passSlot = await wrapDekWithPassword(dek, password, 'slot-pass');
    return {
      accountId,
      dek,
      mnemonic: opened.mnemonic,
      recordsKey,
      passSlot,
    };
  } catch (err) {
    secureWipe(dek);
    throw err;
  }
}

export async function commitPasskeyEnrol(
  prepared: PreparedPasskeyEnrol,
  slotInput: {
    label: string;
    credentialId: string;
    prfSalt: string;
    prfOutputB64Url: string;
  },
): Promise<PasskeySlotInfo> {
  const prfBytes = unb64url(slotInput.prfOutputB64Url);
  if (prfBytes.byteLength !== 32) {
    secureWipe(prfBytes);
    secureWipe(prepared.dek);
    throw new Error('Passkey PRF output must be 32 bytes');
  }

  try {
    const prfSlot = await wrapDekWithPrf(prepared.dek, {
      label: slotInput.label,
      credentialId: slotInput.credentialId,
      prfSalt: slotInput.prfSalt,
      prfOutput: prfBytes,
    });

    await withSecretsLock(async () => {
      const secrets = await getSecrets();
      const current = secrets[prepared.accountId];
      if (!current) throw new Error('Account not found');

      let nextDoc: VaultV4Doc;
      let expectedPlaintext: string;

      if (isVaultV4Doc(current)) {
        assertHasPasswordSlot(current);
        if (current.slots.some(s => s.kind === 'prf' && s.credentialId === slotInput.credentialId)) {
          throw new Error('This passkey is already enrolled on this account');
        }
        const existingPt = await decryptVaultV4Payload(prepared.dek, current.iv, current.encryptedPayload);
        const parsed = JSON.parse(existingPt);
        const effectiveRecordsKey = typeof parsed.k === 'string' ? parsed.k : prepared.recordsKey;
        if (typeof parsed.k !== 'string' && effectiveRecordsKey) {
          expectedPlaintext = secretPayload(parsed.m, effectiveRecordsKey);
          const { iv, encryptedPayload } = await encryptVaultV4Payload(prepared.dek, expectedPlaintext);
          nextDoc = {
            version: 4,
            iv,
            encryptedPayload,
            slots: [...current.slots.map(s => structuredClone(s)), prfSlot],
          };
        } else {
          expectedPlaintext = existingPt;
          nextDoc = {
            version: 4,
            iv: current.iv,
            encryptedPayload: current.encryptedPayload,
            slots: [...current.slots.map(s => structuredClone(s)), prfSlot],
          };
        }
      } else {
        if (!prepared.passSlot) {
          throw new Error('Missing password slot for Vault v4 upgrade');
        }
        expectedPlaintext = secretPayload(prepared.mnemonic, prepared.recordsKey);
        const { iv, encryptedPayload } = await encryptVaultV4Payload(prepared.dek, expectedPlaintext);
        nextDoc = {
          version: 4,
          iv,
          encryptedPayload,
          slots: [prepared.passSlot, prfSlot],
        };
      }

      assertHasPasswordSlot(nextDoc);
      const checkDek = await unwrapDekWithPrf(prfSlot, prfBytes);
      try {
        const checkPt = await decryptVaultV4Payload(checkDek, nextDoc.iv, nextDoc.encryptedPayload);
        if (checkPt !== expectedPlaintext) {
          throw new Error('Passkey slot verification failed');
        }
      } finally {
        secureWipe(checkDek);
      }

      secrets[prepared.accountId] = nextDoc;
      await storage.local.set({ secrets });
    });

    return {
      id: prfSlot.id,
      label: prfSlot.label,
      credentialId: prfSlot.credentialId,
      prfSalt: prfSlot.prfSalt,
      createdAt: prfSlot.createdAt,
    };
  } finally {
    secureWipe(prfBytes);
    secureWipe(prepared.dek);
  }
}

export async function addPasskeySlot(
  accountId: string,
  password: string,
  slotInput: {
    label: string;
    credentialId: string;
    prfSalt: string;
    prfOutputB64Url: string;
  },
  fallbackRecordsKey?: string,
): Promise<PasskeySlotInfo> {
  const prepared = await preparePasskeyEnrol(accountId, password, fallbackRecordsKey);
  try {
    return await commitPasskeyEnrol(prepared, slotInput);
  } finally {
    secureWipe(prepared.dek);
  }
}

export async function removePasskeySlot(
  accountId: string,
  auth: string | PasskeyAuthPayload,
  slotId: string,
): Promise<void> {
  if (typeof auth === 'string') {
    await openSecret(accountId, auth);
  } else {
    await openSecretWithPasskey(accountId, auth.credentialId, auth.prfOutput);
  }

  await withSecretsLock(async () => {
    const secrets = await getSecrets();
    const current = secrets[accountId];
    if (!current || !isVaultV4Doc(current)) {
      throw new Error('Passkey not found');
    }
    const target = current.slots.find(s => s.id === slotId);
    if (!target) {
      throw new Error('Passkey not found');
    }
    if (target.kind !== 'prf') {
      throw new Error('Cannot remove required password slot');
    }
    const nextSlots = current.slots.filter(s => s.id !== slotId);
    const nextDoc: VaultV4Doc = {
      version: 4,
      iv: current.iv,
      encryptedPayload: current.encryptedPayload,
      slots: nextSlots.map(s => structuredClone(s)),
    };
    assertHasPasswordSlot(nextDoc);
    secrets[accountId] = nextDoc;
    await storage.local.set({ secrets });
  });
}

/**
 * Open a secret with a password without changing anything: no migration,
 * no lockout count. For checking whether one password also opens another
 * account (records-seal.ts); null if it does not.
 */
export async function openSecretQuietly(accountId: string, password: string): Promise<OpenedSecret | null> {
  const secret = (await getSecrets())[accountId];
  if (!secret) return null;
  try {
    const { plaintext, version, relabeled } = await decryptVault(secret, password);
    if (version < 3) return { mnemonic: plaintext, legacy: version < 2, relabeled, blob: secret };
    const payload = JSON.parse(plaintext);
    return { mnemonic: payload.m, recordsKey: typeof payload.k === 'string' ? payload.k : undefined, legacy: false, relabeled, blob: secret };
  } catch {
    return null;
  }
}

export async function getDecryptedSecret(accountId: string, password: string): Promise<string> {
  return (await openSecret(accountId, password)).mnemonic;
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
  await recordsWriter({ addressBook });
}

export const DEFAULT_SETTINGS: Settings = {
  network: 'testnet',
  authTimeoutMinutes: 5,
  currency: 'USD',
  hideBalance: false,
  siteAccess: emptyAccess(),
  // Default transaction limits: 10% of the balance per transaction, 25% a day
  transactionLimits: {
    enabled: true,
    maxAmountAbsolute: 0, // No absolute limit
    maxAmountPercent: 10, // 10% of balance
    dailyLimitAbsolute: 0, // No daily absolute limit
    dailyLimitPercent: 25, // 25% of balance in any 24 hours
  },
  limitsVersion: 2,
};

export async function getSettings(): Promise<Settings> {
  const { settings } = await storage.local.get<{ settings: Settings }>('settings');
  return normalizeSettings(settings);
}

/** Whether any of the four limits is above 0 */
export function limitsSet(l: Omit<TransactionLimits, 'enabled'>): boolean {
  return l.maxAmountAbsolute > 0 || l.maxAmountPercent > 0 || l.dailyLimitAbsolute > 0 || l.dailyLimitPercent > 0;
}

/** Stored settings (or none) as the wallet uses them */
export function normalizeSettings(settings: Partial<Settings> | undefined): Settings {
  // Merge with defaults to ensure new fields are present
  const merged = { ...DEFAULT_SETTINGS, ...settings };
  const limits = { ...DEFAULT_SETTINGS.transactionLimits, ...settings?.transactionLimits };
  // Turn the default daily limit on for settings saved before it existed. Once
  // saved with limitsVersion 2, a daily limit of 0 is the owner's choice.
  if (settings && (settings.limitsVersion ?? 1) < 2 && !limits.dailyLimitAbsolute && !limits.dailyLimitPercent) {
    limits.dailyLimitPercent = DEFAULT_SETTINGS.transactionLimits.dailyLimitPercent;
  }
  // Settings saved before the switch: on if any limit was set (ADR 0002)
  if (typeof settings?.transactionLimits?.enabled !== 'boolean') limits.enabled = limitsSet(limits);
  const out: Settings = {
    ...merged,
    transactionLimits: limits,
    limitsVersion: 2,
    siteAccess: settings?.siteAccess
      ? normalizeAccess(settings.siteAccess)
      : migrateAllowedSites(settings?.allowedSites, OLD_DEFAULT_PATTERNS).access,
  };
  delete out.allowedSites;
  return out;
}

/**
 * The allowed-site patterns of settings from before 0.0.5 that could not be
 * carried over to exact sites (wildcards, any port), or none
 */
export function droppedSitePatterns(settings: Partial<Settings> | undefined): string[] {
  if (!settings || settings.siteAccess) return [];
  return migrateAllowedSites(settings.allowedSites, OLD_DEFAULT_PATTERNS).dropped;
}

export async function saveSettings(settings: Settings): Promise<void> {
  await recordsWriter({ settings });
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
  await recordsWriter({ connections });
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
