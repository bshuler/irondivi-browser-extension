/**
 * The seal on the wallet's unencrypted records (EXT-3).
 *
 * Accounts and their addresses, the settings, the site connections and the
 * address book are kept in storage.local without encryption, so the popup can
 * show them before the password is entered. A browser that lets a content
 * script write storage.local would let a page change them: point an address
 * at its own, allow its site, lift the limits. The records are sealed with an
 * HMAC under a records key that is stored only inside the password-encrypted
 * secrets (version 3), and kept in session storage while the browser runs.
 *
 * Each time a password opens a secret the records are checked: a change the
 * wallet did not seal is undone (anything looser than the seal is put back),
 * a seal that does not verify resets the protections to their defaults, and
 * the unlocking account's addresses are derived again from its phrase. While
 * the key is not known, the wallet writes only changes that loosen nothing;
 * a looser one throws UNLOCK_NEEDED and the popup asks for the password.
 *
 * Because the key lives in the secrets, stripping the seal or the key's
 * marker from storage.local does not turn the check off: once any secret
 * holds a key, a missing seal is a tampered seal.
 */
import { storage } from '../shared/browser-polyfill';
import { NETWORKS, UNLOCK_NEEDED, type NetworkType } from '../shared/constants';
import {
  DEFAULT_SETTINGS, normalizeSettings, setRecordsWriter, getSecrets,
  storeRecordsKey, anySecretHoldsRecordsKey, openSecretQuietly,
  type Account, type Connection, type Contact, type OpenedSecret, type RecordsPatch,
  type Settings, type TransactionLimits,
} from '../shared/storage';
import { addressesOn, setAddressesOn, withSeed } from '../shared/account-addresses';
import { looser } from '../shared/settings-check';
import { OLD_DEFAULT_PATTERNS } from '../shared/origin';
import { accessSummary, migrateAllowedSites, normalizeAccess, type SiteAccess } from '../shared/site-access';
import { HDKey } from '../lib/hdkey';
import { Address } from '../lib/address';
import { syncSiteScripts } from './site-scripts';

export { UNLOCK_NEEDED };
const SEAL_KEY = 'recordsSeal';
const WARNING_KEY = 'recordsWarning';
// The one-time notice about allowed-site patterns 0.0.5 could not carry over
const SITE_NOTICE_KEY = 'siteAccessNotice';
const SITE_NOTICE_DONE_KEY = 'siteAccessNoticeDone';
const SESSION_KEY = 'recordsKey';
// The most addresses per network the wallet keeps for an account. Discovery
// adds 20 at a time; anything beyond this is not the wallet's own doing.
export const MAX_ADDRESSES = 1000;

const RECORD_KEYS = ['accounts', 'settings', 'connections', 'addressBook'] as const;

interface Records {
  accounts?: Account[];
  settings?: Partial<Settings>;
  connections?: Record<string, Record<string, Connection>>;
  addressBook?: Contact[];
}

export interface Snapshot {
  // account id -> network -> "index:address:path", sorted
  accounts: Record<string, Record<string, string[]>>;
  // Accounts whose addresses were derived from their phrase since the last
  // reset; the others were sealed as they were found
  verified: string[];
  // phrase: the security phrase approval windows show (EXT-18); a seal made
  // before it existed has none, which is the same as no phrase
  // access: the sites the user allowed ("origin|network") and blocked, sorted.
  // A seal made before 0.0.5 has allowedSites, the patterns, instead.
  settings: { access?: AccessSnapshot; allowedSites?: string[]; limits: TransactionLimits; timeout: number; phrase?: string };
  // account id -> origin -> permissions, sorted; connected entries only
  connections: Record<string, Record<string, string[]>>;
  // contact id -> "network:address"
  contacts: Record<string, string>;
}

interface Seal { v: 1; snapshot: Snapshot; mac: string }

type AccessSnapshot = { allowed: string[]; blocked: string[] };

// What a seal vouches for, from either form it may have
function sealedAccess(settings: Snapshot['settings']): AccessSnapshot {
  if (settings.access) return settings.access;
  return accessSummary(migrateAllowedSites(settings.allowedSites ?? [], OLD_DEFAULT_PATTERNS).access);
}

// The records key, base64, once a password has opened it this session
let recordsKey: string | null = null;
// Accounts added since the last seal whose addresses the wallet derived itself
const pendingVerified = new Set<string>();

