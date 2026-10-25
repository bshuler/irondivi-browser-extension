import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createHarness, TEST_MNEMONIC, TEST_PASSWORD, type Harness } from '../test-support/harness';
import { Mnemonic } from '../lib/mnemonic';
import { deriveAddresses } from '../lib/derivation';
import { Transaction } from '../lib/transaction';

// Regression tests for the security review's EXT-27: the node lists a coin as
// unspent until the send that spends it is mined, so a second send made before
// then picked the same coin and the node refused it

vi.setConfig({ testTimeout: 30000 });

let h: Harness;
let account: any;
let to: string;

beforeEach(async () => {
  vi.resetModules();
  h = await createHarness();
  account = await h.setupWallet();
  const seed = await Mnemonic.toSeed(TEST_MNEMONIC, 'other-account');
  to = (await deriveAddresses(seed, 'testnet', 0, 1))[0].address;
});

afterEach(() => { vi.restoreAllMocks(); });

const send = () => h.popup('SEND_TRANSACTION', { password: TEST_PASSWORD, to, amount: 1 });
const spent = (hex: string) => Transaction.fromHex(hex).inputs.map(i => `${i.txid}:${i.vout}`);

describe('EXT-27 coins spent by a send that is not yet mined', () => {
  it('a second send uses another coin', async () => {
    h.fund(account.addresses[0].address, 1000 * 1e8);
    expect((await send()).success).toBe(true);
    expect((await send()).success).toBe(true);
    expect(h.broadcasts).toHaveLength(2);
    const [a, b] = h.broadcasts.map(spent);
    expect(a.filter(o => b.includes(o))).toEqual([]);
    expect(h.storage.pendingTxs.testnet[0].spends).toEqual(a);
  });

  it('with no other coin the second send is refused with the reason, and nothing is broadcast', async () => {
    expect((await send()).success).toBe(true);
    const r = await send();
    expect(r.success).toBe(false);
    expect(r.error).toMatch(/held by an earlier send until it confirms/);
    expect(h.broadcasts).toHaveLength(1);
  });

  it('a send that never confirms frees its coins after a day', async () => {
    expect((await send()).success).toBe(true);
    const now = Date.now();
    vi.spyOn(Date, 'now').mockReturnValue(now + 25 * 60 * 60 * 1000);
    expect((await send()).success).toBe(true);
    expect(spent(h.broadcasts[1])).toEqual(spent(h.broadcasts[0]));
  });
});
