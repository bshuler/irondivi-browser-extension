import { beforeEach, describe, expect, it, vi } from 'vitest';
import { deriveKey, PBKDF2_ITERATIONS_LEGACY } from './crypto-utils';

// Regression tests for the security review's M8: a legacy secret was
// re-encrypted in the background without being awaited, writing back a copy
// of the whole secrets map read before the slow re-encryption

vi.setConfig({ testTimeout: 30000 });

const PHRASE = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
const OTHER = 'zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo wrong';
const PASSWORD = 'correct horse battery staple';

let local: Record<string, any>;
let failWrites = false;
let store: typeof import('./storage');

const b64 = (a: Uint8Array) => btoa(String.fromCharCode(...a));

// A secret as 0.0.1 wrote it: 100K iterations, no version
async function legacyBlob(text: string, password: string) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await deriveKey(password, salt, PBKDF2_ITERATIONS_LEGACY);
  const enc = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, new TextEncoder().encode(text));
  return { encrypted: b64(new Uint8Array(enc)), iv: b64(iv), salt: b64(salt) };
}

beforeEach(async () => {
  vi.resetModules();
  local = {};
  failWrites = false;
  (globalThis as any).chrome = {
    runtime: { onMessage: { addListener() {} } },
    storage: {
      local: {
        get: (keys: string | string[], cb: (r: any) => void) => {
          const out: Record<string, any> = {};
          for (const k of Array.isArray(keys) ? keys : [keys]) if (k in local) out[k] = structuredClone(local[k]);
          cb(out);
        },
        set: (items: Record<string, any>, cb: () => void) => {
          if (failWrites) throw new Error('disk full');
          for (const [k, v] of Object.entries(items)) local[k] = structuredClone(v);
          cb();
        },
        remove: (keys: string | string[], cb: () => void) => {
          for (const k of Array.isArray(keys) ? keys : [keys]) delete local[k];
          cb();
        },
      },
    },
  };
  store = await import('./storage');
  local.secrets = { a: await legacyBlob(PHRASE, PASSWORD) };
});

describe('M8 a legacy secret is upgraded safely', () => {
  it('the upgrade has finished, and opens, by the time the phrase is returned', async () => {
    expect(await store.getDecryptedSecret('a', PASSWORD)).toBe(PHRASE);
    expect(local.secrets.a.version).toBe(2);
    expect(await store.getDecryptedSecret('a', PASSWORD)).toBe(PHRASE);
  });

  it('a secret deleted while the upgrade runs stays deleted', async () => {
    const migrating = store.migrateSecret('a', PASSWORD);
    await store.deleteSecret('a');
    await migrating;
    expect(local.secrets.a).toBeUndefined();
  });

  it('a secret added while the upgrade runs is kept', async () => {
    const unlocking = store.getDecryptedSecret('a', PASSWORD);
    await store.saveSecret('b', OTHER, PASSWORD);
    await unlocking;
    expect(local.secrets.a.version).toBe(2);
    expect(await store.getDecryptedSecret('b', PASSWORD)).toBe(OTHER);
  });

  it('a secret replaced while the upgrade runs is not put back', async () => {
    const migrating = store.migrateSecret('a', PASSWORD);
    await store.saveSecret('a', OTHER, PASSWORD);
    await migrating;
    expect(await store.getDecryptedSecret('a', PASSWORD)).toBe(OTHER);
  });

  it('a wrong password changes nothing', async () => {
    const before = structuredClone(local.secrets.a);
    await expect(store.getDecryptedSecret('a', 'wrong')).rejects.toThrow();
    await expect(store.migrateSecret('a', 'wrong')).rejects.toThrow();
    expect(local.secrets.a).toEqual(before);
  });

  it('a failed write leaves the legacy secret in place and the wallet still opens', async () => {
    const before = structuredClone(local.secrets.a);
    failWrites = true;
    expect(await store.getDecryptedSecret('a', PASSWORD)).toBe(PHRASE);
    expect(local.secrets.a).toEqual(before);
    failWrites = false;
    expect(await store.getDecryptedSecret('a', PASSWORD)).toBe(PHRASE);
    expect(local.secrets.a.version).toBe(2);
  });

  it('a failed write does not jam later changes', async () => {
    failWrites = true;
    await expect(store.deleteSecret('a')).rejects.toThrow();
    failWrites = false;
    await store.deleteSecret('a');
    expect(local.secrets.a).toBeUndefined();
  });
});
