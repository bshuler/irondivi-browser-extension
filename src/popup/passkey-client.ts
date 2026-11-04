import { MSG, sendMessage, type PasskeyAuthInput } from '../shared/constants';
import { b64url, unb64url, secureWipe } from '../shared/crypto-utils';
import type { PasskeySlotInfo } from '../shared/storage';

export const PRF_UNSUPPORTED_ERROR =
  'This passkey provider does not support encryption (WebAuthn PRF). Try Touch ID, Windows Hello, iCloud Keychain, Google Password Manager, or a FIDO2 security key.';

function toUint8Array(buf: unknown): Uint8Array | null {
  if (buf instanceof ArrayBuffer) {
    return new Uint8Array(buf);
  }
  if (ArrayBuffer.isView(buf)) {
    return new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
  }
  return null;
}

function normalizeWebAuthnError(err: unknown): Error {
  if (err instanceof Error) {
    if (err.message === PRF_UNSUPPORTED_ERROR) return err;
    if (err.name === 'NotAllowedError') {
      return new Error('Passkey verification was cancelled or timed out.');
    }
    if (err.name === 'InvalidStateError') {
      return new Error('This passkey is already registered on this device.');
    }
    if (err.name === 'NotSupportedError' || err.name === 'SecurityError') {
      return new Error(PRF_UNSUPPORTED_ERROR);
    }
    return err;
  }
  return new Error('Passkey operation failed');
}

/**
 * True only when running inside the transient browser action toolbar bubble,
 * which Chromium/Safari/Firefox close as soon as an OS Touch ID / Windows Hello
 * dialog blurs the bubble. Returns false in tabs, standalone approval windows,
 * and passkey.html itself.
 */
export async function isTransientToolbarPopup(): Promise<boolean> {
  if (typeof window === 'undefined') return false;
  if (window.location.pathname.endsWith('/passkey.html')) return false;
  const params = new URLSearchParams(window.location.search);
  if (params.get('ceremonyWindow') === '1') return true;
  if (params.has('approve') || params.has('mode') || params.get('window') === '1') {
    return false;
  }
  try {
    if (typeof chrome !== 'undefined' && chrome.tabs?.getCurrent) {
      const tab = await chrome.tabs.getCurrent();
      return !tab;
    }
  } catch {
    // Fallback to inline if tabs API unavailable
  }
  return false;
}

export async function openPasskeyCeremonyWindow(query: Record<string, string>): Promise<void> {
  const qs = new URLSearchParams(query).toString();
  const url = chrome.runtime.getURL(`passkey.html?${qs}`);
  const width = 400;
  const height = 480;
  let left = 120;
  let top = 120;
  try {
    const wins = await chrome.windows.getAll({ windowTypes: ['normal'] });
    if (wins.length > 0) {
      const ref = wins[0];
      left = Math.round((ref.left || 0) + ((ref.width || 800) - width) / 2);
      top = Math.round((ref.top || 0) + ((ref.height || 600) - height) / 2);
    }
  } catch {
    // Default coordinates
  }
  await chrome.windows.create({
    url,
    type: 'popup',
    width,
    height,
    left,
    top,
    focused: true,
  });
}

export async function fetchPasskeySlots(accountId?: string): Promise<PasskeySlotInfo[]> {
  if (typeof chrome === 'undefined' || !chrome.runtime?.sendMessage) {
    return [];
  }
  try {
    const res = await sendMessage({
      type: MSG.GET_PASSKEY_SLOTS,
      payload: accountId ? { accountId } : {},
    });
    if (!res?.success) return [];
    const data = res.data as { slots?: PasskeySlotInfo[] } | undefined;
    return Array.isArray(data?.slots) ? data.slots : [];
  } catch {
    return [];
  }
}

/**
 * Enrol a new WebAuthn passkey in the current window and immediately run an
 * assertion with a fresh 32-byte PRF salt to confirm the authenticator produces
 * a 32-byte PRF secret before saving.
 * Never overrides rp.id / rpId so the browser binds to the extension origin.
 */
