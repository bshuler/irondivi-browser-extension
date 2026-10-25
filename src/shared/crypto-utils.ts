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

const b64 = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes));
const unb64 = (text: string) => Uint8Array.from(atob(text), c => c.charCodeAt(0));

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
 * Open a vault of any version. `version` is the version the vault really is,
 * found by which way it opens; `relabeled` says its stored label was changed
 * (a version 3 vault labelled older, or the reverse).
 */
export async function decryptVault(
  vault: { encrypted: string; iv: string; salt: string; version?: number },
  password: string
): Promise<{ plaintext: string; version: number; relabeled: boolean }> {
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