// Checking and writing run one after another, so a write never lands between
// a check and the seal that follows it
let queue: Promise<unknown> = Promise.resolve();
function oneAtATime<T>(fn: () => Promise<T>): Promise<T> {
  const run = queue.then(fn, fn);
  queue = run.catch(() => {});
  return run;
}

const b64 = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes));
const unb64 = (s: string) => Uint8Array.from(atob(s), c => c.charCodeAt(0));

async function loadKey(): Promise<string | null> {
  if (recordsKey) return recordsKey;
  try {
    const stored = (await storage.session.get<Record<string, unknown>>(SESSION_KEY))[SESSION_KEY];
    if (typeof stored === 'string') recordsKey = stored;
  } catch {
    // No session storage: the key is known only while the worker runs
  }
  return recordsKey;
}

async function keepKey(key: string): Promise<void> {
  recordsKey = key;
  try {
    await storage.session.set({ [SESSION_KEY]: key });
  } catch {
    // As above
  }
}

async function forgetKey(): Promise<void> {
  recordsKey = null;
  pendingVerified.clear();
  try {
    await storage.session.remove(SESSION_KEY);
  } catch {
    // As above
  }
}

function newKey(): string {
  return b64(crypto.getRandomValues(new Uint8Array(32)));
}

// JSON with every object's keys sorted, so equal snapshots give equal text
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    return `{${Object.keys(obj).sort().map(k => `${JSON.stringify(k)}:${canonical(obj[k])}`).join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

async function mac(key: string, snapshot: Snapshot): Promise<string> {
  const hmacKey = await crypto.subtle.importKey('raw', unb64(key), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign('HMAC', hmacKey, new TextEncoder().encode(canonical(snapshot)));
  return b64(new Uint8Array(sig));
}

// Constant-time enough for two base64 MACs of fixed length
function sameMac(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

async function readRecords(): Promise<Records & { seal?: unknown }> {
  const got = await storage.local.get<Record<string, unknown>>([...RECORD_KEYS, SEAL_KEY]);
  return {
    accounts: Array.isArray(got.accounts) ? got.accounts as Account[] : undefined,
    settings: got.settings && typeof got.settings === 'object' ? got.settings as Partial<Settings> : undefined,
    connections: got.connections && typeof got.connections === 'object'
      ? got.connections as Records['connections'] : undefined,
    addressBook: Array.isArray(got.addressBook) ? got.addressBook as Contact[] : undefined,
    seal: got[SEAL_KEY],
  };
}

const NETWORK_NAMES = Object.keys(NETWORKS) as NetworkType[];

export function snapshotOf(records: Records, verified: Iterable<string>): Snapshot {
  const accounts: Snapshot['accounts'] = {};
  for (const account of records.accounts ?? []) {
    const nets: Record<string, string[]> = {};
    for (const net of NETWORK_NAMES) {
      const list = addressesOn(account, net).addresses ?? [];
      if (list.length) nets[net] = list.map(a => `${a.index}:${a.address}:${a.path}`).sort();
    }
    accounts[account.id] = nets;
  }
  const settings = normalizeSettings(records.settings);
  const connections: Snapshot['connections'] = {};
  for (const [accountId, byOrigin] of Object.entries(records.connections ?? {})) {
    for (const [origin, conn] of Object.entries(byOrigin ?? {})) {
      if (!conn?.connected) continue;
      (connections[accountId] ??= {})[origin] = [...(conn.permissions ?? [])].map(String).sort();
    }
  }
  const contacts: Snapshot['contacts'] = {};
  for (const c of records.addressBook ?? []) contacts[c.id] = `${c.network}:${c.address}`;
  const ids = new Set(Object.keys(accounts));
  return {
    accounts,
    verified: [...new Set(verified)].filter(id => ids.has(id)).sort(),
    settings: {
      access: accessSummary(settings.siteAccess),
      limits: { ...settings.transactionLimits },
      timeout: settings.authTimeoutMinutes,
      phrase: settings.securityPhrase ?? '',
    },
    connections,
    contacts,
  };
}

const EMPTY: Snapshot = {
  accounts: {}, verified: [], connections: {}, contacts: {},
  settings: { access: { allowed: [], blocked: [] }, limits: { ...DEFAULT_SETTINGS.transactionLimits }, timeout: 0 },
};

function settingsLooser(cur: Snapshot['settings'], sealed: Snapshot['settings']): boolean {
  // A site allowed that the seal did not allow, or a block lifted
  const was = sealedAccess(sealed);
  const now = sealedAccess(cur);
  const known = new Set(was.allowed);
  if (now.allowed.some(s => !known.has(s))) return true;
  const blocked = new Set(now.blocked);
  if (was.blocked.some(o => !blocked.has(o))) return true;
  for (const k of Object.keys(cur.limits) as (keyof TransactionLimits)[]) {
    if (looser(cur.limits[k], sealed.limits[k] ?? 0)) return true;
  }
  // A changed phrase would let a page that planted it pass for the wallet
  if ((cur.phrase ?? '') !== (sealed.phrase ?? '')) return true;
  return cur.timeout > sealed.timeout;
}

/** Whether `cur` allows anything the sealed snapshot did not */
export function isLooser(cur: Snapshot, sealed: Snapshot): boolean {
  for (const [id, nets] of Object.entries(cur.accounts)) {
    const was = sealed.accounts[id];
    if (!was) return true;
    for (const [net, list] of Object.entries(nets)) {
      const known = new Set(was[net] ?? []);
      if (list.some(a => !known.has(a))) return true;
    }
  }
  if (settingsLooser(cur.settings, sealed.settings)) return true;
  for (const [id, byOrigin] of Object.entries(cur.connections)) {
    for (const [origin, perms] of Object.entries(byOrigin)) {
      const known = new Set(sealed.connections[id]?.[origin] ?? []);
      if (perms.some(p => !known.has(p))) return true;
    }
  }
  for (const [id, value] of Object.entries(cur.contacts)) {
    if (sealed.contacts[id] !== value) return true;
  }
  return false;
}

// The sealed snapshot, if the seal verifies under the key
async function verifiedSnapshot(seal: unknown, key: string): Promise<Snapshot | null> {
  const s = seal as Seal;
  if (!s || typeof s !== 'object' || s.v !== 1 || typeof s.mac !== 'string' || !s.snapshot) return null;
  try {
    return sameMac(await mac(key, s.snapshot), s.mac) ? s.snapshot : null;
  } catch {
    return null;
  }
}

/** Put back everything looser than the sealed snapshot */
function revert(records: Records, sealed: Snapshot): Records {
  const accounts = (records.accounts ?? [])
    .filter(a => sealed.accounts[a.id])
    .map(a => {
      const account = structuredClone(a);
      for (const net of NETWORK_NAMES) {
        const entry = addressesOn(account, net);
        if (!entry.addresses?.length) continue;
        // An address at a sealed index gets its sealed value back; one at
        // any other index was never made by the wallet and is dropped
        const known = new Map((sealed.accounts[a.id][net] ?? []).map(k => {
          const [index, address, path] = k.split(':');
          return [Number(index), { index: Number(index), address, path }] as const;
        }));
        const addresses = [...new Set(entry.addresses.map(x => x.index))]
          .filter(i => known.has(i)).sort((x, y) => x - y).map(i => known.get(i)!);
        setAddressesOn(account, net, { addresses, addressIndex: nextIndex(addresses, 0) });
      }
      return account;
    });

  const cur = snapshotOf(records, []);
  const settings = { ...records.settings } as Partial<Settings>;
  if (settingsLooser(cur.settings, sealed.settings)) {
    settings.siteAccess = revertAccess(normalizeSettings(records.settings).siteAccess, sealedAccess(sealed.settings));
    delete settings.allowedSites;
    settings.transactionLimits = { ...sealed.settings.limits };
    settings.authTimeoutMinutes = sealed.settings.timeout;
    settings.limitsVersion = 2;
    if (sealed.settings.phrase) settings.securityPhrase = sealed.settings.phrase;
    else delete settings.securityPhrase;
  }

  const connections: NonNullable<Records['connections']> = {};
  for (const [id, byOrigin] of Object.entries(records.connections ?? {})) {
    for (const [origin, conn] of Object.entries(byOrigin ?? {})) {
      const known = sealed.connections[id]?.[origin];
      if (!conn?.connected || !known) continue;
      (connections[id] ??= {})[origin] = { ...conn, permissions: (conn.permissions ?? []).filter(p => known.includes(p)) };
    }
  }

  const addressBook = (records.addressBook ?? []).flatMap(c => {
    const was = sealed.contacts[c.id];
    if (!was) return [];
    if (was === `${c.network}:${c.address}`) return [c];
    const sep = was.indexOf(':');
    return [{ ...c, network: was.slice(0, sep) as NetworkType, address: was.slice(sep + 1) }];
  });

  return { accounts, settings, connections, addressBook };
}

/**
 * The records with every protection at its default: the allowed sites, the
 * limits and the lock time as a new wallet has them, no site connected, and
 * every contact marked for the owner to check.
 */
function reset(records: Records): Records {
  return {
    accounts: records.accounts ?? [],
    settings: {
      ...records.settings,
      // No site the user allowed stays allowed; the sites the user blocked
      // stay blocked
      siteAccess: { grants: {}, blocked: { ...normalizeSettings(records.settings).siteAccess.blocked } },
      allowedSites: undefined,
      transactionLimits: { ...DEFAULT_SETTINGS.transactionLimits },
      authTimeoutMinutes: DEFAULT_SETTINGS.authTimeoutMinutes,
      limitsVersion: 2,
      // A phrase found with no seal to vouch for it may be a planted one
      securityPhrase: undefined,
    },
    connections: {},
    addressBook: (records.addressBook ?? []).map(c => ({ ...c, unverified: true })),
  };
}

// Site access with only the allowed sites the seal vouches for, and every
// block it records
function revertAccess(access: SiteAccess, sealed: AccessSnapshot): SiteAccess {
  const ok = new Set(sealed.allowed);
  const grants: SiteAccess['grants'] = {};
  for (const [origin, byNet] of Object.entries(access.grants)) {
    for (const [net, g] of Object.entries(byNet ?? {})) {
      if (!g || (g.state === 'allowed' && !ok.has(`${origin}|${net}`))) continue;
      (grants[origin] ??= {})[net as NetworkType] = g;
    }
  }
  const blocked = { ...access.blocked };
  for (const o of sealed.blocked) if (!(o in blocked)) blocked[o] = 0;
  return normalizeAccess({ grants, blocked });
}

function nextIndex(addresses: { index: number }[], was: number): number {
  const highest = addresses.reduce((m, a) => Math.max(m, a.index), -1);
  return Math.min(Math.max(was, highest + 1), MAX_ADDRESSES);
}

/**
 * Derive an account's addresses again from its phrase and put them in place
 * of the stored ones. Returns whether anything stored was wrong.
 */
async function rederive(account: Account, mnemonic: string): Promise<boolean> {
  let changed = false;
  await withSeed(mnemonic, async seed => {
    const master = await HDKey.fromMasterSeed(seed);
    try {
      for (const net of NETWORK_NAMES) {
        const entry = addressesOn(account, net);
        if (!entry.addresses?.length && !account.networks?.[net]) continue;
        const indexes = [...new Set((entry.addresses ?? []).map(a => a.index))]
          .filter(i => Number.isSafeInteger(i) && i >= 0 && i < MAX_ADDRESSES)
          .sort((a, b) => a - b);
        const coinType = NETWORKS[net].coinType;
        const base = `m/44'/${coinType}'/0'/0`;
        const chain = await master.derive(base);
        const addresses = [];
        try {
          for (const index of indexes) {
            const child = await chain.deriveChild(index);
            try {
              if (!child.publicKey) throw new Error('Failed to derive public key');
              addresses.push({ index, address: Address.fromPublicKey(child.publicKey, net), path: `${base}/${index}` });
            } finally {
              child.wipe();
            }
          }
        } finally {
          chain.wipe();
        }
        const fixed = { addresses, addressIndex: nextIndex(addresses, Number.isSafeInteger(entry.addressIndex) ? entry.addressIndex : 0) };
        if (canonical(fixed) !== canonical({ addresses: entry.addresses, addressIndex: entry.addressIndex })) {
          changed = true;
          setAddressesOn(account, net, fixed);
        }
      }
    } finally {
      master.wipe();
    }
  });
  return changed;
}

