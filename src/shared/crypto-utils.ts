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

// Generate ephemeral session key for signing sessions
export async function generateSessionKey(): Promise<CryptoKey> {
  return crypto.subtle.generateKey(
    { name: 'AES-GCM', length: 256 },
    true,
    ['encrypt', 'decrypt']
  );
}

export async function encryptWithKey(data: string, key: CryptoKey): Promise<{
  encrypted: string;
  iv: string;
}> {
  const encoder = new TextEncoder();
  const iv = crypto.getRandomValues(new Uint8Array(IV_LENGTH));

  const encrypted = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv },
    key,
    encoder.encode(data)
  );

  return {
    encrypted: btoa(String.fromCharCode(...new Uint8Array(encrypted))),
    iv: btoa(String.fromCharCode(...iv)),
  };
}

export async function decryptWithKey(
  encryptedData: { encrypted: string; iv: string },
  key: CryptoKey
): Promise<string> {
  const decoder = new TextDecoder();

  const encrypted = Uint8Array.from(atob(encryptedData.encrypted), c => c.charCodeAt(0));
  const iv = Uint8Array.from(atob(encryptedData.iv), c => c.charCodeAt(0));

  const decrypted = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv },
    key,
    encrypted
  );

  return decoder.decode(decrypted);
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

// Fixed salt for wrapping key derivation - not secret, provides domain separation
const WRAPPING_KEY_SALT = new Uint8Array([
  0x70, 0x64, 0x69, 0x76, 0x69, 0x2d, 0x73, 0x65,
  0x73, 0x73, 0x69, 0x6f, 0x6e, 0x2d, 0x77, 0x6b,
]);

/**
 * Derive an AES-KW wrapping key from a stable identifier (e.g. extension ID).
 * The wrapping key is not secret from the user - it just prevents storing raw
 * key material and provides a consistent encryption layer for persisted session keys.
 */
async function getWrappingKey(identifier: string): Promise<CryptoKey> {
  const encoder = new TextEncoder();
  const baseKey = await crypto.subtle.importKey(
    'raw',
    encoder.encode(identifier),
    'PBKDF2',
    false,
    ['deriveKey']
  );
  return crypto.subtle.deriveKey(
    {
      name: 'PBKDF2',
      salt: WRAPPING_KEY_SALT,
      iterations: PBKDF2_ITERATIONS,
      hash: 'SHA-256',
    },
    baseKey,
    { name: 'AES-KW', length: 256 },
    false,
    ['wrapKey', 'unwrapKey']
  );
}

/**
 * Wrap (export + encrypt) a session CryptoKey using AES-KW keyed from identifier.
 * Returns a base64-encoded wrapped key string.
 */
export async function wrapSessionKey(key: CryptoKey, identifier: string): Promise<string> {
  const wrappingKey = await getWrappingKey(identifier);
  const wrapped = await crypto.subtle.wrapKey('raw', key, wrappingKey, 'AES-KW');
  return btoa(String.fromCharCode(...new Uint8Array(wrapped)));
}

/**
 * Unwrap a base64-encoded wrapped session key back into a CryptoKey.
 */
export async function unwrapSessionKey(wrapped: string, identifier: string): Promise<CryptoKey> {
  const wrappingKey = await getWrappingKey(identifier);
  const wrappedBytes = Uint8Array.from(atob(wrapped), c => c.charCodeAt(0));
  return crypto.subtle.unwrapKey(
    'raw',
    wrappedBytes,
    wrappingKey,
    'AES-KW',
    { name: 'AES-GCM', length: 256 },
    true,
    ['encrypt', 'decrypt']
  );
}
