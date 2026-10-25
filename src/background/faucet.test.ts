import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createHarness, type Harness } from '../test-support/harness';
import { checkFaucetReply } from './rpc-client';

// Regression tests for the security review's EXT-22: the faucet's reply was
// passed on unchecked, to the popup and to the pending transaction list

vi.setConfig({ testTimeout: 30000 });

const TXID = 'ab'.repeat(32);
const BAD = { success: false, error: 'The faucet sent an unexpected answer' };

describe('EXT-22 checkFaucetReply', () => {
  it('a good reply is kept, and only its known fields', () => {
    expect(checkFaucetReply({ success: true, txid: TXID.toUpperCase(), extra: '<img>' })).toEqual({ success: true, txid: TXID });
    expect(checkFaucetReply({ success: false, error: 'Try again tomorrow' })).toEqual({ success: false, error: 'Try again tomorrow' });
  });

  for (const [what, reply] of [
    ['null', null],
    ['an array', [1]],
    ['a string', 'ok'],
    ['success as a string', { success: 'true', txid: TXID }],
    ['success with no txid', { success: true }],
    ['a txid that is not 64 hex', { success: true, txid: TXID.slice(1) + 'g' }],
    ['a txid that is an object', { success: true, txid: { toString: () => TXID } }],
    ['an error that is an object', { success: false, error: { html: '<b>' } }],
    ['an error over 200 characters', { success: false, error: 'x'.repeat(201) }],
  ] as const) {
    it(`${what} is refused`, () => {
      expect(checkFaucetReply(reply)).toEqual(BAD);
    });
  }
});

describe('EXT-22 a hostile faucet reply reaches neither the popup nor the pending list', () => {
  let h: Harness;
  let ours: string;

  beforeEach(async () => {
    vi.resetModules();
    h = await createHarness();
    ours = (await h.setupWallet()).addresses[0].address;
  });

  it('a malformed txid is not tracked', async () => {
    h.faucetReply = { success: true, txid: '../../etc' } as any;
    const r = await h.popup('REQUEST_FAUCET', { address: ours });
    expect(r.success).toBe(false);
    expect(r.data).toEqual(BAD);
    expect(JSON.stringify(h.storage)).not.toContain('../../etc');
  });

  it('a good txid is tracked', async () => {
    h.faucetReply = { success: true, txid: TXID };
    const r = await h.popup('REQUEST_FAUCET', { address: ours });
    expect(r).toEqual({ success: true, data: { success: true, txid: TXID } });
    expect(JSON.stringify(h.storage)).toContain(TXID);
  });
});