async function writeSealed(records: Records, verified: Iterable<string>, key: string, extra: Record<string, unknown> = {}): Promise<void> {
  const snapshot = snapshotOf(records, verified);
  const seal: Seal = { v: 1, snapshot, mac: await mac(key, snapshot) };
  const items: Record<string, unknown> = { ...extra, [SEAL_KEY]: seal };
  for (const k of RECORD_KEYS) if (records[k] !== undefined) items[k] = records[k];
  await storage.local.set(items);
  pendingVerified.clear();
  // A repair may have changed the allowed sites; the scripts follow them
  if (WARNING_KEY in extra) void syncSiteScripts();
}

const TAMPER_WARNING = 'The wallet found its settings changed outside the wallet and put its protections back. Check your allowed sites, limits and contacts.';

/**
 * Check the records after a password opened an account's secret, and seal
 * them. Never throws for a problem it can repair; the caller logs anything
 * else and carries on, since the password was right.
 */
export function openRecords(accountId: string, password: string, opened: OpenedSecret): Promise<void> {
  return oneAtATime(async () => {
    let tamper = opened.relabeled;
    let key = await loadKey();
    const sealedInstall = await anySecretHoldsRecordsKey();
    let firstSeal = false;

    if (opened.recordsKey) {
      // Two keys means a secret was swapped in from elsewhere; the one this
      // session already trusts is kept
      if (key && key !== opened.recordsKey) tamper = true;
      else key = opened.recordsKey;
    } else if (!key && sealedInstall) {
      // Another account holds the key. The owner often uses one password
      // for every account, so try it on those, without counting a miss.
      key = await keyFromOtherSecrets(accountId, password);
      if (!key) {
        await checkUnsealedAccount(accountId, opened.mnemonic);
        return;
      }
    }
    if (!key) {
      // No secret holds a key yet: the first unlock after the upgrade seals
      // the records as they are
      key = newKey();
      firstSeal = true;
    }

    // A relabeled secret is written again with its true label, or every
    // unlock after this one would read it as tampered
    if (opened.recordsKey !== key || opened.relabeled) {
      await storeRecordsKey(accountId, password, opened.mnemonic, key, opened.blob);
    }
    await keepKey(key);

    const stored = await readRecords();
    let records: Records = stored;
    let verified: Set<string>;
    const sealed = firstSeal ? null : await verifiedSnapshot(stored.seal, key);
    if (firstSeal) {
      verified = new Set(pendingVerified);
    } else if (tamper || !sealed) {
      records = reset(stored);
      verified = new Set();
      tamper = true;
    } else {
      verified = new Set([...sealed.verified, ...pendingVerified]);
      if (isLooser(snapshotOf(stored, []), sealed)) {
        records = revert(stored, sealed);
        tamper = true;
      }
    }

    // The unlocking account's addresses, from its phrase
    const accounts = structuredClone(records.accounts ?? []);
    const account = accounts.find(a => a.id === accountId);
    if (account && !verified.has(accountId)) {
      if (await rederive(account, opened.mnemonic) && !firstSeal) tamper = true;
      verified.add(accountId);
    } else if (account && await rederive(account, opened.mnemonic)) {
      // A verified account's addresses are under the seal; a difference here
      // means the seal itself was made from changed records
      tamper = true;
    }
    records = { ...records, accounts };

    await writeSealed(records, verified, key, tamper ? { [WARNING_KEY]: { at: Date.now(), message: TAMPER_WARNING } } : {});
  });
}

