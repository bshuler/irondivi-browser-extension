import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createHarness, TEST_MNEMONIC, TEST_PASSWORD, type Harness } from '../test-support/harness';

vi.setConfig({ testTimeout: 30000 });

let h: Harness;

beforeEach(() => {
  vi.resetModules();
});

afterEach(() => {
  vi.useRealTimers();
});

async function switchTo(network: 'mainnet' | 'testnet') {
  const r = await h.popup('UPDATE_SETTINGS', { network });
  expect(r?.success).toBe(true);
}

async function selected() {
  const r = await h.popup('GET_ACCOUNTS');
  return r.data.accounts.find((a: any) => a.id === r.data.currentAccountId);
}

describe('each network has its own addresses', () => {
  it('imports a wallet with D addresses on mainnet and y addresses on testnet', async () => {
    h = await createHarness();
    await switchTo('mainnet');
    const r = await h.popup('IMPORT_ACCOUNT', { name: 'Main', mnemonic: TEST_MNEMONIC, password: TEST_PASSWORD });
    expect(r?.success).toBe(true);
    expect(r.data.account.network).toBe('mainnet');
    expect(r.data.account.addresses[0].address).toMatch(/^D/);

    await h.popup('SELECT_ACCOUNT', { accountId: r.data.account.id });
    await switchTo('testnet');
    expect((await selected()).addresses[0].address).toMatch(/^y/);
    await switchTo('mainnet');
    expect((await selected()).addresses[0].address).toBe(r.data.account.addresses[0].address);
  });

  it('a 0.0.1 testnet wallet gets mainnet addresses after the password, and keeps its testnet ones', async () => {
    h = await createHarness();
    const account = await h.setupWallet();
    const testnetAddress = account.addresses[0].address;
    expect(testnetAddress).toMatch(/^y/);

    // Make the stored account look like one saved by 0.0.1: no per-network entries.
    for (const a of h.storage.accounts) delete a.networks;

    await switchTo('mainnet');
    expect((await selected()).addresses).toEqual([]);

    // A site asking to connect is told to set the wallet up on mainnet first.
    const refused = await h.fromTab('CONNECT');
    expect(refused).toEqual({ success: false, error: expect.stringContaining('no Mainnet address yet') });

    const wrong = await h.popup('ADD_NETWORK_ADDRESSES', { accountId: account.id, password: 'wrong password' });
    expect(wrong?.success).toBe(false);

    const added = await h.popup('ADD_NETWORK_ADDRESSES', { accountId: account.id, password: TEST_PASSWORD });
    expect(added?.success).toBe(true);
    expect(added.data.account.addresses[0].address).toMatch(/^D/);
    expect((await selected()).addresses[0].address).toBe(added.data.account.addresses[0].address);

    await switchTo('testnet');
    expect((await selected()).addresses[0].address).toBe(testnetAddress);
  });

  it('refuses an approval when the wallet changed network after the request', async () => {
    h = await createHarness();
    await h.setupWallet();
    await h.connectPage();

    const pending = h.fromTab('SIGN_MESSAGE', { message: 'hello' });
    const req = await h.waitForPending('sign_message');
    await switchTo('mainnet');
    const r = await h.approvalWindow('APPROVE_SIGNING_REQUEST', { requestId: req.id, password: TEST_PASSWORD });
    expect(r).toEqual({ success: false, error: expect.stringContaining('changed network') });
    void pending;
  });
});
