import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createHarness, TEST_PASSWORD, type Harness } from '../test-support/harness';
import { Mnemonic } from '../lib/mnemonic';

// Regression tests for the security review's L15: a message signed from the
// popup was signed with whichever account the session had unlocked, without
// the popup naming it, and with the network and index the caller sent

vi.setConfig({ testTimeout: 30000 });

let h: Harness;
let a: any;
let b: any;

beforeEach(async () => {
  vi.resetModules();
  h = await createHarness();
  a = await h.setupWallet();
  const r = await h.popup('IMPORT_ACCOUNT', { name: 'B', mnemonic: await Mnemonic.generate(), password: TEST_PASSWORD, network: 'testnet' });
  expect(r.success).toBe(true);
  b = r.data.account;
  // Importing B leaves the session on A
  expect((await h.popup('AUTHENTICATE', { accountId: a.id, password: TEST_PASSWORD })).success).toBe(true);
});

const sign = (payload: Record<string, unknown>) => h.popup('SIGN_MESSAGE', { password: TEST_PASSWORD, message: 'hello', ...payload });

describe('L15 the popup names the account that signs', () => {
  it('signs with the unlocked account it names, from that account\'s address', async () => {
    const r = await sign({ accountId: a.id });
    expect(r.success).toBe(true);
    expect(r.data.address).toBe(a.addresses[0].address);
    expect(typeof r.data.signature).toBe('string');
  });

  for (const [what, accountId] of [['no account', undefined], ['an unknown account', 'no-such-account'], ['a non-string id', { id: 1 }]] as const) {
    it(`${what} is refused`, async () => {
      const r = await sign({ accountId });
      expect(r.success).toBe(false);
      expect(r.error).toMatch(/name the account/i);
    });
  }

  it('another account signs only with its own password', async () => {
    expect((await sign({ accountId: b.id, password: 'not-b-password' })).success).toBe(false);
    const r = await sign({ accountId: b.id });
    expect(r.success).toBe(true);
    expect(r.data.address).toBe(b.addresses[0].address);
  });

  it('an address that is not the account\'s is refused', async () => {
    expect((await sign({ accountId: a.id, address: b.addresses[0].address })).success).toBe(false);
    expect((await sign({ accountId: a.id, addressIndex: 99 })).success).toBe(false);
  });

  it('a network sent by the caller is ignored', async () => {
    const r = await sign({ accountId: a.id, network: 'mainnet' });
    const plain = await sign({ accountId: a.id });
    expect(r.data.address).toBe(plain.data.address);
    expect(r.data.signature).toBe(plain.data.signature);
  });
});