export async function createAndVerifyPasskeyInWindow(opts: {
  accountName: string;
  label: string;
  existingCredentialIds?: string[];
}): Promise<{
  credentialId: string;
  prfSalt: string;
  prfOutput: string;
}> {
  if (typeof navigator === 'undefined' || !navigator.credentials?.create || !navigator.credentials?.get) {
    throw new Error(PRF_UNSUPPORTED_ERROR);
  }

  const createChallenge = crypto.getRandomValues(new Uint8Array(32));
  const userHandle = crypto.getRandomValues(new Uint8Array(32));
  const excludeCredentials: PublicKeyCredentialDescriptor[] = (opts.existingCredentialIds ?? []).map(id => ({
    type: 'public-key',
    id: unb64url(id) as BufferSource,
  }));

  let created: PublicKeyCredential | null;
  try {
    created = (await navigator.credentials.create({
      publicKey: {
        challenge: createChallenge,
        rp: { name: 'IronDivi Wallet' },
        user: {
          id: userHandle,
          name: opts.accountName || 'IronDivi Account',
          displayName: opts.label ? `${opts.accountName} (${opts.label})` : (opts.accountName || 'IronDivi Account'),
        },
        pubKeyCredParams: [
          { type: 'public-key', alg: -7 },
          { type: 'public-key', alg: -257 },
        ],
        authenticatorSelection: {
          residentKey: 'preferred',
          userVerification: 'required',
        },
        excludeCredentials,
        extensions: { prf: {} } as unknown as AuthenticationExtensionsClientInputs,
      },
    })) as PublicKeyCredential | null;
  } catch (err) {
    throw normalizeWebAuthnError(err);
  }

  if (!created || !(created.rawId instanceof ArrayBuffer) || created.rawId.byteLength === 0) {
    throw new Error('Passkey creation did not return a credential.');
  }

  const rawCredentialId = new Uint8Array(created.rawId);
  const credentialId = b64url(rawCredentialId);
  const prfSaltBytes = crypto.getRandomValues(new Uint8Array(32));
  const verifyChallenge = crypto.getRandomValues(new Uint8Array(32));

  let prfOutBytes: Uint8Array | null = null;
  try {
    const assertion = (await navigator.credentials.get({
      publicKey: {
        challenge: verifyChallenge,
        allowCredentials: [
          {
            type: 'public-key',
            id: rawCredentialId as BufferSource,
          },
        ],
        userVerification: 'required',
        extensions: {
          prf: {
            eval: {
              first: prfSaltBytes,
            },
          },
        } as unknown as AuthenticationExtensionsClientInputs,
      },
    })) as PublicKeyCredential | null;

    if (!assertion) {
      throw new Error('Passkey verification was cancelled.');
    }

    const extResults = assertion.getClientExtensionResults() as {
      prf?: { results?: { first?: unknown } };
    };
    prfOutBytes = toUint8Array(extResults?.prf?.results?.first);
    if (!prfOutBytes || prfOutBytes.byteLength !== 32) {
      throw new Error(PRF_UNSUPPORTED_ERROR);
    }

    return {
      credentialId,
      prfSalt: b64url(prfSaltBytes),
      prfOutput: b64url(prfOutBytes),
    };
  } catch (err) {
    throw normalizeWebAuthnError(err);
  } finally {
    if (prfOutBytes) secureWipe(prfOutBytes);
  }
}

/**
 * Request a WebAuthn PRF assertion in the current window against one of the
 * account's enrolled passkey slots. Never overrides rpId.
 */
export async function assertPasskeyInWindow(slots: PasskeySlotInfo[]): Promise<PasskeyAuthInput> {
  if (!slots || slots.length === 0) {
    throw new Error('No passkey enrolled for this account');
  }
  if (typeof navigator === 'undefined' || !navigator.credentials?.get) {
    throw new Error(PRF_UNSUPPORTED_ERROR);
  }

  const challenge = crypto.getRandomValues(new Uint8Array(32));
  const allowCredentials: PublicKeyCredentialDescriptor[] = slots.map(s => ({
    type: 'public-key',
    id: unb64url(s.credentialId) as BufferSource,
  }));

  const prfInput = slots.length === 1
    ? { eval: { first: unb64url(slots[0].prfSalt) } }
    : {
        evalByCredential: Object.fromEntries(
          slots.map(s => [s.credentialId, { first: unb64url(s.prfSalt) }]),
        ),
      };

  let prfOutBytes: Uint8Array | null = null;
  try {
    const assertion = (await navigator.credentials.get({
      publicKey: {
        challenge,
        allowCredentials,
        userVerification: 'required',
        extensions: {
          prf: prfInput,
        } as unknown as AuthenticationExtensionsClientInputs,
      },
    })) as PublicKeyCredential | null;

    if (!assertion || !(assertion.rawId instanceof ArrayBuffer)) {
      throw new Error('Passkey verification was cancelled.');
    }

    const credentialId = b64url(new Uint8Array(assertion.rawId));
    const extResults = assertion.getClientExtensionResults() as {
      prf?: { results?: { first?: unknown } };
    };
    prfOutBytes = toUint8Array(extResults?.prf?.results?.first);
    if (!prfOutBytes || prfOutBytes.byteLength !== 32) {
      throw new Error(PRF_UNSUPPORTED_ERROR);
    }

    return {
      credentialId,
      prfOutput: b64url(prfOutBytes),
    };
  } catch (err) {
    throw normalizeWebAuthnError(err);
  } finally {
    if (prfOutBytes) secureWipe(prfOutBytes);
  }
}

export async function assertPasskeyForAccount(accountId: string): Promise<PasskeyAuthInput> {
  const slots = await fetchPasskeySlots(accountId);
  return assertPasskeyInWindow(slots);
}
