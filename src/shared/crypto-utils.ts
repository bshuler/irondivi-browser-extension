// AES-GCM encryption utilities for vault storage

export const PBKDF2_ITERATIONS = 600000;
export const PBKDF2_ITERATIONS_LEGACY = 100000;
const SALT_LENGTH = 16;
const IV_LENGTH = 12;

export async function deriveKey(password: string, salt: Uint8Array, iterations: number = PBKDF2_ITERATIONS): Promise<CryptoKey> {
  const encoder = new TextEncoder();
  const passwordKey = await crypto.subtle.importKey(
    'raw',
    encoder.encode(password),
    'PBKDF2',
    false,
    ['deriveKey']
  );

  return crypto.subtle.deriveKey(
    {
      name: 'PBKDF2',
      salt: salt as BufferSource,
      iterations,
      hash: 'SHA-256',
    },
    passwordKey,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt']
  );
}

export async function encrypt(data: string, password: string): Promise<{
  encrypted: string;
  iv: string;
  salt: string;
}> {
  const encoder = new TextEncoder();
  const salt = crypto.getRandomValues(new Uint8Array(SALT_LENGTH));
  const iv = crypto.getRandomValues(new Uint8Array(IV_LENGTH));
  const key = await deriveKey(password, salt);

  const encrypted = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv },
    key,
    encoder.encode(data)
  );

  return {
    encrypted: btoa(String.fromCharCode(...new Uint8Array(encrypted))),
    iv: btoa(String.fromCharCode(...iv)),
    salt: btoa(String.fromCharCode(...salt)),
  };
}

export async function decrypt(
  encryptedData: { encrypted: string; iv: string; salt: string },
  password: string
): Promise<string> {
  const decoder = new TextDecoder();

  const encrypted = Uint8Array.from(atob(encryptedData.encrypted), c => c.charCodeAt(0));
  const iv = Uint8Array.from(atob(encryptedData.iv), c => c.charCodeAt(0));
  const salt = Uint8Array.from(atob(encryptedData.salt), c => c.charCodeAt(0));

  const key = await deriveKey(password, salt);

  try {
    const decrypted = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv },
      key,
      encrypted
    );
    return decoder.decode(decrypted);
  } catch (e) {
    throw new Error('Decryption failed - incorrect password');
  }
}

/**
 * Encrypt with versioned password-based encryption.
 * Version 2 uses PBKDF2_ITERATIONS (600K). Always sets version: 2.
 */
export async function encryptWithPassword(data: string, password: string): Promise<{
  encrypted: string;
  iv: string;
  salt: string;
  version: number;
}> {
  const encoder = new TextEncoder();
  const salt = crypto.getRandomValues(new Uint8Array(SALT_LENGTH));
  const iv = crypto.getRandomValues(new Uint8Array(IV_LENGTH));
  const key = await deriveKey(password, salt, PBKDF2_ITERATIONS);

  const encrypted = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv },
    key,
    encoder.encode(data)
  );

  return {
    encrypted: btoa(String.fromCharCode(...new Uint8Array(encrypted))),
    iv: btoa(String.fromCharCode(...iv)),
    salt: btoa(String.fromCharCode(...salt)),
    version: 2,
  };
}

/**
 * Decrypt versioned password-based encrypted data.
 * Version < 2 (or absent) uses PBKDF2_ITERATIONS_LEGACY (100K).
 * Version >= 2 uses PBKDF2_ITERATIONS (600K).
 */
