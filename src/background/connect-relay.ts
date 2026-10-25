// IronDivi Connect over the relay (irondivi-connect SPEC.md): the wallet end
// of a pairing the owner started by pasting a page's URI or QR code. Each
// request the page sends is answered through the same messages, checks and
// approval windows as an in-page request, under the grant key
// "relay:<o>", so a relay pairing and the page's own window.irondivi never
// share a connection. The page's origin `o` is what the URI claims: the
// browser has not checked it, and the windows say so.
import { storage, alarms, runtime } from '../shared/browser-polyfill';
import { MSG } from '../shared/constants';
import { getSettings } from '../shared/storage';
import { accessStatus, canonicalOrigin } from '../shared/site-access';
import { ERR, errorCode } from '../shared/provider-errors';
import { diviToSatoshis, satoshisText } from './wallet-core';
import { connectionManager } from './connection-manager';
import {
  ConnectError, IDC_ERR, POLL_WAIT_SEC, WalletSession, parseUri,
  type Envelope, type Rpc, type StoredSession,
} from '../lib/irondivi-connect';

export const RELAY_PREFIX = 'relay:';
export const RELAY_ALARM = 'irondivi-connect-poll';
export const MAX_RELAY_SESSIONS = 2;
const STORE_KEY = 'connectSessions';
// How long a poll that came back empty waits before the next, and the first
// wait after a failure (doubling to 30 s); tests shorten them
export const relayTiming = { minPollGapMs: 1000, retryMs: 1000, maxBackoffMs: 30_000 };

export interface RelayResponse { success: boolean; data?: any; error?: string; code?: number }
export type Dispatch = (type: string, payload: any, origin: string) => Promise<RelayResponse>;

export interface RelaySessionInfo {
  topic: string; origin: string; name: string; relay: string; relayHost: string;
  network: string; connected: boolean; account: string | null;
}

export const relayKey = (origin: string) => RELAY_PREFIX + origin;

function info(s: WalletSession): RelaySessionInfo {
  const st = s.state;
  return {
    topic: s.topic, origin: st.origin, name: st.name, relay: st.relay, relayHost: new URL(st.relay).host,
    network: st.network, connected: st.connected, account: st.account,
  };
}

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

class ConnectRelay {
  private sessions = new Map<string, WalletSession>();
  private polling = new Set<string>();
  private queues = new Map<string, Promise<void>>();
  private loaded: Promise<void> | null = null;
  private dispatch: Dispatch | null = null;

  // The service worker hands over its message dispatcher; sessions kept
  // from before the worker stopped start polling again
  start(dispatch: Dispatch): Promise<void> {
    this.dispatch = dispatch;
    alarms.create(RELAY_ALARM, { periodInMinutes: 0.5 });
    return this.resume();
  }

  // Idempotent: the alarm and every wake-up call it
  async resume(): Promise<void> {
    await this.load();
    for (const s of this.sessions.values()) this.run(s);
  }

  private load(): Promise<void> {
    this.loaded ??= (async () => {
      const stored = (await storage.session.get<Record<string, StoredSession[]>>(STORE_KEY))[STORE_KEY] ?? [];
      for (const json of stored) {
        try {
          const s = await WalletSession.restore(json);
          this.sessions.set(s.topic, s);
        } catch { /* a broken record is dropped */ }
      }
    })();
    return this.loaded;
  }

  private async save(): Promise<void> {
    const live = [...this.sessions.values()].filter(s => !s.closed).map(s => s.toJSON());
    await storage.session.set({ [STORE_KEY]: live });
  }

  list(): RelaySessionInfo[] {
    return [...this.sessions.values()].filter(s => !s.closed).map(info);
  }

  forOrigin(grantKey: string): RelaySessionInfo | undefined {
    const s = [...this.sessions.values()].find(x => !x.closed && relayKey(x.state.origin) === grantKey);
    return s ? info(s) : undefined;
  }

