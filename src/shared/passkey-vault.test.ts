import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  assertHasPasswordSlot,
  b64,
  b64url,
  decryptVault,
  isVaultV4Doc,
  unb64,
  unwrapDekWithPrf,
  wrapDekWithPrf,
  type VaultV4Doc,
  type VaultV4SlotPasskey,
} from './crypto-utils';

vi.setConfig({ testTimeout: 60000 });

const PHRASE = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
const PASSWORD = 'VaultV4-Test-Password-99!';

let local: Record<string, any>;
let store: typeof import('./storage');

function randomB64Url(len = 32): string {
  return b64url(crypto.getRandomValues(new Uint8Array(len)));
}

beforeEach(async () => {
  vi.resetModules();
  local = {};
  (globalThis as any).chrome = {
    runtime: { onMessage: { addListener() {} } },
    storage: {
      local: {
        get: (keys: string | string[], cb: (r: any) => void) => {
          const out: Record<string, any> = {};
          for (const k of Array.isArray(keys) ? keys : [keys]) {
            if (k in local) out[k] = structuredClone(local[k]);
          }
          cb(out);
        },
        set: (items: Record<string, any>, cb: () => void) => {
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
});

describe('Vault v4 Envelope & WebAuthn PRF Key-Wrapping', () => {
  it('keeps password-only accounts at v2/v3 until a passkey is enrolled, then upgrades to v4', async () => {
    await store.saveSecret('acc-v2', PHRASE, PASSWORD);
    expect(local.secrets['acc-v2'].version).toBe(2);
    expect(isVaultV4Doc(local.secrets['acc-v2'])).toBe(false);

    const recordsKey = b64(crypto.getRandomValues(new Uint8Array(32)));
    await store.saveSecret('acc-v3', PHRASE, PASSWORD, recordsKey);
    expect(local.secrets['acc-v3'].version).toBe(3);
    expect(isVaultV4Doc(local.secrets['acc-v3'])).toBe(false);

    const credId = randomB64Url(24);
    const prfSalt = randomB64Url(32);
    const prfOut = randomB64Url(32);

    const slot = await store.addPasskeySlot('acc-v3', PASSWORD, {
      label: 'Touch ID Mac',
      credentialId: credId,
      prfSalt,
      prfOutputB64Url: prfOut,
    });

    const v4 = local.secrets['acc-v3'] as VaultV4Doc;
    expect(isVaultV4Doc(v4)).toBe(true);
    expect(v4.version).toBe(4);
    expect(v4.slots).toHaveLength(2);
    expect(v4.slots.some(s => s.kind === 'password')).toBe(true);
    expect(v4.slots.some(s => s.kind === 'prf' && s.id === slot.id)).toBe(true);

    // Public metadata returned by getPasskeySlots never exposes wrappedDek or iv
    const publicSlots = await store.getPasskeySlots('acc-v3');
    expect(publicSlots).toEqual([
      {
        id: slot.id,
        label: 'Touch ID Mac',
        credentialId: credId,
        prfSalt,
        createdAt: slot.createdAt,
      },
    ]);
    expect('wrappedDek' in (publicSlots[0] as any)).toBe(false);
    expect('iv' in (publicSlots[0] as any)).toBe(false);

    // Both password and passkey open the identical mnemonic + recordsKey
    const openedByPw = await store.openSecret('acc-v3', PASSWORD);
    expect(openedByPw.mnemonic).toBe(PHRASE);
    expect(openedByPw.recordsKey).toBe(recordsKey);
    expect(openedByPw.legacy).toBe(false);
    expect(openedByPw.relabeled).toBe(false);

    const openedByPk = await store.openSecretWithPasskey('acc-v3', credId, prfOut);
    expect(openedByPk.mnemonic).toBe(PHRASE);
    expect(openedByPk.recordsKey).toBe(recordsKey);
    expect(openedByPk.slotId).toBe(slot.id);
    expect(openedByPk.legacy).toBe(false);
    expect(openedByPk.relabeled).toBe(false);
  });

  it('supports multiple passkeys wrapping the same DEK and enforces [P1] password-slot retention', async () => {
    const recordsKey = b64(crypto.getRandomValues(new Uint8Array(32)));
    await store.saveSecret('acc-multi', PHRASE, PASSWORD, recordsKey);

    const cred1 = randomB64Url(24);
    const prf1 = randomB64Url(32);
    const slot1 = await store.addPasskeySlot('acc-multi', PASSWORD, {
      label: 'MacBook Touch ID',
      credentialId: cred1,
      prfSalt: randomB64Url(32),
      prfOutputB64Url: prf1,
    });

    const payloadBefore = local.secrets['acc-multi'].encryptedPayload;

    const cred2 = randomB64Url(24);
    const prf2 = randomB64Url(32);
    const slot2 = await store.addPasskeySlot('acc-multi', PASSWORD, {
      label: 'YubiKey Bio',
      credentialId: cred2,
      prfSalt: randomB64Url(32),
      prfOutputB64Url: prf2,
    });

    // Adding a second passkey wraps the existing DEK without re-encrypting payload
    expect(local.secrets['acc-multi'].encryptedPayload).toBe(payloadBefore);
    expect(await store.getPasskeySlots('acc-multi')).toHaveLength(2);

    expect((await store.openSecretWithPasskey('acc-multi', cred1, prf1)).mnemonic).toBe(PHRASE);
    expect((await store.openSecretWithPasskey('acc-multi', cred2, prf2)).mnemonic).toBe(PHRASE);
    expect((await store.openSecret('acc-multi', PASSWORD)).mnemonic).toBe(PHRASE);

    // [P1]: Cannot remove the password slot
    const passSlot = assertHasPasswordSlot(local.secrets['acc-multi']);
    await expect(store.removePasskeySlot('acc-multi', PASSWORD, passSlot.id)).rejects.toThrow(
      /password slot/i,
    );

    // Can remove slot1 using slot2's passkey auth; slot2 and password remain valid
    await store.removePasskeySlot('acc-multi', { credentialId: cred2, prfOutput: prf2 }, slot1.id);
    await expect(store.openSecretWithPasskey('acc-multi', cred1, prf1)).rejects.toThrow();
    expect((await store.openSecretWithPasskey('acc-multi', cred2, prf2)).mnemonic).toBe(PHRASE);

    // Can remove the final passkey slot; password slot still opens the vault
    await store.removePasskeySlot('acc-multi', PASSWORD, slot2.id);
    expect(await store.getPasskeySlots('acc-multi')).toHaveLength(0);
    expect((await store.openSecret('acc-multi', PASSWORD)).mnemonic).toBe(PHRASE);

    // Tampering storage to strip the password slot fails loudly on both open paths
    local.secrets['acc-multi'].slots = [];
    expect(() => assertHasPasswordSlot(local.secrets['acc-multi'])).toThrow(/password slot/i);
    await expect(store.openSecret('acc-multi', PASSWORD)).rejects.toThrow(/password slot/i);
    await expect(store.openSecretWithPasskey('acc-multi', cred2, prf2)).rejects.toThrow(/password slot/i);
  });

  it('enforces HKDF slot domain separation and AES-GCM AAD integrity on payload and slots', async () => {
    const dek = crypto.getRandomValues(new Uint8Array(32));
    const prfBytes = crypto.getRandomValues(new Uint8Array(32));
    const slot = await wrapDekWithPrf(dek, {
      id: 'slot-pk-original',
      label: 'Test Key',
      credentialId: randomB64Url(20),
      prfSalt: randomB64Url(32),
      prfOutput: prfBytes,
    });

    const unwrapped = await unwrapDekWithPrf(slot, prfBytes);
    expect(b64(unwrapped)).toBe(b64(dek));

    // Wrong 32B PRF secret fails unwrap
    const wrongPrf = crypto.getRandomValues(new Uint8Array(32));
    await expect(unwrapDekWithPrf(slot, wrongPrf)).rejects.toThrow(/passkey verification failed/i);

    // Renaming slot.id breaks both HKDF info ("IronDivi vault v4 slot <id>") and GCM AAD
    const renamedSlot: VaultV4SlotPasskey = { ...slot, id: 'slot-pk-swapped' };
    await expect(unwrapDekWithPrf(renamedSlot, prfBytes)).rejects.toThrow(/passkey verification failed/i);

    // Tampering ciphertext or version on a stored Vault v4 document is caught
    const recordsKey = b64(crypto.getRandomValues(new Uint8Array(32)));
    await store.saveSecret('acc-tamper', PHRASE, PASSWORD, recordsKey);
    const cred = randomB64Url(20);
    const prfOut = b64url(prfBytes);
    await store.addPasskeySlot('acc-tamper', PASSWORD, {
      label: 'Key',
      credentialId: cred,
      prfSalt: randomB64Url(32),
      prfOutputB64Url: prfOut,
    });

    // Relabeling version 4 -> 2 is flagged as relabeled: true
    local.secrets['acc-tamper'].version = 2;
    expect((await store.openSecret('acc-tamper', PASSWORD)).relabeled).toBe(true);
    expect((await store.openSecretWithPasskey('acc-tamper', cred, prfOut)).relabeled).toBe(true);
    local.secrets['acc-tamper'].version = 4;

    // Flipping 1 bit in encryptedPayload fails GCM tag verification
    const rawPayload = unb64(local.secrets['acc-tamper'].encryptedPayload);
    rawPayload[0] ^= 0x01;
    local.secrets['acc-tamper'].encryptedPayload = b64(rawPayload);
    await expect(decryptVault(local.secrets['acc-tamper'], PASSWORD)).rejects.toThrow();
    await expect(store.openSecretWithPasskey('acc-tamper', cred, prfOut)).rejects.toThrow();
  });

  it('preserves existing DEK and all passkey slots when storeRecordsKey / storeRecordsKeyViaPasskey updates recordsKey', async () => {
    const rk1 = b64(crypto.getRandomValues(new Uint8Array(32)));
    const rk2 = b64(crypto.getRandomValues(new Uint8Array(32)));
    const rk3 = b64(crypto.getRandomValues(new Uint8Array(32)));

    await store.saveSecret('acc-rk', PHRASE, PASSWORD, rk1);
    const cred = randomB64Url(24);
    const prfOut = randomB64Url(32);
    const slot = await store.addPasskeySlot('acc-rk', PASSWORD, {
      label: 'Passkey RK',
      credentialId: cred,
      prfSalt: randomB64Url(32),
      prfOutputB64Url: prfOut,
    });

    const beforePwUpdate = structuredClone(local.secrets['acc-rk']) as VaultV4Doc;
    const prfWrappedBefore = (beforePwUpdate.slots.find(s => s.id === slot.id) as VaultV4SlotPasskey).wrappedDek;

    // Update recordsKey via password: fresh payload IV, identical wrappedDek on PRF slot!
    await store.storeRecordsKey('acc-rk', PASSWORD, PHRASE, rk2, beforePwUpdate);
    const afterPwUpdate = local.secrets['acc-rk'] as VaultV4Doc;
    expect(afterPwUpdate.iv).not.toBe(beforePwUpdate.iv);
    expect((afterPwUpdate.slots.find(s => s.id === slot.id) as VaultV4SlotPasskey).wrappedDek).toBe(prfWrappedBefore);

    const viaPkAfterPw = await store.openSecretWithPasskey('acc-rk', cred, prfOut);
    expect(viaPkAfterPw.mnemonic).toBe(PHRASE);
    expect(viaPkAfterPw.recordsKey).toBe(rk2);

    // Update recordsKey via passkey: password slot and PRF slot both open rk3!
    await store.storeRecordsKeyViaPasskey(
      'acc-rk',
      { credentialId: cred, prfOutput: prfOut },
      PHRASE,
      rk3,
      afterPwUpdate,
    );
    expect((await store.openSecret('acc-rk', PASSWORD)).recordsKey).toBe(rk3);
    expect((await store.openSecretWithPasskey('acc-rk', cred, prfOut)).recordsKey).toBe(rk3);
  });
});
