/**
 * A records change that loosens a protection (a new contact, site or
 * account) needs the records key, which only the password opens after the
 * browser restarts (records-seal.ts). The background then answers with an
 * UNLOCK_NEEDED error; the popup asks for the password once, unlocks, and
 * sends the same message again.
 */
import { UNLOCK_NEEDED, type MessageResponse } from '../shared/constants';

export interface UnlockDeps {
  // The password, or null when the owner cancels
  ask(reason: string): Promise<string | null>;
  // The account to unlock when the caller names none
  currentAccountId(): string | undefined;
  authenticate(accountId: string, password: string): Promise<MessageResponse>;
}

let deps: UnlockDeps | null = null;

export function setUnlockDeps(d: UnlockDeps | null): void {
  deps = d;
}

export function needsUnlock(response: MessageResponse | undefined): boolean {
  return !response?.success && typeof response?.error === 'string' && response.error.startsWith(UNLOCK_NEEDED);
}

/** Send, and if the records key is needed, unlock once and send again */
export async function retryAfterUnlock(send: () => Promise<MessageResponse>, accountId?: string): Promise<MessageResponse> {
  const first = await send();
  if (!needsUnlock(first) || !deps) return first;
  const id = accountId ?? deps.currentAccountId();
  const reason = first.error!.slice(UNLOCK_NEEDED.length).trim();
  if (!id) return { success: false, error: reason };
  const password = await deps.ask(reason);
  if (!password) return { success: false, error: 'Not saved: the password was not entered' };
  const auth = await deps.authenticate(id, password);
  if (!auth?.success) return { success: false, error: auth?.error || 'Invalid password' };
  return send();
}
