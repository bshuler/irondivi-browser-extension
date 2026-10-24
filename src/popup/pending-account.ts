/**
 * A wallet whose recovery phrase has been shown but not yet confirmed.
 *
 * The popup closes whenever it loses focus, and writing a phrase down takes
 * longer than the service worker stays alive, so the phrase is kept in
 * session storage until the user confirms it. It is stored encrypted with the
 * password the user chose, and the password itself is never stored: resuming
 * after the popup closed asks for it again.
 */

import { encryptWithPassword, decryptWithPassword } from '../shared/crypto-utils';

export const PENDING_ACCOUNT_KEY = 'irondivi_pending_account';

type Vault = Awaited<ReturnType<typeof encryptWithPassword>>;

interface StoredPending {
  name: string;
  vault: Vault;
}

export type PendingState =
  | { kind: 'none' }
  | { kind: 'legacy' } // written by an earlier version, in plain text
  | { kind: 'encrypted'; name: string };

async function read(): Promise<unknown> {
  const result = await chrome.storage.session.get(PENDING_ACCOUNT_KEY);
  return result[PENDING_ACCOUNT_KEY];
}

function isStored(v: unknown): v is StoredPending {
  const r = v as StoredPending;
  return !!r && typeof r.name === 'string' && !!r.vault &&
    typeof r.vault.encrypted === 'string' && typeof r.vault.iv === 'string' &&
    typeof r.vault.salt === 'string' && !('password' in r) && !('mnemonic' in r);
}

export async function savePending(name: string, mnemonic: string, password: string): Promise<void> {
  const record: StoredPending = { name, vault: await encryptWithPassword(mnemonic, password) };
  await chrome.storage.session.set({ [PENDING_ACCOUNT_KEY]: record });
}

export async function pendingState(): Promise<PendingState> {
  const v = await read();
  if (v == null) return { kind: 'none' };
  if (isStored(v)) return { kind: 'encrypted', name: v.name };
  return { kind: 'legacy' };
}

/**
 * The pending phrase, or null if there is none or the password is wrong
 */
export async function unlockPending(password: string): Promise<{ name: string; mnemonic: string } | null> {
  const v = await read();
  if (!isStored(v)) return null;
  try {
    return { name: v.name, mnemonic: await decryptWithPassword(v.vault, password) };
  } catch {
    return null;
  }
}

export async function clearPending(): Promise<void> {
  await chrome.storage.session.remove(PENDING_ACCOUNT_KEY);
}