export async function decryptWithPassword(
  encryptedData: { encrypted: string; iv: string; salt: string; version?: number },
  password: string
): Promise<string> {
  const decoder = new TextDecoder();
  const iterations = (!encryptedData.version || encryptedData.version < 2)
    ? PBKDF2_ITERATIONS_LEGACY
    : PBKDF2_ITERATIONS;

  const encrypted = Uint8Array.from(atob(encryptedData.encrypted), c => c.charCodeAt(0));
  const iv = Uint8Array.from(atob(encryptedData.iv), c => c.charCodeAt(0));
  const salt = Uint8Array.from(atob(encryptedData.salt), c => c.charCodeAt(0));

  const key = await deriveKey(password, salt, iterations);

  try {
    const decrypted = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv },
      key,
      encrypted
    );
    return decoder.decode(decrypted);
  } catch (e) {
    throw new Error('Decryption failed - incorrect password');
  }
}

// A version 3 vault is bound to its label: the label is the AES-GCM
// additional data, so rewriting "3" to "2" makes the vault fail to open
// under that label instead of quietly reading as an older one.
const VAULT_V3_AAD = new TextEncoder().encode('IronDivi vault v3');
const VAULT_V4_AAD = new TextEncoder().encode('IronDivi vault v4');
const VAULT_V4_PRF_KEY_INFO = new TextEncoder().encode('IronDivi vault v4 prf-key');
const DEK_LENGTH = 32;

export const b64 = (bytes: Uint8Array): string => btoa(String.fromCharCode(...bytes));
export const unb64 = (text: string): Uint8Array<ArrayBuffer> => Uint8Array.from(atob(text), c => c.charCodeAt(0));

export function b64url(bytes: Uint8Array): string {
  return b64(bytes).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function unb64url(text: string): Uint8Array<ArrayBuffer> {
  if (typeof text !== 'string' || !/^[A-Za-z0-9_-]+={0,2}$/.test(text)) {
    throw new Error('Invalid base64url value');
  }
  const normalized = text.replace(/-/g, '+').replace(/_/g, '/');
  const padded = normalized + '='.repeat((4 - (normalized.length % 4)) % 4);
  return unb64(padded);
}

export interface VaultV4SlotPassword {
  id: string; // e.g. "slot-pass"
  kind: 'password';
  kdf: { alg: 'pbkdf2'; hash: 'SHA-256'; iterations: 600000; salt: string }; // base64 16B
  iv: string; // base64 12B
  wrappedDek: string; // base64 (32B ciphertext + 16B GCM tag)
}

export interface VaultV4SlotPasskey {
  id: string; // e.g. "slot-pk-<hex>"
  kind: 'prf';
  label: string; // e.g. "Passkey 1" or user label
  credentialId: string; // base64url
  prfSalt: string; // base64url 32B
  iv: string; // base64 12B
  wrappedDek: string; // base64 (32B ciphertext + 16B GCM tag)
  createdAt: number;
}

export interface VaultV4Doc {
  version: 4;
  iv: string; // base64 12B
  encryptedPayload: string; // base64 AES-256-GCM ciphertext of JSON.stringify({ m: mnemonic, k?: recordsKey })
  slots: Array<VaultV4SlotPassword | VaultV4SlotPasskey>;
}

export interface PasskeyAuthPayload {
  credentialId: string; // base64url
  prfOutput: string; // base64url 32B
}

export function isVaultV4Doc(v: unknown): v is VaultV4Doc {
  if (typeof v !== 'object' || v === null) return false;
  const doc = v as Partial<VaultV4Doc>;
  return typeof doc.encryptedPayload === 'string' &&
    typeof doc.iv === 'string' &&
    Array.isArray(doc.slots);
}

/** Invariant [P1]: every VaultV4Doc must retain its password slot */
export function assertHasPasswordSlot(doc: VaultV4Doc): VaultV4SlotPassword {
  const passSlot = doc.slots.find((s): s is VaultV4SlotPassword => s?.kind === 'password');
  if (!passSlot) {
    throw new Error('Vault v4 document is missing its required password slot');
  }
  return passSlot;
}

function vaultV4SlotAad(slotId: string): Uint8Array {
  return new TextEncoder().encode(`IronDivi vault v4 slot ${slotId}`);
}

export async function encryptVaultV4Payload(
  dek: Uint8Array,
  plaintext: string,
): Promise<{ iv: string; encryptedPayload: string }> {
  if (dek.byteLength !== DEK_LENGTH) throw new Error('Invalid DEK length');
  const iv = crypto.getRandomValues(new Uint8Array(IV_LENGTH));
  const dekKey = await crypto.subtle.importKey(
    'raw',
    dek as BufferSource,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt'],
  );
  const ct = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv, additionalData: VAULT_V4_AAD },
    dekKey,
    new TextEncoder().encode(plaintext),
  );
  return { iv: b64(iv), encryptedPayload: b64(new Uint8Array(ct)) };
}

