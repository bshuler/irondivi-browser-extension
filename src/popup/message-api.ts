/**
 * Wrapper functions for chrome.runtime.sendMessage calls
 */

import { runtime } from '../shared/browser-polyfill';

/**
 * Send a message to the background script and await response.
 * Throws an error if the response indicates failure.
 */
export async function sendMessage<T = unknown>(type: string, payload?: unknown): Promise<T> {
  try {
    const response = await runtime.sendMessage({ type, payload });
    if (!response?.success) {
      throw new Error(response?.error || 'Request failed');
    }
    return response.data as T;
  } catch (error) {
    console.error('Message error');
    throw error;
  }
}
