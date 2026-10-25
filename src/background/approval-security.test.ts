import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createHarness, TEST_MNEMONIC, TEST_PASSWORD, type Harness } from '../test-support/harness';
import { Mnemonic } from '../lib/mnemonic';
import { deriveAddresses } from '../lib/derivation';

// Regression tests for the security review's EXT-5, EXT-6, EXT-7, EXT-9 and EXT-10:
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

describe('EXT-6 a request is approved once', () => {
  it('two approvals at the same time send one payment', async () => {
    await h.connectPage();
    const sent = h.provider().sendTransaction({ to: await foreignTestnetAddress(), amount: 1 });
    const req = await h.waitForPending('send_transaction');
    const approve = () => h.approvalWindow('APPROVE_SIGNING_REQUEST', { requestId: req.id, password: TEST_PASSWORD });
    const [a, b] = await Promise.all([approve(), approve()]);
    expect([a.success, b.success].sort()).toEqual([false, true]);
    expect((a.success ? b : a).error).toMatch(/already being approved|not found/);
    await sent;
    expect(h.broadcasts).toHaveLength(1);
  });

  it('a wrong password leaves the request open for another try', async () => {
    await h.connectPage();
    const signed = h.provider().signMessage('hello');
    const req = await h.waitForPending('sign_message');
    const bad = await h.approvalWindow('APPROVE_SIGNING_REQUEST', { requestId: req.id, password: 'wrong-password' });
    expect(bad.success).toBe(false);
    const ok = await h.approvalWindow('APPROVE_SIGNING_REQUEST', { requestId: req.id, password: TEST_PASSWORD });
    expect(ok.success).toBe(true);
    await signed;
  });
});

describe('EXT-7 the session signs only for its own account', () => {
  it('signMessage refuses an account the session was not opened for', async () => {
    const { signingSession } = await import('./signing-session');
    await expect(signingSession.signMessage('hello', 0, 'testnet', 'another-account')).rejects.toThrow(/this account/);
    await expect(signingSession.signMessage('hello', 0, 'testnet', account.id)).resolves.toMatch(/\S/);
  });
});

describe('EXT-9 a connected site is told the address of the account it connected to', () => {
  it('choosing another account while the connect window is open does not change the answer', async () => {
    const b = await h.popup('IMPORT_ACCOUNT', { name: 'B', mnemonic: OTHER_MNEMONIC, password: TEST_PASSWORD, network: 'testnet' });
    expect(b.success).toBe(true);
    expect((await h.popup('SELECT_ACCOUNT', { accountId: account.id })).success).toBe(true);

    const done = h.fromTab('CONNECT');
    const req = await h.waitForPending('connect');
    expect((await h.popup('SELECT_ACCOUNT', { accountId: b.data.account.id })).success).toBe(true);
    expect((await h.approvalWindow('APPROVE_SIGNING_REQUEST', { requestId: req.id, isConnection: true })).success).toBe(true);
    const r = await done;
    expect(r.success).toBe(true);
    expect(r.data.address).toBe(account.addresses[0].address);
  });
});

describe('EXT-10 a message to sign must be text of a sane length', () => {
  for (const [what, message] of [['a number', 42], ['an object', { a: 1 }], ['an empty string', ''], ['over 8 KB', 'x'.repeat(8 * 1024 + 1)]] as const) {
    it(`${what} is refused before any window opens`, async () => {
      await h.connectPage();
      const windows = h.createdWindows.length;
      const r = await h.fromTab('SIGN_MESSAGE', { message });
      expect(r.success).toBe(false);
      expect(r.error).toMatch(/string|empty|too long/);
      expect(h.createdWindows).toHaveLength(windows);
    });
  }

  it('8 KB exactly is shown for approval', async () => {
    await h.connectPage();
    const signed = h.provider().signMessage('x'.repeat(8 * 1024));
    const req = await h.waitForPending('sign_message');
    expect((await h.approvalWindow('APPROVE_SIGNING_REQUEST', { requestId: req.id, password: TEST_PASSWORD })).success).toBe(true);
    await signed;
  });

  it('the popup refuses the same', async () => {
    const r = await h.popup('SIGN_MESSAGE', { accountId: account.id, password: TEST_PASSWORD, message: 'x'.repeat(9000) });
    expect(r).toEqual({ success: false, error: 'The message is too long (8 KB at most)' });
  });
});