export async function decryptVaultV4Payload(
  dek: Uint8Array,
  ivB64: string,
  encryptedPayloadB64: string,
): Promise<string> {
  if (dek.byteLength !== DEK_LENGTH) throw new Error('Invalid DEK length');
  const iv = unb64(ivB64);
  const ct = unb64(encryptedPayloadB64);
  const dekKey = await crypto.subtle.importKey(
    'raw',
    dek as BufferSource,
    { name: 'AES-GCM', length: 256 },
    false,
    ['decrypt'],
  );
  const pt = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: iv as BufferSource, additionalData: VAULT_V4_AAD },
    dekKey,
    ct as BufferSource,
  );
  return new TextDecoder().decode(pt);
}

export async function wrapDekWithPassword(
  dek: Uint8Array,
  password: string,
  slotId = 'slot-pass',
): Promise<VaultV4SlotPassword> {
  if (dek.byteLength !== DEK_LENGTH) throw new Error('Invalid DEK length');
  const salt = crypto.getRandomValues(new Uint8Array(SALT_LENGTH));
  const iv = crypto.getRandomValues(new Uint8Array(IV_LENGTH));
  const slotKey = await deriveKey(password, salt, PBKDF2_ITERATIONS);
  const wrapped = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv, additionalData: vaultV4SlotAad(slotId) as BufferSource },
    slotKey,
    dek as BufferSource,
  );
  return {
    id: slotId,
    kind: 'password',
    kdf: { alg: 'pbkdf2', hash: 'SHA-256', iterations: PBKDF2_ITERATIONS, salt: b64(salt) },
    iv: b64(iv),
    wrappedDek: b64(new Uint8Array(wrapped)),
  };
}

export async function unwrapDekWithPassword(
  slot: VaultV4SlotPassword,
  password: string,
): Promise<Uint8Array> {
  if (
    slot.kind !== 'password' ||
    slot.kdf?.alg !== 'pbkdf2' ||
    slot.kdf?.hash !== 'SHA-256' ||
    slot.kdf?.iterations !== PBKDF2_ITERATIONS
  ) {
    throw new Error('Decryption failed - invalid password slot');
  }
  const salt = unb64(slot.kdf.salt);
  const iv = unb64(slot.iv);
  const wrapped = unb64(slot.wrappedDek);
  if (salt.byteLength !== SALT_LENGTH || iv.byteLength !== IV_LENGTH) {
    throw new Error('Decryption failed - malformed password slot');
  }
  const slotKey = await deriveKey(password, salt, PBKDF2_ITERATIONS);
  try {
    const raw = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: iv as BufferSource, additionalData: vaultV4SlotAad(slot.id) as BufferSource },
      slotKey,
      wrapped as BufferSource,
    );
    const dek = new Uint8Array(raw);
    if (dek.byteLength !== DEK_LENGTH) {
      secureWipe(dek);
      throw new Error('Decryption failed - invalid DEK length');
    }
    return dek;
  } catch {
    throw new Error('Decryption failed - incorrect password');
  }
}