// The records key from another account's secret, if this password opens it
async function keyFromOtherSecrets(accountId: string, password: string): Promise<string | null> {
  const secrets = await getSecrets();
  for (const [id, secret] of Object.entries(secrets)) {
    if (id === accountId || (secret?.version ?? 0) < 3) continue;
    const other = await openSecretQuietly(id, password);
    if (other?.recordsKey) return other.recordsKey;
  }
  return null;
}

// Without the key the records cannot be checked; the account opened must at
// least have the addresses its phrase gives
async function checkUnsealedAccount(accountId: string, mnemonic: string): Promise<void> {
  const stored = await readRecords();
  const account = structuredClone((stored.accounts ?? []).find(a => a.id === accountId));
  if (account && await rederive(account, mnemonic)) {
    throw new Error('This account\'s addresses were changed outside the wallet. Open another of your accounts with its password first, so the wallet can check its records.');
  }
}

/**
 * The records key to store in a new account's secret. With no key yet the
 * records are sealed as they are, as on a first unlock. Throws UNLOCK_NEEDED
 * when a secret holds a key this session does not know: adding an account
 * unchecked would let anyone who can write storage seal what they like.
 */
export function recordsKeyForNewAccount(accountId: string): Promise<string> {
  return oneAtATime(async () => {
    const key = await loadKey();
    if (key) {
      pendingVerified.add(accountId);
      return key;
    }
    if (await anySecretHoldsRecordsKey()) {
      throw new Error(`${UNLOCK_NEEDED} Enter your password to add an account`);
    }
    const fresh = newKey();
    await keepKey(fresh);
    await writeSealed(await readRecords(), [], fresh);
    pendingVerified.add(accountId);
    return fresh;
  });
}

