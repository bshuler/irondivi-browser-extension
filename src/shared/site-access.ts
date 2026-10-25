/**
 * Which sites may use the wallet, and what a site is told about it.
 *
 * - A compiled default list (site-access/default-sites.json) of exact https
 *   origins, the same on Mainnet and Testnet. Sites are added to it by a pull
 *   request to this repository (CONTRIBUTING.md).
 * - A compiled denylist (site-access/blocked-sites.json). A blocked origin is
 *   refused everything and can never open a window, whatever the default list
 *   or the user says.
 * - What the user chose for a site that asked with requestAccess, per origin
 *   and network, and the sites the user blocked. These live in the settings,
 *   which the records seal covers.
 *
 * The content script, the background and the popup all decide with
 * accessStatus, so they cannot disagree.
 */
import DEFAULT_SITES_JSON from '../../site-access/default-sites.json';
import BLOCKED_SITES_JSON from '../../site-access/blocked-sites.json';
import type { NetworkType } from './constants';

declare const __IRONDIVI_DEV__: boolean | undefined;
const DEV_BUILD = typeof __IRONDIVI_DEV__ !== 'undefined' && __IRONDIVI_DEV__;

export type AccessStatus = 'default' | 'allowed' | 'not_allowed' | 'denied' | 'blocked';
export type AccessChoice = 'allowed' | 'denied' | 'not_now';

export interface AccessGrant {
  state: AccessChoice;
  at: number; // when it was chosen, ms since the epoch
}

export interface SiteAccess {
  // origin -> network -> what the user chose when the site asked
  grants: Record<string, Partial<Record<NetworkType, AccessGrant>>>;
  // origin -> when the user blocked it
  blocked: Record<string, number>;
}

// Whether a site that is not on the default list can ask with requestAccess.
// The wallet's scripts must then run on every https page so the site can find
// window.irondivi to ask with; the page still learns nothing until the user
// allows it, and a page that is not allowed is answered only with its status.
export const SITES_CAN_ASK = true;

export const DEFAULT_SITES: readonly string[] = Object.freeze([...DEFAULT_SITES_JSON]);
export const BLOCKED_SITES: readonly string[] = Object.freeze([...BLOCKED_SITES_JSON]);

// After "Not now" a site cannot ask again for a day
export const NOT_NOW_MS = 24 * 60 * 60 * 1000;
// The reason a site gives is shown cut to this many characters
export const MAX_REASON = 200;
// The most origins a user can block or allow
export const MAX_SITE_ENTRIES = 500;

const LOCAL_HOSTS = ['localhost', '127.0.0.1'];

export function emptyAccess(): SiteAccess {
  return { grants: {}, blocked: {} };
}

/**
 * The origin of a page or of what the user typed, as the wallet keys it:
 * https://host[:port], lowercase, or http://localhost / 127.0.0.1 with a port.
 * A bare host is taken as https. Anything else is null.
 */
export function canonicalOrigin(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  let text = raw.trim();
  if (!text || text.length > 300) return null;
  if (!/^[a-z][a-z0-9+.-]*:/i.test(text)) text = `https://${text}`;
  let url: URL;
  try { url = new URL(text); } catch { return null; }
  if (url.username || url.password) return null;
  if (url.protocol === 'https:') {
    if (!url.hostname || url.hostname.includes('*')) return null;
    return url.origin;
  }
  if (url.protocol === 'http:' && LOCAL_HOSTS.includes(url.hostname)) return url.origin;
  return null;
}

function isLocal(origin: string): boolean {
  try {
    const url = new URL(origin);
    return url.protocol === 'http:' && LOCAL_HOSTS.includes(url.hostname);
  } catch {
    return false;
  }
}

/** Whether an origin is on the compiled default list (or local, in a development build) */
export function isDefaultSite(origin: string, dev: boolean = DEV_BUILD): boolean {
  return DEFAULT_SITES.includes(origin) || (dev && isLocal(origin));
}

/**
 * What a site may do, from the compiled lists and what the user chose:
 * 1. on the compiled denylist, or blocked by the user: blocked
 * 2. on the default list: default
 * 3. the user's choice for this network: allowed, denied, or (Not now) not_allowed
 * 4. otherwise not_allowed
 * Local http origins are served only by a development build.
 */
export function accessStatus(
  origin: string,
  network: NetworkType,
  access: SiteAccess | undefined,
  dev: boolean = DEV_BUILD,
): AccessStatus {
  const o = canonicalOrigin(origin);
  if (!o || o !== origin) return 'not_allowed';
  if (BLOCKED_SITES.includes(o)) return 'blocked';
  if (access?.blocked && Object.prototype.hasOwnProperty.call(access.blocked, o)) return 'blocked';
  if (isDefaultSite(o, dev)) return 'default';
  if (isLocal(o) && !dev) return 'not_allowed';
  const grant = access?.grants?.[o]?.[network];
  if (grant?.state === 'allowed') return 'allowed';
  if (grant?.state === 'denied') return 'denied';
  return 'not_allowed';
}

/** Whether a status lets the site use the wallet */
export function mayUse(status: AccessStatus): boolean {
  return status === 'default' || status === 'allowed';
}

/** Whether the site said Not now less than a day ago, so cannot ask yet */
export function askedTooRecently(origin: string, network: NetworkType, access: SiteAccess | undefined, now: number): boolean {
  const grant = access?.grants?.[origin]?.[network];
  return grant?.state === 'not_now' && now - grant.at < NOT_NOW_MS;
}

