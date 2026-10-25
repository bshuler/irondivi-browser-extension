import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createHarness, TEST_MNEMONIC, TEST_PASSWORD, type Harness } from '../test-support/harness';
import { Mnemonic } from '../lib/mnemonic';
import { deriveAddresses } from '../lib/derivation';

// Regression tests for the security review's EXT-5, EXT-6, EXT-7 and EXT-9:
// how the background answers sites and approves their requests

vi.setConfig({ testTimeout: 30000 });

const OTHER_MNEMONIC = 'legal winner thank year wave sausage worth useful legal winner thank yellow';

async function foreignTestnetAddress(): Promise<string> {
  const seed = await Mnemonic.toSeed(TEST_MNEMONIC, 'other-account');
  const [a] = await deriveAddresses(seed, 'testnet', 0, 1);
  return a.address;
}

let h: Harness;
let account: any;

beforeEach(async () => {
  vi.resetModules();
  h = await createHarness();
  account = await h.setupWallet();
});

describe('EXT-5 a site is not told why a payment cannot be made', () => {
  for (const [what, amount] of [['over the limit', 500], ['over the balance', 5000]] as const) {
    it(`a payment ${what} gets one plain answer`, async () => {
      await h.connectPage();
      const r = await h.fromTab('SEND_TRANSACTION', { to: await foreignTestnetAddress(), amount });
      expect(r).toEqual({ success: false, error: 'The wallet cannot make this payment' });
      expect(h.broadcasts).toHaveLength(0);
    });
  }

  it('what is wrong with the request itself is still named', async () => {
    await h.connectPage();
    const r = await h.fromTab('SEND_TRANSACTION', { to: await foreignTestnetAddress(), amount: -1 });
    expect(r).toEqual({ success: false, error: 'Invalid amount' });
    const bad = await h.fromTab('SEND_TRANSACTION', { to: 'not-an-address', amount: 1 });
    expect(bad.error).toMatch(/address/);
  });

  it('the owner, in the popup, still sees the reason', async () => {
    const r = await h.popup('SEND_TRANSACTION', { password: TEST_PASSWORD, to: await foreignTestnetAddress(), amount: 500 });
    expect(r.success).toBe(false);
    expect(r.error).toMatch(/balance/);
  });
});
