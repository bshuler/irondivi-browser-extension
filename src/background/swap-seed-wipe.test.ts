import { readFileSync } from 'fs';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createHarness, TEST_PASSWORD, type Harness } from '../test-support/harness';

vi.setConfig({ testTimeout: 30000 });

const wasmBytes = readFileSync(new URL('../swap/pkg/swap_wasm_bg.wasm', import.meta.url));

let h: Harness;
let account: any;

beforeEach(async () => {
  vi.resetModules();
  h = await createHarness();
  const baseFetch = globalThis.fetch;
  (globalThis as any).fetch = vi.fn(async (input: any, init?: any) => {
    const url = typeof input === 'string' ? input : String(input?.url ?? input);
    if (url.endsWith('/swap_wasm_bg.wasm')) {
      return new Response(wasmBytes, {
        status: 200,
        headers: { 'content-type': 'application/wasm' },
      });
    }
    return baseFetch(input, init);
  });
  account = await h.setupWallet();
});

describe('swap wasm seed entry and zeroization', () => {
  it('derives matching testnet addresses via wasm-bindgen, wipes the seed copy on return, and frees on lock', async () => {
    const { signingSession } = await import('./signing-session');
    const handedOut: Uint8Array[] = [];
    const origGetSeed = signingSession.getSeed.bind(signingSession);
    vi.spyOn(signingSession, 'getSeed').mockImplementation(async () => {
      const s = await origGetSeed();
      if (s) handedOut.push(s);
      return s;
    });

    const reply = await h.popup('SWAP_ADDRESSES');
    expect(reply.success).toBe(true);
    expect(reply.data.divi).toBe(account.addresses[0].address);
    expect(reply.data.btc).toMatch(/^tb1q/);
    expect(reply.data.ltc).toMatch(/^tltc1q/);

    expect(handedOut.length).toBeGreaterThan(0);
    for (const buf of handedOut) {
      expect(buf.every(b => b === 0)).toBe(true);
    }

    await signingSession.clearSession();
    const lockedReply = await h.popup('SWAP_ADDRESSES');
    expect(lockedReply.success).toBe(false);
    expect(lockedReply.error).toMatch(/locked/i);

    const unlocked = await h.popup('AUTHENTICATE', { accountId: account.id, password: TEST_PASSWORD });
    expect(unlocked.success).toBe(true);
    const replyAgain = await h.popup('SWAP_ADDRESSES');
    expect(replyAgain.success).toBe(true);
    expect(replyAgain.data).toEqual(reply.data);
  });
});
