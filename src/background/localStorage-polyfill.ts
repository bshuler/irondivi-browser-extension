/**
 * localStorage polyfill for Chrome extension service workers.
 *
 * WalletConnect SDK uses localStorage for session persistence.
 * Chrome extension service workers don't have a localStorage object,
 * so we provide an in-memory shim. WalletKit also uses its own
 * internal persistence via @walletconnect/core stores, so this
 * polyfill mainly prevents crashes during SDK initialization.
 */
if (typeof globalThis.localStorage === 'undefined') {
  const storage: Record<string, string> = {};

  globalThis.localStorage = {
    getItem: (key: string) => storage[key] ?? null,
    setItem: (key: string, value: string) => { storage[key] = value; },
    removeItem: (key: string) => { delete storage[key]; },
    clear: () => { Object.keys(storage).forEach(k => delete storage[k]); },
    get length() { return Object.keys(storage).length; },
    key: (index: number) => Object.keys(storage)[index] ?? null,
  } as Storage;
}