  /** The owner pasted or scanned a pairing URI */
  async pair(uri: string): Promise<RelaySessionInfo> {
    await this.load();
    const p = parseUri(uri);
    const settings = await getSettings();
    if (p.network !== settings.network) {
      throw new ConnectError(IDC_ERR.WRONG_NETWORK, `This code is for ${p.network}; the wallet is on ${settings.network}`);
    }
    if (canonicalOrigin(p.origin) !== p.origin) throw new ConnectError(IDC_ERR.INVALID_PARAMS, 'The site in this code is not one the wallet serves: ' + p.origin);
    const status = accessStatus(p.origin, settings.network, settings.siteAccess);
    if (status === 'blocked' || status === 'denied') throw new ConnectError(ERR.BLOCKED, `${p.origin} is ${status} in IronDivi`);
    const s = await WalletSession.pair(uri);
    if (this.sessions.has(s.topic)) throw new ConnectError(IDC_ERR.INVALID_PARAMS, 'This code is already paired');
    if (this.list().length >= MAX_RELAY_SESSIONS) {
      throw new ConnectError(IDC_ERR.INVALID_PARAMS, `At most ${MAX_RELAY_SESSIONS} pairings at once; end one first`);
    }
    this.sessions.set(s.topic, s);
    await this.save();
    this.run(s);
    return info(s);
  }

  /** End one pairing: tell the page, drop the grant */
  async end(topic: string): Promise<void> {
    await this.load();
    const s = this.sessions.get(topic);
    if (!s) return;
    if (s.state.connected) await this.post(s, WalletSession.disconnectRpc()).catch(() => {});
    await this.drop(s);
  }

  /** The site was blocked or forgotten: every pairing with it ends */
  async endOrigin(origin: string): Promise<void> {
    await this.load();
    for (const s of [...this.sessions.values()]) {
      if (s.state.origin === origin) await this.end(s.topic);
    }
  }

  /** Tests and shutdown: stop polling without telling anyone */
  stopAll(): void {
    for (const s of this.sessions.values()) s.closed = true;
    this.sessions.clear();
  }

  private async drop(s: WalletSession): Promise<void> {
    s.closed = true;
    this.sessions.delete(s.topic);
    await this.save();
    await connectionManager.revokeOriginEverywhere(relayKey(s.state.origin));
    connectionManager.rejectRequestsFrom(relayKey(s.state.origin), 'Request rejected: the pairing ended');
  }

  // One long poll per topic, for as long as the worker lives; the alarm
  // starts it again after the browser stops the worker
  private run(s: WalletSession): void {
    if (this.polling.has(s.topic) || s.closed) return;
    this.polling.add(s.topic);
    void (async () => {
      let failures = 0;
      try {
        while (!s.closed && this.sessions.get(s.topic) === s) {
          const started = Date.now();
          let ok = false;
          let got = 0;
          try {
            const res = await fetch(s.pollUrl());
            if (res.ok) {
              const body = await res.json();
              const messages = Array.isArray(body?.messages) ? body.messages : [];
              got = messages.length;
              await this.take(s, messages);
              ok = true;
            }
          } catch { /* the relay is down or the network is: try again later */ }
          failures = ok ? 0 : failures + 1;
          // A relay that answers an empty poll at once is not polled in a tight loop
          const pause = !ok ? Math.min(relayTiming.maxBackoffMs, relayTiming.retryMs * 2 ** (failures - 1))
            : got ? 0 : Math.max(0, relayTiming.minPollGapMs - (Date.now() - started));
          if (pause > 0) await sleep(pause);
        }
      } finally {
        this.polling.delete(s.topic);
      }
    })();
  }

  private async take(s: WalletSession, messages: Array<{ id: number; envelope: Envelope }>): Promise<void> {
    for (const m of messages) {
      if (s.closed) return;
      if (!Number.isSafeInteger(m?.id) || m.id <= s.state.after) continue;
      s.state.after = m.id;
      const rpc = await s.receive(m.envelope);
      await this.save();
      if (!rpc) continue;
      if (rpc.method === 'irondivi_disconnect' && rpc.id === undefined) {
        await this.drop(s);
        return;
      }
      // Requests are answered one at a time, in order, without holding up
      // the poll: a payment waiting for the owner does not stop a disconnect
      const prev = this.queues.get(s.topic) ?? Promise.resolve();
      this.queues.set(s.topic, prev.then(() => this.handle(s, rpc)).catch(() => {}));
    }
  }

