import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createHarness, TEST_MNEMONIC, TEST_PASSWORD, type Harness } from '../test-support/harness';
import { Mnemonic } from '../lib/mnemonic';
import { deriveAddresses } from '../lib/derivation';
import { DVNS_REGISTRY } from '../lib/dvns';

// A name record's fee from the popup and the default limits: a 500 DIVI name
// from a 1,000 DIVI wallet is over 10% per send and 25% a day, and still goes,
// because its payee and amount are fixed by the protocol (SPEC §4, §6)

vi.setConfig({ testTimeout: 30000 });

const REGISTRY = DVNS_REGISTRY.testnet;
const RECORD = 'DVNS1\nop=register\nname=siegeworlds';

async function foreignTestnetAddress(): Promise<string> {
  const seed = await Mnemonic.toSeed(TEST_MNEMONIC, 'other-account');
  const [a] = await deriveAddresses(seed, 'testnet', 0, 1);
  return a.address;
}

async function setLimits(h: Harness, limits: Record<string, number>) {
  const { data } = await h.popup('GET_SETTINGS');
  const r = await h.popup('UPDATE_SETTINGS', {
    transactionLimits: { ...data.settings.transactionLimits, ...limits },
    password: TEST_PASSWORD,
  });
  expect(r.success).toBe(true);
}

let h: Harness;

beforeEach(async () => {
  vi.resetModules();
  h = await createHarness();
  await h.setupWallet();
});

describe('a name record\'s fee and the transaction limits', () => {
  it('the popup pays a 500 DIVI name past the default percentages', async () => {
    const r = await h.popup('SEND_TRANSACTION', { password: TEST_PASSWORD, to: REGISTRY, amount: '500', memo: RECORD });
    expect(r.success).toBe(true);
    expect(h.broadcasts).toHaveLength(1);
  });

  it('still needs the password', async () => {
    const r = await h.popup('SEND_TRANSACTION', { to: REGISTRY, amount: '500', memo: RECORD });
    expect(r.success).toBe(false);
    expect(h.broadcasts).toHaveLength(0);
  });

  it('a site asking for the same payment is held to the limits', async () => {
    await h.connectPage();
    const r = await h.fromTab('SEND_TRANSACTION', { to: REGISTRY, amount: '500', memo: RECORD });
    expect(r).toEqual({ success: false, error: 'The wallet cannot make this payment' });
    expect(h.broadcasts).toHaveLength(0);
  });

  for (const [what, to, amount, memo] of [
    ['to another address', 'other', '500', RECORD],
    ['of more than the fee', REGISTRY, '501', RECORD],
    ['with no record', REGISTRY, '500', undefined],
    ['for a different name', REGISTRY, '500', 'DVNS1\nop=register\nname=abcd'],
  ] as const) {
    it(`a payment ${what} is held to the limits, and told why`, async () => {
      const payee = to === 'other' ? await foreignTestnetAddress() : to;
      const r = await h.popup('SEND_TRANSACTION', { password: TEST_PASSWORD, to: payee, amount, memo });
      expect(r.success).toBe(false);
      expect(r.error).toMatch(/10% of balance/);
      if (memo) expect(r.error).toMatch(/only when the popup pays the registry exactly its fee/);
      expect(h.broadcasts).toHaveLength(0);
    });
  }

  it('the absolute limits still apply', async () => {
    await setLimits(h, { maxAmountAbsolute: 100 });
    const r = await h.popup('SEND_TRANSACTION', { password: TEST_PASSWORD, to: REGISTRY, amount: '500', memo: RECORD });
    expect(r.success).toBe(false);
    expect(r.error).toMatch(/maximum amount limit of 100 DIVI/);
    expect(h.broadcasts).toHaveLength(0);
  });

  it('the fee counts toward the day\'s sends', async () => {
    // 2,000 DIVI seen this week: 25% a day is 625, so 150 DIVI alone would go,
    // and after the 500 DIVI fee it is over (the per-send limit is off here)
    h.fund(h.utxos[0].address, 1000 * 1e8);
    await setLimits(h, { maxAmountPercent: 0 });
    expect((await h.popup('SEND_TRANSACTION', { password: TEST_PASSWORD, to: REGISTRY, amount: '500', memo: RECORD })).success).toBe(true);
    const r = await h.popup('SEND_TRANSACTION', { password: TEST_PASSWORD, to: await foreignTestnetAddress(), amount: 150 });
    expect(r.success).toBe(false);
    expect(r.error).toMatch(/daily limit of 25%/);
    expect(h.broadcasts).toHaveLength(1);
  });
});
