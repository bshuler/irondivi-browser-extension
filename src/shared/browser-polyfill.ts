// Unified browser API that works across Chrome, Edge, Opera, Brave, Firefox and Safari
declare const chrome: any;
declare const browser: any;

// Prefer chrome.*: every wrapper below passes callbacks, which chrome.* takes in
// Chromium, Firefox and Safari alike, while Firefox's browser.* only returns promises.
export const browserAPI = (globalThis as any).chrome || (globalThis as any).browser;

function sessionArea(): any {
  const area = browserAPI.storage?.session;
  if (!area) {
    throw new Error('This browser has no session storage; IronDivi Wallet needs a newer version.');
  }
  return area;
}

// Promisified storage wrapper
export const storage = {
  local: {
    get: async <T = any>(keys: string | string[]): Promise<T> => {
      return new Promise((resolve) => {
        browserAPI.storage.local.get(keys, (result: T) => resolve(result));
      });
    },
    set: async (items: Record<string, any>): Promise<void> => {
      return new Promise((resolve) => {
        browserAPI.storage.local.set(items, () => resolve());
      });
    },
    remove: async (keys: string | string[]): Promise<void> => {
      return new Promise((resolve) => {
        browserAPI.storage.local.remove(keys, () => resolve());
      });
    },
  },
  // storage.session holds the unlocked wallet key, so it must never land on
  // disk. Every supported browser has it (Chrome 102, Firefox 115, Safari 16.4);
  // where it is missing, refuse rather than fall back to storage.local.
  session: {
    get: async <T = any>(keys: string | string[]): Promise<T> => {
      const area = sessionArea();
      return new Promise((resolve) => {
        area.get(keys, (result: T) => resolve(result));
      });
    },
    set: async (items: Record<string, any>): Promise<void> => {
      const area = sessionArea();
      return new Promise((resolve) => {
        area.set(items, () => resolve());
      });
    },
    remove: async (keys: string | string[]): Promise<void> => {
      const area = sessionArea();
      return new Promise((resolve) => {
        area.remove(keys, () => resolve());
      });
    },
  },
};

// Alarms API (only available in background/service worker context)
// Use lazy initialization to avoid errors in content scripts
export const alarms = {
  create: (name: string, options: { delayInMinutes?: number; periodInMinutes?: number }) => {
    browserAPI.alarms?.create(name, options);
  },
  clear: async (name: string): Promise<boolean> => {
    if (!browserAPI.alarms) return false;
    return new Promise((resolve) => {
      browserAPI.alarms.clear(name, (wasCleared: boolean) => resolve(wasCleared));
    });
  },
  get onAlarm() {
    return browserAPI.alarms?.onAlarm;
  },
};

// Runtime messaging
export const runtime = {
  sendMessage: async <T = any>(message: any): Promise<T> => {
    return new Promise((resolve) => {
      browserAPI.runtime.sendMessage(message, (response: T) => resolve(response));
    });
  },
  onMessage: browserAPI.runtime.onMessage,
  get onConnect() {
    return browserAPI.runtime.onConnect;
  },
  connect: (info: { name: string }) => browserAPI.runtime.connect(info),
  getURL: (path: string): string => browserAPI.runtime.getURL(path),
  getManifest: (): { version: string } => browserAPI.runtime.getManifest(),
};

// Idle API: tells the background when the screen locks. Safari has none.
export const idle = {
  get onStateChanged() {
    return browserAPI.idle?.onStateChanged;
  },
};
