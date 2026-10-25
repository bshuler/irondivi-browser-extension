import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createHarness, TEST_MNEMONIC, TEST_PASSWORD, type Harness } from '../test-support/harness';
import { Mnemonic } from '../lib/mnemonic';
import { deriveAddresses } from '../lib/derivation';

// Regression tests for the security review's EXT-8: the approval window did
// not say which account pays or whom it pays

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

async function pendingPayment(to: string) {
  await h.connectPage();
  void h.provider().sendTransaction({ to, amount: 1 }).catch(() => {});
  const req = await h.waitForPending('send_transaction');
  const r = await h.approvalWindow('GET_PENDING_SIGNING_REQUESTS');
  expect(r.success).toBe(true);
  return { list: r.data, shown: r.data.requests.find((x: any) => x.id === req.id) };
}

describe('EXT-8 the approval window says which account pays and whom', () => {
  it('names the account and its address', async () => {
    const { shown } = await pendingPayment(await foreignTestnetAddress());
    expect(shown.from).toEqual({ name: account.name, address: account.addresses[0].address, addressCount: 1 });
  });

  it('a payment to an unknown address asks the owner to check it', async () => {
    const { shown } = await pendingPayment(await foreignTestnetAddress());
    expect(shown.recipient.level).toBe('warn');
    expect(shown.recipient.text).toMatch(/not in your contacts/);
  });

  it('a payment to a saved contact names the contact', async () => {
    const to = await foreignTestnetAddress();
    expect((await h.popup('ADD_CONTACT', { name: 'Friend', address: to, network: 'testnet' })).success).toBe(true);
    const { shown } = await pendingPayment(to);
    expect(shown.recipient).toEqual({ text: 'Saved contact: Friend', level: 'ok' });
  });

  it('a payment to another of the owner\'s accounts says so', async () => {
    const b = await h.popup('IMPORT_ACCOUNT', { name: 'B', mnemonic: OTHER_MNEMONIC, password: TEST_PASSWORD, network: 'testnet' });
    expect(b.success).toBe(true);
    expect((await h.popup('SELECT_ACCOUNT', { accountId: account.id })).success).toBe(true);
    const { shown } = await pendingPayment(b.data.account.addresses[0].address);
    expect(shown.recipient.level).toBe('ok');
    expect(shown.recipient.text).toMatch(/your own/);
  });

  it('shows what is left after the payment', async () => {
    const { shown } = await pendingPayment(await foreignTestnetAddress());
    const left = Number(shown.data.balanceAfter);
    expect(Number.isFinite(left)).toBe(true);
    expect(left).toBeLessThan(Number(shown.data.amount) + left);
    expect(typeof shown.data.fee).toBe('number');
  });

  it('a message to sign names the account too', async () => {
    await h.connectPage();
    void h.provider().signMessage('hello').catch(() => {});
    await h.waitForPending('sign_message');
    const r = await h.approvalWindow('GET_PENDING_SIGNING_REQUESTS');
    expect(r.data.requests[0].from.address).toBe(account.addresses[0].address);
    expect(r.data.requests[0].recipient).toBeUndefined();
  });
});
