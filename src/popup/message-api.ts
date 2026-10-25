/**
 * Wrapper functions for chrome.runtime.sendMessage calls
 */

import { runtime } from '../shared/browser-polyfill';
import { retryAfterUnlock } from './unlock-retry';

// Every message carrying the password opens the secret, and the background
// checks the records each time (records-seal.ts)
const passwordListeners: Array<() => void> = [];

export function onPasswordAccepted(listener: () => void): void {
  passwordListeners.push(listener);
}

/**
 * Send a message to the background script and await response.
 * Throws an error if the response indicates failure.
 */
export async function sendMessage<T = unknown>(type: string, payload?: unknown): Promise<T> {
  try {
    // A change that needs the password after a browser restart asks for it once
    const response = await retryAfterUnlock(() => runtime.sendMessage({ type, payload }));
    if (!response?.success) {
      throw new Error(response?.error || 'Request failed');
    }
    if (typeof (payload as { password?: unknown } | undefined)?.password === 'string') {
      for (const listener of passwordListeners) listener();
    }
    return response.data as T;
  } catch (error) {
    console.error('Message error');
    throw error;
  }
}