/** The reason a site gave, as text of at most MAX_REASON characters, or '' */
export function cleanReason(reason: unknown): string {
  if (typeof reason !== 'string') return '';
  const chars = [...reason.trim()];
  return chars.length > MAX_REASON ? `${chars.slice(0, MAX_REASON).join('')}…` : chars.join('');
}

/** A copy of the access with one choice recorded */
export function withChoice(access: SiteAccess, origin: string, network: NetworkType, state: AccessChoice, now: number): SiteAccess {
  const grants = { ...access.grants, [origin]: { ...access.grants[origin], [network]: { state, at: now } } };
  return { ...access, grants };
}

/** A copy of the access without the user's choices for an origin (on every network) */
export function withoutGrant(access: SiteAccess, origin: string): SiteAccess {
  const grants = { ...access.grants };
  delete grants[origin];
  return { ...access, grants };
}

export function withBlock(access: SiteAccess, origin: string, now: number): SiteAccess {
  return { ...access, blocked: { ...access.blocked, [origin]: now } };
}

export function withoutBlock(access: SiteAccess, origin: string): SiteAccess {
  const blocked = { ...access.blocked };
  delete blocked[origin];
  return { ...access, blocked };
}

/**
 * Stored site access as the wallet can use it: anything malformed is left
 * out, never guessed at
 */
export function normalizeAccess(raw: unknown): SiteAccess {
  const out = emptyAccess();
  if (!raw || typeof raw !== 'object') return out;
  const { grants, blocked } = raw as Partial<SiteAccess>;
  if (grants && typeof grants === 'object') {
    for (const [origin, byNet] of Object.entries(grants)) {
      if (canonicalOrigin(origin) !== origin || !byNet || typeof byNet !== 'object') continue;
      const kept: Partial<Record<NetworkType, AccessGrant>> = {};
      for (const net of ['mainnet', 'testnet'] as const) {
        const g = (byNet as any)[net];
        if (g && ['allowed', 'denied', 'not_now'].includes(g.state) && Number.isFinite(g.at)) {
          kept[net] = { state: g.state, at: g.at };
        }
      }
      if (Object.keys(kept).length > 0) out.grants[origin] = kept;
    }
  }
  if (blocked && typeof blocked === 'object') {
    for (const [origin, at] of Object.entries(blocked)) {
      if (canonicalOrigin(origin) === origin && Number.isFinite(at)) out.blocked[origin] = at as number;
    }
  }
  return out;
}

/**
 * The origins allowed on a network, and the blocked ones, as plain sorted
 * lists: what the records seal keeps
 */
export function accessSummary(access: SiteAccess): { allowed: string[]; blocked: string[] } {
  const allowed: string[] = [];
  for (const [origin, byNet] of Object.entries(access.grants)) {
    for (const [net, g] of Object.entries(byNet ?? {})) {
      if (g?.state === 'allowed') allowed.push(`${origin}|${net}`);
    }
  }
  return { allowed: allowed.sort(), blocked: Object.keys(access.blocked).sort() };
}

/**
 * Site access for an install from before 0.0.5, from its allowedSites list.
 * The old defaults are now on the default list. A site the user added by its
 * exact name is allowed on both networks, as before; a local host with a port
 * keeps that port. Wildcards and any-port patterns cannot be carried over to
 * exact origins and are returned as dropped, so the user can be told.
 */
export function migrateAllowedSites(stored: unknown, oldDefaults: readonly string[]): { access: SiteAccess; dropped: string[] } {
  const access = emptyAccess();
  const dropped: string[] = [];
  if (!Array.isArray(stored)) return { access, dropped };
  for (const raw of stored) {
    if (typeof raw !== 'string') continue;
    const pattern = raw.trim().toLowerCase();
    if (!pattern || oldDefaults.includes(pattern)) continue;
    let origin: string | null = null;
    const local = pattern.match(/^(localhost|127\.0\.0\.1)(?::(\d{1,5}))?$/);
    if (local) origin = canonicalOrigin(`http://${pattern}`);
    else if (!pattern.includes('*') && !pattern.includes(':')) origin = canonicalOrigin(`https://${pattern}`);
    if (!origin) { dropped.push(pattern); continue; }
    if (DEFAULT_SITES.includes(origin)) continue;
    access.grants[origin] = { mainnet: { state: 'allowed', at: 0 }, testnet: { state: 'allowed', at: 0 } };
  }
  return { access, dropped };
}

/**
 * The browser match patterns the wallet's scripts register on: every https
 * page when sites can ask, and always the default sites and the allowed ones,
 * so a user who withholds every-site access in the browser still has those.
 * Local pages only in a development build.
 */
export function siteMatchPatterns(access: SiteAccess | undefined, dev: boolean = DEV_BUILD): string[] {
  const out = new Set<string>();
  if (SITES_CAN_ASK) out.add('https://*/*');
  for (const o of DEFAULT_SITES) out.add(`${o}/*`);
  for (const [o, byNet] of Object.entries(access?.grants ?? {})) {
    if (Object.values(byNet ?? {}).some(g => g?.state === 'allowed') && !isLocal(o)) {
      out.add(`${new URL(o).protocol}//${new URL(o).hostname}/*`);
    }
  }
  if (dev) {
    for (const h of LOCAL_HOSTS) out.add(`http://${h}/*`);
  }
  return [...out];
}
