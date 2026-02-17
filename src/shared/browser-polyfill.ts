// Unified browser API that works across Chrome, Firefox, Edge
declare const chrome: any;
declare const browser: any;

export const browserAPI = (globalThis as any).browser || (globalThis as any).chrome;

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
  session: {
    get: async <T = any>(keys: string | string[]): Promise<T> => {
      if (!browserAPI.storage.session) {
        // Firefox fallback - use local storage with prefix
        return storage.local.get(keys);
      }
      return new Promise((resolve) => {
        browserAPI.storage.session.get(keys, (result: T) => resolve(result));
      });
    },
    set: async (items: Record<string, any>): Promise<void> => {
      if (!browserAPI.storage.session) {
        return storage.local.set(items);
      }
      return new Promise((resolve) => {
        browserAPI.storage.session.set(items, () => resolve());
      });
    },
    remove: async (keys: string | string[]): Promise<void> => {
      if (!browserAPI.storage.session) {
        return storage.local.remove(keys);
      }
      return new Promise((resolve) => {
        browserAPI.storage.session.remove(keys, () => resolve());
      });
    },
  },
};

// Alarms API
export const alarms = {
  create: (name: string, options: { delayInMinutes?: number; periodInMinutes?: number }) => {
    browserAPI.alarms.create(name, options);
  },
  clear: async (name: string): Promise<boolean> => {
    return new Promise((resolve) => {
      browserAPI.alarms.clear(name, (wasCleared: boolean) => resolve(wasCleared));
    });
  },
  onAlarm: browserAPI.alarms.onAlarm,
};

// Runtime messaging
export const runtime = {
  sendMessage: async <T = any>(message: any): Promise<T> => {
    return new Promise((resolve) => {
      browserAPI.runtime.sendMessage(message, (response: T) => resolve(response));
    });
  },
  onMessage: browserAPI.runtime.onMessage,
  getURL: (path: string): string => browserAPI.runtime.getURL(path),
};
