/**
 * Which server the wallet talks to, per network (design §6). Stored once per
 * install under `server` in chrome.storage.local, not in the wallet's settings:
 * it is not tied to a wallet profile. A wallet that never touched the setting
 * has no stored value and behaves exactly as before.
 */
import type { NetworkType } from './constants';

export type ServerMode = 'default' | 'public' | 'own';

export interface ServerChoice {
  mode: ServerMode;
  /** The wss:// address, only for mode 'own' */
  url?: string;
}

export type ServerConfig = Record<NetworkType, ServerChoice>;

export const PUBLIC_ELECTRUM: Record<NetworkType, string> = {
  mainnet: 'wss://electrum.irondivi.com',
  testnet: 'wss://electrum.irondivi.com/testnet',
};

export const DEFAULT_SERVER_CONFIG: ServerConfig = {
  mainnet: { mode: 'default' },
  testnet: { mode: 'default' },
};

/** What the popup shows for the server in use: a name and, if any, the address */
export const SERVER_NAMES: Record<ServerMode, string> = {
  default: 'IronDivi (standard)',
  public: 'IronDivi public Electrum',
  own: 'My own server',
};

/** A wss:// address with a host and nothing hidden in it, or null */
export function cleanServerUrl(raw: unknown): string | null {
  if (typeof raw !== 'string' || raw.length > 300) return null;
  try {
    const url = new URL(raw.trim());
    if (url.protocol !== 'wss:' || !url.hostname || url.username || url.password || url.hash) return null;
    return url.href.replace(/\/$/, '');
  } catch {
    return null;
  }
}

function cleanChoice(raw: unknown): ServerChoice {
  if (!raw || typeof raw !== 'object') return { mode: 'default' };
  const { mode, url } = raw as Record<string, unknown>;
  if (mode === 'public') return { mode: 'public' };
  if (mode === 'own') {
    const clean = cleanServerUrl(url);
    return clean ? { mode: 'own', url: clean } : { mode: 'default' };
  }
  return { mode: 'default' };
}

/** Stored server settings (or none) as the wallet uses them; anything unreadable means the default */
export function normalizeServerConfig(raw: unknown): ServerConfig {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  return { mainnet: cleanChoice(r.mainnet), testnet: cleanChoice(r.testnet) };
}

/** The address a choice connects to, or null for the default path */
export function serverUrl(choice: ServerChoice, network: NetworkType): string | null {
  if (choice.mode === 'public') return PUBLIC_ELECTRUM[network];
  if (choice.mode === 'own') return choice.url ?? null;
  return null;
}

export function serverLabel(choice: ServerChoice): string {
  return choice.mode === 'own' ? `My own server · ${hostOf(choice.url)}` : SERVER_NAMES[choice.mode];
}

function hostOf(url?: string): string {
  try { return new URL(url ?? '').host; } catch { return ''; }
}
