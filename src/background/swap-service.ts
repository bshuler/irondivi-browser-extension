/**
 * Atomic swaps (testnet only): the taker side of the IronDivi swap engine.
 *
 * The engine runs as WebAssembly (src/swap/pkg, built from the IronDivi swap-wasm crate) and
 * holds the swap keys only while the wallet is unlocked. Swap records are sealed by the
 * engine under a seed-derived key; this module only moves the sealed entries between the
 * engine and chrome.storage.local. The wallet locks when its last window closes, so swaps
 * progress only while a wallet window is open. A locked wallet pauses swap progress; nothing
 * is lost, because a swap that cannot be claimed in time is refunded on the next unlock.
 */

import { storage, alarms } from '../shared/browser-polyfill';
import { getSettings } from '../shared/storage';
import { NETWORKS } from '../shared/constants';
import { signingSession } from './signing-session';
import { rpcClient } from './rpc-client';
import initSwapWasm, { WasmTaker } from '../swap/pkg/swap_wasm.js';

export const SWAP_TICK_ALARM = 'swap-tick';
// MV3 floor for a periodic alarm is 30 s.
const TICK_PERIOD_MINUTES = 0.5;

export const SWAP_CONFIG = {
  maker_url: 'https://divi.cx/swap',
  divi_rpc: NETWORKS.testnet.rpcUrl,
  btc_endpoints: ['https://mempool.space/testnet/api', 'https://blockstream.info/testnet/api'],
  ltc_endpoints: ['https://litecoinspace.org/testnet/api'],
  index: 0,
};

// States a swap passes through after its taker leg is locked; tick() has work to do.
const OPEN_STATES = new Set(['locked', 'maker_lock_confirmed', 'claimed', 'refunded']);

export interface SwapSummary {
  id: string;
  state: string;
  direction: string;
  counter_chain: string;
  btc_amount: number;
  divi_amount: number;
  taker_chain: string;
  taker_lock_txid: string | null;
  maker_lock_txid: string | null;
  claim_txid: string | null;
  refund_txid: string | null;
  last_error: string | null;
  [k: string]: unknown;
}

interface Entry {
  key: string;
  seq: number;
  ct: string;
}

let wasmReady: Promise<unknown> | null = null;
let taker: WasmTaker | null = null;
let takerPrefix: string | null = null;
// Every engine call runs through this chain: one call at a time.
let queue: Promise<unknown> = Promise.resolve();

function serial<T>(fn: () => Promise<T>): Promise<T> {
  const run = queue.then(fn, fn);
  queue = run.catch(() => undefined);
  return run;
}

function loadWasm(): Promise<unknown> {
  if (!wasmReady) {
    wasmReady = initSwapWasm({ module_or_path: chrome.runtime.getURL('swap_wasm_bg.wasm') });
  }
  return wasmReady;
}

async function persist(entriesJson: string): Promise<void> {
  const entries: Entry[] = JSON.parse(entriesJson);
  const items: Record<string, Entry> = {};
  for (const e of entries) {
    if (!takerPrefix || !e.key.startsWith(takerPrefix)) {
      throw new Error('swap entry outside this wallet\'s prefix');
    }
    items[e.key] = e;
  }
  await storage.local.set(items);
}

async function snapshot(prefix: string): Promise<Entry[]> {
  // chrome.storage takes null for "every key"; the polyfill's signature does not.
  const all = await storage.local.get(null as unknown as string[]) as Record<string, unknown>;
  return Object.entries(all)
    .filter(([k]) => k.startsWith(prefix))
    .map(([, v]) => v as Entry);
}

/** Drop the engine and the keys it holds. */
export function disposeSwapEngine(): void {
  if (taker) {
    taker.free();
    taker = null;
    takerPrefix = null;
  }
}

/**
 * The engine for the unlocked wallet, built on first use and rebuilt if the account changed.
 * Throws when the wallet is locked or not on testnet.
 */
async function engine(): Promise<WasmTaker> {
  const settings = await getSettings();
  if (settings.network !== 'testnet') {
    disposeSwapEngine();
    throw new Error('Atomic swaps are testnet only');
  }
  const seed = await signingSession.getSeed();
  if (!seed) {
    disposeSwapEngine();
    throw new Error('Wallet is locked');
  }
  try {
    await loadWasm();
    const prefix = WasmTaker.storePrefix(seed);
    if (taker && takerPrefix === prefix) return taker;
    disposeSwapEngine();
    const entries = await snapshot(prefix);
    takerPrefix = prefix;
    taker = new WasmTaker(seed, JSON.stringify(SWAP_CONFIG), JSON.stringify(entries), persist);
    return taker;
  } finally {
    seed.fill(0);
  }
}

async function syncCoins(t: WasmTaker): Promise<void> {
  const { divi } = JSON.parse(t.addresses());
  const coins = await rpcClient.getAddressUtxosRaw(divi);
  await t.syncDiviCoins(JSON.stringify(
    coins.map(c => ({ txid: c.txid, outputIndex: c.outputIndex, satoshis: c.satoshis }))
  ));
}

function parse<T>(json: unknown): T {
  return JSON.parse(json as string) as T;
}

async function scheduleTick(swaps: SwapSummary[]): Promise<void> {
  if (swaps.some(s => OPEN_STATES.has(s.state))) {
    await alarms.create(SWAP_TICK_ALARM, { delayInMinutes: TICK_PERIOD_MINUTES, periodInMinutes: TICK_PERIOD_MINUTES });
  } else {
    await alarms.clear(SWAP_TICK_ALARM);
  }
}

// Locking the wallet drops the swap keys at once, not at the next engine call.
signingSession.onClear(disposeSwapEngine);

export const swapService = {
  addresses: () => serial(async () => parse<{ divi: string; btc: string; ltc: string }>((await engine()).addresses())),

  offers: () => serial(async () => parse<unknown[]>(await (await engine()).offers())),

  list: () => serial(async () => parse<SwapSummary[]>((await engine()).swaps())),

  begin: (offerId: string, btcSats: number) => serial(async () => {
    if (typeof offerId !== 'string' || !Number.isSafeInteger(btcSats) || btcSats <= 0) {
      throw new Error('Invalid swap request');
    }
    return parse<SwapSummary>(await (await engine()).begin(offerId, btcSats));
  }),

  lock: (id: string) => serial(async () => {
    const t = await engine();
    await syncCoins(t);
    const s = parse<SwapSummary>(await t.lock(id));
    await scheduleTick(parse<SwapSummary[]>(t.swaps()));
    return s;
  }),

  refund: (id: string) => serial(async () => parse<SwapSummary>(await (await engine()).refund(id))),

  /** One pass over every open swap. A locked wallet skips the pass and keeps the alarm. */
  tick: () => serial(async () => {
    let t: WasmTaker;
    try {
      t = await engine();
    } catch {
      return null;
    }
    await syncCoins(t).catch(() => undefined);
    const swaps = parse<SwapSummary[]>(await t.tick());
    await scheduleTick(swaps);
    return swaps;
  }),
};