/** After the last account is deleted there is nothing left to seal */
export function forgetRecordsIfEmpty(): Promise<void> {
  return oneAtATime(async () => {
    if (Object.keys(await getSecrets()).length > 0) return;
    await storage.local.remove([SEAL_KEY, WARNING_KEY]);
    await forgetKey();
  });
}

/**
 * Write records. With the key, the stored records are checked first and the
 * write is sealed. Without it, a change that loosens nothing is written as is
 * (the next unlock seals it) and a looser one throws UNLOCK_NEEDED.
 */
export function writeRecords(patch: RecordsPatch): Promise<void> {
  return oneAtATime(async () => {
    const stored = await readRecords();
    const next: Records = { ...stored, ...patch };
    const key = await loadKey();

    if (key) {
      const sealed = await verifiedSnapshot(stored.seal, key);
      if (!sealed || isLooser(snapshotOf(stored, []), sealed)) {
        const repaired = sealed ? revert(stored, sealed) : reset(stored);
        await writeSealed(repaired, sealed?.verified ?? [], key, { [WARNING_KEY]: { at: Date.now(), message: TAMPER_WARNING } });
        throw new Error('The wallet found its settings changed outside the wallet and put its protections back. Check them and try again.');
      }
      await writeSealed(next, [...sealed.verified, ...pendingVerified], key);
      return;
    }

    if (!(await anySecretHoldsRecordsKey()) && !stored.seal) {
      // Never sealed: nothing to keep to yet
      await storage.local.set(patch);
      return;
    }
    const s = stored.seal as Seal | undefined;
    const sealed = s?.snapshot ?? EMPTY;
    if (isLooser(snapshotOf(next, []), sealed)) {
      throw new Error(`${UNLOCK_NEEDED} Enter your password to save this change`);
    }
    await storage.local.set(patch);
  });
}

