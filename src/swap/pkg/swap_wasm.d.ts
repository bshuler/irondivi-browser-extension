/* tslint:disable */
/* eslint-disable */

/**
 * The swap taker for one wallet seed.
 */
export class WasmTaker {
    free(): void;
    [Symbol.dispose](): void;
    /**
     * `{divi, btc, ltc}` as JSON.
     */
    addresses(): string;
    /**
     * Quote and accept; nothing is locked.
     */
    begin(offer_id: string, btc_sats: number): Promise<any>;
    /**
     * Lock the taker leg.
     */
    lock(id: string): Promise<any>;
    /**
     * `seed`: the wallet's BIP39 seed (wiped after use). `snapshotJson`: every stored entry
     * under [`storePrefix`](Self::store_prefix) as `[{key, seq, ct}]`. `persist(entriesJson)`
     * must store the entries and resolve only once they are durable.
     */
    constructor(seed: Uint8Array, config_json: string, snapshot_json: string, persist: Function);
    /**
     * The maker's offers this taker can take.
     */
    offers(): Promise<any>;
    /**
     * Refund a swap whose timeout has passed.
     */
    refund(id: string): Promise<any>;
    /**
     * Storage key prefix for `seed`'s entries.
     */
    static storePrefix(seed: Uint8Array): string;
    /**
     * Every swap, newest first, as JSON.
     */
    swaps(): string;
    /**
     * Replace the DIVI coin set with `[{txid, outputIndex, satoshis}]`.
     */
    syncDiviCoins(coins_json: string): Promise<any>;
    /**
     * Advance every open swap; resolves to all swaps.
     */
    tick(): Promise<any>;
}

export type InitInput = RequestInfo | URL | Response | BufferSource | WebAssembly.Module;

export interface InitOutput {
    readonly memory: WebAssembly.Memory;
    readonly __wbg_wasmtaker_free: (a: number, b: number) => void;
    readonly wasmtaker_addresses: (a: number) => [number, number, number, number];
    readonly wasmtaker_begin: (a: number, b: number, c: number, d: number) => any;
    readonly wasmtaker_lock: (a: number, b: number, c: number) => any;
    readonly wasmtaker_new: (a: number, b: number, c: number, d: number, e: number, f: number, g: any) => [number, number, number];
    readonly wasmtaker_offers: (a: number) => any;
    readonly wasmtaker_refund: (a: number, b: number, c: number) => any;
    readonly wasmtaker_storePrefix: (a: number, b: number) => [number, number];
    readonly wasmtaker_swaps: (a: number) => [number, number, number, number];
    readonly wasmtaker_syncDiviCoins: (a: number, b: number, c: number) => any;
    readonly wasmtaker_tick: (a: number) => any;
    readonly rustsecp256k1_v0_10_0_default_error_callback_fn: (a: number, b: number) => void;
    readonly rustsecp256k1_v0_10_0_default_illegal_callback_fn: (a: number, b: number) => void;
    readonly rustsecp256k1_v0_10_0_context_create: (a: number) => number;
    readonly rustsecp256k1_v0_10_0_context_destroy: (a: number) => void;
    readonly wasm_bindgen_c592120464837e1d___closure__destroy___dyn_core_608f92abc48d28da___ops__function__FnMut_____Output_______: (a: number, b: number) => void;
    readonly wasm_bindgen_c592120464837e1d___closure__destroy___dyn_core_608f92abc48d28da___ops__function__FnMut__wasm_bindgen_c592120464837e1d___JsValue____Output_______: (a: number, b: number) => void;
    readonly wasm_bindgen_c592120464837e1d___closure__destroy___dyn_core_608f92abc48d28da___ops__function__FnMut_____Output________1_: (a: number, b: number) => void;
    readonly wasm_bindgen_c592120464837e1d___convert__closures_____invoke___wasm_bindgen_c592120464837e1d___JsValue__wasm_bindgen_c592120464837e1d___JsValue_____: (a: number, b: number, c: any, d: any) => void;
    readonly wasm_bindgen_c592120464837e1d___convert__closures_____invoke___wasm_bindgen_c592120464837e1d___JsValue_____: (a: number, b: number, c: any) => void;
    readonly wasm_bindgen_c592120464837e1d___convert__closures_____invoke______: (a: number, b: number) => void;
    readonly wasm_bindgen_c592120464837e1d___convert__closures_____invoke_______1_: (a: number, b: number) => void;
    readonly __wbindgen_malloc: (a: number, b: number) => number;
    readonly __wbindgen_realloc: (a: number, b: number, c: number, d: number) => number;
    readonly __wbindgen_exn_store: (a: number) => void;
    readonly __externref_table_alloc: () => number;
    readonly __wbindgen_externrefs: WebAssembly.Table;
    readonly __externref_table_dealloc: (a: number) => void;
    readonly __wbindgen_free: (a: number, b: number, c: number) => void;
    readonly __wbindgen_start: () => void;
}

export type SyncInitInput = BufferSource | WebAssembly.Module;

/**
 * Instantiates the given `module`, which can either be bytes or
 * a precompiled `WebAssembly.Module`.
 *
 * @param {{ module: SyncInitInput }} module - Passing `SyncInitInput` directly is deprecated.
 *
 * @returns {InitOutput}
 */
export function initSync(module: { module: SyncInitInput } | SyncInitInput): InitOutput;

/**
 * If `module_or_path` is {RequestInfo} or {URL}, makes a request and
 * for everything else, calls `WebAssembly.instantiate` directly.
 *
 * @param {{ module_or_path: InitInput | Promise<InitInput> }} module_or_path - Passing `InitInput` directly is deprecated.
 *
 * @returns {Promise<InitOutput>}
 */
export default function __wbg_init (module_or_path?: { module_or_path: InitInput | Promise<InitInput> } | InitInput | Promise<InitInput>): Promise<InitOutput>;