export async function derivePrfSlotKey(prfOutput: Uint8Array, slotId: string): Promise<CryptoKey> {
  if (!(prfOutput instanceof Uint8Array) || prfOutput.byteLength !== 32) {
    throw new Error('Passkey PRF output must be 32 bytes');
  }
  const ikmKey = await crypto.subtle.importKey(
    'raw',
    prfOutput as BufferSource,
    'HKDF',
    false,
    ['deriveBits'],
  );
  const wrappingKeyBuf = await crypto.subtle.deriveBits(
    {
      name: 'HKDF',
      hash: 'SHA-256',
      salt: new Uint8Array(0),
      info: VAULT_V4_PRF_KEY_INFO,
    },
    ikmKey,
    256,
  );
  const wrappingKeyBits = new Uint8Array(wrappingKeyBuf);
  try {
    const wkKey = await crypto.subtle.importKey(
      'raw',
      wrappingKeyBits as BufferSource,
      'HKDF',
      false,
      ['deriveKey'],
    );
    return await crypto.subtle.deriveKey(
      {
        name: 'HKDF',
        hash: 'SHA-256',
        salt: new Uint8Array(0),
        info: vaultV4SlotAad(slotId) as BufferSource,
      },
      wkKey,
      { name: 'AES-GCM', length: 256 },
      false,
      ['encrypt', 'decrypt'],
    );
  } finally {
    secureWipe(wrappingKeyBits);
  }
}

export function generatePasskeySlotId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(8));
  return 'slot-pk-' + Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('');
}

export async function wrapDekWithPrf(
  dek: Uint8Array,
  opts: {
    id?: string;
    label: string;
    credentialId: string;
    prfSalt: string;
    prfOutput: Uint8Array;
    createdAt?: number;
  },
): Promise<VaultV4SlotPasskey> {
  if (dek.byteLength !== DEK_LENGTH) throw new Error('Invalid DEK length');
  if (unb64url(opts.credentialId).byteLength === 0) throw new Error('Invalid credentialId');
  if (unb64url(opts.prfSalt).byteLength !== 32) throw new Error('Passkey PRF salt must be 32 bytes');
  const id = opts.id ?? generatePasskeySlotId();
  const iv = crypto.getRandomValues(new Uint8Array(IV_LENGTH));
  const slotKey = await derivePrfSlotKey(opts.prfOutput, id);
  const wrapped = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv, additionalData: vaultV4SlotAad(id) as BufferSource },
    slotKey,
    dek as BufferSource,
  );
  return {
    id,
    kind: 'prf',
    label: opts.label.trim() || 'Passkey',
    credentialId: opts.credentialId,
    prfSalt: opts.prfSalt,
    iv: b64(iv),
    wrappedDek: b64(new Uint8Array(wrapped)),
    createdAt: opts.createdAt ?? Date.now(),
  };
}

export async function unwrapDekWithPrf(
  slot: VaultV4SlotPasskey,
  prfOutput: Uint8Array,
): Promise<Uint8Array> {
  if (slot.kind !== 'prf') throw new Error('Decryption failed - invalid passkey slot');
  const iv = unb64(slot.iv);
  const wrapped = unb64(slot.wrappedDek);
  if (iv.byteLength !== IV_LENGTH) throw new Error('Decryption failed - malformed passkey slot');
  const slotKey = await derivePrfSlotKey(prfOutput, slot.id);
  try {
    const raw = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: iv as BufferSource, additionalData: vaultV4SlotAad(slot.id) as BufferSource },
      slotKey,
      wrapped as BufferSource,
    );
    const dek = new Uint8Array(raw);
    if (dek.byteLength !== DEK_LENGTH) {
      secureWipe(dek);
      throw new Error('Decryption failed - invalid DEK length');
    }
    return dek;
  } catch {
    throw new Error('Decryption failed - passkey verification failed');
  }
}

export async function decryptVaultV4WithPassword(
  doc: VaultV4Doc,
  password: string,
): Promise<{ plaintext: string; version: 4; relabeled: boolean }> {
  const passSlot = assertHasPasswordSlot(doc);
  const dek = await unwrapDekWithPassword(passSlot, password);
  try {
    const plaintext = await decryptVaultV4Payload(dek, doc.iv, doc.encryptedPayload);
    return { plaintext, version: 4, relabeled: doc.version !== 4 };
  } catch {
    throw new Error('Decryption failed - incorrect password');
  } finally {
    secureWipe(dek);
  }
}