  private async handle(s: WalletSession, rpc: Rpc): Promise<void> {
    if (s.closed) return;
    const reply = await s.answer(rpc, (method, params) => this.call(s, method, params));
    if (!reply || s.closed) return;
    await this.post(s, reply);
  }

  private async post(s: WalletSession, rpc: Rpc): Promise<void> {
    const envelope = await s.sealOut(rpc);
    await this.save();
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const res = await fetch(s.url(), {
          method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(envelope),
        });
        if (res.ok) return;
      } catch { /* try again */ }
      await sleep(relayTiming.retryMs / 2 * 2 ** attempt);
    }
    throw new Error('The relay did not take the reply');
  }

  // What the wallet does for each method: the in-page messages, with the
  // relay grant as the origin
  private async call(s: WalletSession, method: string, params: any): Promise<unknown> {
    const dispatch = this.dispatch;
    if (!dispatch) throw new ConnectError(IDC_ERR.INTERNAL, 'The wallet is starting');
    const origin = relayKey(s.state.origin);
    const settings = await getSettings();
    const status = accessStatus(s.state.origin, settings.network, settings.siteAccess);
    if (status === 'blocked' || status === 'denied') throw new ConnectError(IDC_ERR.UNAUTHORIZED, `${s.state.origin} is ${status} in IronDivi`);
    if (settings.network !== s.state.network) {
      throw new ConnectError(IDC_ERR.WRONG_NETWORK, `The wallet is on ${settings.network}; this pairing is for ${s.state.network}`);
    }
    const ask = async (type: string, payload?: any) => {
      const r = await dispatch(type, payload, origin);
      if (!r.success) throw new ConnectError(r.code ?? errorCode(r.error), r.error || 'Failed');
      return r.data;
    };
    if (method !== 'irondivi_connect') {
      const c = await ask(MSG.IS_CONNECTED);
      if (!c?.connected) throw new ConnectError(IDC_ERR.UNAUTHORIZED, 'Connect first');
    }
    switch (method) {
      case 'irondivi_connect': {
        // The approval window shows the name the page gives
        s.state.name = String(params.name).slice(0, 100);
        const c = await ask(MSG.CONNECT, { network: params.network });
        const addresses: Array<{ address: string }> = await ask(MSG.GET_ADDRESSES);
        return {
          address: c.address,
          accounts: addresses.map(a => a.address),
          network: c.network,
          wallet: { name: 'IronDivi Wallet', version: runtime.getManifest().version },
        };
      }
      case 'irondivi_accounts':
        return ((await ask(MSG.GET_ADDRESSES)) as Array<{ address: string }>).map(a => a.address);
      case 'irondivi_getNetwork':
        return (await ask(MSG.GET_NETWORK)).network;
      case 'irondivi_getBalance': {
        const { balance } = await ask(MSG.GET_BALANCE, params.address ? { address: params.address } : undefined);
        // The wallet keeps no separate unconfirmed figure
        return { confirmed: satoshisText(diviToSatoshis(balance)), unconfirmed: '0' };
      }
      case 'irondivi_signMessage':
        return (await ask(MSG.SIGN_MESSAGE, { message: params.message, address: params.address })).signature;
      case 'irondivi_sendTransaction': {
        const payload: Record<string, unknown> = { to: params.to, amount: params.amount };
        if (params.memo !== undefined) payload.memo = params.memo;
        return { txid: (await ask(MSG.SEND_TRANSACTION, payload)).txid };
      }
      default:
        throw new ConnectError(IDC_ERR.UNSUPPORTED, 'Unsupported method: ' + method);
    }
  }
}

export const connectRelay = new ConnectRelay();
export { POLL_WAIT_SEC };