/** The banner text for the popup: the tamper warning first, else the site notice */
export async function getRecordsWarning(): Promise<string | null> {
  const got = await storage.local.get<Record<string, unknown>>([WARNING_KEY, SITE_NOTICE_KEY]);
  for (const key of [WARNING_KEY, SITE_NOTICE_KEY]) {
    const w = got[key] as { message?: unknown } | undefined;
    if (typeof w?.message === 'string') return w.message;
  }
  return null;
}

/** Dismiss the banner the popup shows (the tamper warning first) */
export async function dismissRecordsWarning(): Promise<void> {
  const got = await storage.local.get<Record<string, unknown>>(WARNING_KEY);
  await storage.local.remove(got[WARNING_KEY] ? WARNING_KEY : SITE_NOTICE_KEY);
}

/**
 * Once, after the update to exact site names: tell the owner which of their
 * old allowed-site patterns (wildcards, any port) could not be carried over.
 * The notice holds only the wallet's own text and patterns the owner typed.
 */
export async function noteDroppedSitePatterns(dropped: string[]): Promise<void> {
  if (dropped.length === 0) return;
  const got = await storage.local.get<Record<string, unknown>>(SITE_NOTICE_DONE_KEY);
  if (got[SITE_NOTICE_DONE_KEY]) return;
  const shown = dropped.slice(0, 10).join(', ') + (dropped.length > 10 ? `, and ${dropped.length - 10} more` : '');
  const message = `IronDivi now allows sites by their exact name. These entries from your allowed sites could not be carried over: ${shown}. A site you still use can ask you for access when you visit it.`;
  await storage.local.set({ [SITE_NOTICE_KEY]: { at: Date.now(), message }, [SITE_NOTICE_DONE_KEY]: true });
}

/** Route the storage module's record writes through the seal */
export function installRecordsSeal(): void {
  setRecordsWriter(writeRecords);
}