/** Encrypt as a version 3 vault: 600K iterations, label-bound */
export async function encryptVault(data: string, password: string): Promise<{
  encrypted: string;
  iv: string;
  salt: string;
  version: number;
}> {
  const salt = crypto.getRandomValues(new Uint8Array(SALT_LENGTH));
  const iv = crypto.getRandomValues(new Uint8Array(IV_LENGTH));
  const key = await deriveKey(password, salt, PBKDF2_ITERATIONS);
  const encrypted = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv, additionalData: VAULT_V3_AAD },
    key,
    new TextEncoder().encode(data)
  );
  return { encrypted: b64(new Uint8Array(encrypted)), iv: b64(iv), salt: b64(salt), version: 3 };
}

/**
 * Open a vault of any version (v1, v2, v3, or v4). `version` is the version
 * the vault really is, found by which way it opens; `relabeled` says its
 * stored label was changed (a version 3/4 vault labelled older, or reverse).
 */
export async function decryptVault(
  vault: { encrypted: string; iv: string; salt: string; version?: number } | VaultV4Doc,
  password: string
): Promise<{ plaintext: string; version: number; relabeled: boolean }> {
  if (isVaultV4Doc(vault)) {
    return decryptVaultV4WithPassword(vault, password);
  }
  const label = vault.version ?? 1;
  const encrypted = unb64(vault.encrypted);
  const iv = unb64(vault.iv);
  const salt = unb64(vault.salt);
  const keys = new Map<number, Promise<CryptoKey>>();
  const keyFor = (iterations: number) => {
    if (!keys.has(iterations)) keys.set(iterations, deriveKey(password, salt, iterations));
    return keys.get(iterations)!;
  };
  // Each real version, its iterations and whether it is label-bound
  const ways = [
    { version: 3, iterations: PBKDF2_ITERATIONS, aad: true },
    { version: 2, iterations: PBKDF2_ITERATIONS, aad: false },
    { version: 1, iterations: PBKDF2_ITERATIONS_LEGACY, aad: false },
  ];
  const labelled = label >= 3 ? 3 : label >= 2 ? 2 : 1;
  // The labelled way first: with the right password and an untouched label
  // it is the only one tried
  ways.sort((a, b) => Number(b.version === labelled) - Number(a.version === labelled));
  for (const way of ways) {
    try {
      const params: AesGcmParams = way.aad ? { name: 'AES-GCM', iv, additionalData: VAULT_V3_AAD } : { name: 'AES-GCM', iv };
      const decrypted = await crypto.subtle.decrypt(params, await keyFor(way.iterations), encrypted);
      return { plaintext: new TextDecoder().decode(decrypted), version: way.version, relabeled: way.version !== labelled };
    } catch {
      // Try the next way
    }
  }
  throw new Error('Decryption failed - incorrect password');
}

// Generate UUID v4
export function generateId(): string {
  return crypto.randomUUID();
}

/**
 * SecureString provides defense-in-depth for sensitive data.
 * WARNING: JavaScript string interning means any string created from toString()
 * cannot be wiped from memory. This class only protects the Uint8Array storage,
 * not string copies that may exist in the V8 heap.
 */
export class SecureString {
  private data: Uint8Array;

  constructor(str: string) {
    this.data = new TextEncoder().encode(str);
  }

  toString(): string {
    return new TextDecoder().decode(this.data);
  }

  wipe(): void {
    secureWipe(this.data);
  }
}

/**
 * Securely wipe a Uint8Array by overwriting with random then zeros
 */
export function secureWipe(arr: Uint8Array): void {
  crypto.getRandomValues(arr);
  arr.fill(0);
}
