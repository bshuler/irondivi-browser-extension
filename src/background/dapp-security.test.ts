import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createHarness, TEST_MNEMONIC, TEST_PASSWORD, type Harness } from '../test-support/harness';
import { Mnemonic } from '../lib/mnemonic';
import { HDKey } from '../lib/hdkey';
import { Signer } from '../lib/signer';
import { deriveAddresses } from '../lib/derivation';

// A testnet destination that the wallet does not own (other account of the test mnemonic).
async function foreignTestnetAddress(): Promise<string> {
  const seed = await Mnemonic.toSeed(TEST_MNEMONIC, 'other-account');
  const [a] = await deriveAddresses(seed, 'testnet', 0, 1);
  return a.address;
}

async function settle(ms = 50) {
  await new Promise(r => setTimeout(r, ms));
}

vi.setConfig({ testTimeout: 30000 });

let h: Harness;

beforeEach(() => {
  vi.resetModules();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('#2 popup-only messages need an extension page sender', () => {
  const privileged: Array<[string, unknown]> = [
    ['UPDATE_SETTINGS', { network: 'mainnet', allowedSites: ['*'] }],
    ['GENERATE_NEW_ADDRESS', { accountId: 'x', password: 'y' }],
    ['GET_ACCOUNTS', undefined],
    ['SELECT_ACCOUNT', { accountId: 'x' }],
    ['RENAME_ACCOUNT', { accountId: 'x', name: 'y' }],
    ['GET_TRANSACTIONS', undefined],
    ['GET_CONTACTS', undefined],
    ['ADD_CONTACT', { name: 'n', address: 'a', network: 'testnet' }],
    ['GET_CONNECTED_SITES', undefined],
    ['REVOKE_SITE', { origin: 'https://app.divi.domains' }],
    ['REQUEST_FAUCET', { address: 'a' }],
    ['GET_PENDING_SIGNING_REQUESTS', undefined],
    ['APPROVE_SIGNING_REQUEST', { requestId: 'x', isConnection: true }],
    ['REJECT_SIGNING_REQUEST', { requestId: 'x' }],
    ['AUTHENTICATE', { accountId: 'x', password: 'y' }],
    ['EXPORT_MNEMONIC', { accountId: 'x', password: 'y' }],
    ['IMPORT_ACCOUNT', { name: 'n', mnemonic: TEST_MNEMONIC, password: 'p' }],
  ];

  it('refuses every privileged message from a content-script sender', async () => {
    h = await createHarness();
    await h.setupWallet();
    for (const [type, payload] of privileged) {
      const r = await h.fromTab(type, payload);
      expect({ type, r }).toEqual({ type, r: { success: false, error: 'Unauthorized sender' } });
    }
  });

  it('a page cannot change settings through the content script', async () => {
    h = await createHarness();
    await h.setupWallet();
    const r = await h.pagePost('UPDATE_SETTINGS', { network: 'mainnet', allowedSites: ['*'] });
    expect(r.success).not.toBe(true);
    const s = await h.popup('GET_SETTINGS');
    expect(s.data.settings.network).toBe('testnet');
    expect(s.data.settings.allowedSites).not.toContain('*');
  });

  it('the content script forwards only provider methods', async () => {
    h = await createHarness();
    await h.setupWallet();
    const r = await h.pagePost('GET_ACCOUNTS');
    expect(r).toEqual({ success: false, error: 'Unsupported method' });
  });

  it('the popup and the approval window are still trusted', async () => {
    h = await createHarness();
    await h.setupWallet();
    expect((await h.popup('UPDATE_SETTINGS', { hideBalance: true })).success).toBe(true);
    expect((await h.popup('GET_ACCOUNTS')).success).toBe(true);
    expect((await h.approvalWindow('GET_PENDING_SIGNING_REQUESTS')).success).toBe(true);
  });
});

describe('#3 sendTransaction from a site needs approval in the popup', () => {
  it('opens the approval popup with amount, destination and fee, and broadcasts only after approval', async () => {
    h = await createHarness();
    await h.setupWallet();
    await h.connectPage();
    const to = await foreignTestnetAddress();
    const windowsBefore = h.createdWindows.length;

    const sent = h.provider().sendTransaction({ to, amount: 1.5 });
    const req = await h.waitForPending('send_transaction');
    expect(req.data).toMatchObject({ to, amount: 1.5 });
    expect(typeof req.data.fee).toBe('number');
    expect(h.createdWindows.length).toBe(windowsBefore + 1);
    expect(h.createdWindows.at(-1)!.url).toContain('approve=sign');
    await settle();
    expect(h.broadcasts).toHaveLength(0);

    const ok = await h.approvalWindow('APPROVE_SIGNING_REQUEST', { requestId: req.id, password: TEST_PASSWORD });
    expect(ok.success).toBe(true);
    await expect(sent).resolves.toBe('ab'.repeat(32));
    expect(h.broadcasts).toHaveLength(1);
  });

  it('a rejected send is not broadcast', async () => {
    h = await createHarness();
    await h.setupWallet();
    await h.connectPage();
    const sent = h.provider().sendTransaction({ to: await foreignTestnetAddress(), amount: 1 });
    const req = await h.waitForPending('send_transaction');
    await h.approvalWindow('REJECT_SIGNING_REQUEST', { requestId: req.id });
    await expect(sent).rejects.toThrow(/rejected/i);
    expect(h.broadcasts).toHaveLength(0);
  });

  it('closing the approval window rejects the send', async () => {
    h = await createHarness();
    await h.setupWallet();
    await h.connectPage();
    const sent = h.provider().sendTransaction({ to: await foreignTestnetAddress(), amount: 1 });
    await h.waitForPending('send_transaction');
    h.closeWindow(h.createdWindows.at(-1)!.id);
    await expect(sent).rejects.toThrow(/rejected/i);
    expect(h.broadcasts).toHaveLength(0);
  });

  it('an unanswered send times out as a rejection', async () => {
    h = await createHarness();
    await h.setupWallet();
    await h.connectPage();
    const to = await foreignTestnetAddress();
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'], shouldAdvanceTime: true });
    const sent = h.fromTab('SEND_TRANSACTION', { to, amount: 1 });
    await h.waitForPending('send_transaction');
    await vi.advanceTimersByTimeAsync(5 * 60 * 1000 + 1000);
    const r = await sent;
    expect(r.success).toBe(false);
    expect(r.error).toMatch(/timed out/i);
    expect(h.broadcasts).toHaveLength(0);
  });

  it('the popup\'s own send still works after AUTHENTICATE', async () => {
    h = await createHarness();
    await h.setupWallet();
    const r = await h.popup('SEND_TRANSACTION', { to: await foreignTestnetAddress(), amount: 1 });
    expect(r.success).toBe(true);
    expect(h.broadcasts).toHaveLength(1);
  });
});

describe('#4 one origin rule; sign and send need a connected origin', () => {
  it('http://127.0.0.1 gets the provider and can connect', async () => {
    h = await createHarness('http://127.0.0.1:8080/');
    await h.setupWallet();
    expect(h.provider()).toBeDefined();
    await h.connectPage();
    expect(await h.provider().isConnected()).toBe(true);
  });

  it('an unconnected http://127.0.0.1 page cannot sign a message', async () => {
    h = await createHarness('http://127.0.0.1:8080/');
    await h.setupWallet();
    const r = await h.pagePost('SIGN_MESSAGE', { message: 'hello' });
    expect(r.success).toBe(false);
    expect(r.error).toMatch(/not connected/i);
    expect(h.createdWindows).toHaveLength(0);
  });

  it('an unconnected http://127.0.0.1 page cannot send', async () => {
    h = await createHarness('http://127.0.0.1:8080/');
    await h.setupWallet();
    const r = await h.pagePost('SEND_TRANSACTION', { to: await foreignTestnetAddress(), amount: 1 });
    expect(r.success).toBe(false);
    expect(r.error).toMatch(/not connected/i);
    await settle();
    expect(h.broadcasts).toHaveLength(0);
  });

  it('an unconnected page cannot read addresses or balance', async () => {
    h = await createHarness();
    await h.setupWallet();
    for (const m of ['GET_ADDRESSES', 'GET_BALANCE']) {
      const r = await h.pagePost(m);
      expect({ m, success: r.success, error: r.error }).toMatchObject({ m, success: false, error: expect.stringMatching(/not connected/i) });
    }
  });

  it('a page on a site outside allowedSites reaches nothing', async () => {
    h = await createHarness('https://example.org/');
    await h.setupWallet();
    expect(h.provider()).toBeUndefined();
    const r = await h.pagePost('CONNECT');
    expect(r.success).not.toBe(true);
    await settle();
    expect(h.createdWindows).toHaveLength(0);
    // and the background refuses it too, if a message gets there some other way
    const direct = await Promise.race([h.fromTab('CONNECT'), settle(200).then(() => 'pending')]);
    expect(direct).toEqual({ success: false, error: 'Invalid origin' });
  });
});

describe('#5 getNetwork returns the configured network', () => {
  it('returns mainnet when the wallet is set to mainnet', async () => {
    h = await createHarness();
    await h.popup('UPDATE_SETTINGS', { network: 'mainnet' });
    expect(await h.provider().getNetwork()).toBe('mainnet');
    expect(await h.provider().request({ method: 'irondivi_getNetwork' })).toBe('mainnet');
  });

  it('returns testnet when the wallet is set to testnet', async () => {
    h = await createHarness();
    await h.popup('UPDATE_SETTINGS', { network: 'testnet' });
    expect(await h.provider().getNetwork()).toBe('testnet');
  });

  it('a page gets the network but not the rest of the settings', async () => {
    h = await createHarness();
    expect(await h.fromTab('GET_SETTINGS')).toEqual({ success: false, error: 'Unauthorized sender' });
    expect(await h.fromTab('GET_NETWORK')).toEqual({ success: true, data: { network: 'testnet' } });
  });
});

describe('#6 signMessage and getBalance honour the address argument', () => {
  async function secondAddress(account: any): Promise<string> {
    const r = await h.popup('GENERATE_NEW_ADDRESS', { accountId: account.id, password: TEST_PASSWORD });
    expect(r.success).toBe(true);
    return r.data.address.address;
  }

  it('signs with the key of the address passed', async () => {
    h = await createHarness();
    const account = await h.setupWallet();
    const addr1 = await secondAddress(account);
    await h.connectPage();

    const signed = h.provider().signMessage('hello divi', addr1);
    const req = await h.waitForPending('sign_message');
    const ok = await h.approvalWindow('APPROVE_SIGNING_REQUEST', { requestId: req.id, password: TEST_PASSWORD });
    expect(ok.success).toBe(true);

    const hd = await HDKey.fromMasterSeed(await Mnemonic.toSeed(TEST_MNEMONIC));
    const key = await hd.derive("m/44'/1'/0'/0/1");
    const expected = await Signer.signMessage('hello divi', key.privateKey!, key.publicKey!);
    await expect(signed).resolves.toBe(expected);
  });

  it('refuses an address the wallet does not own', async () => {
    h = await createHarness();
    await h.setupWallet();
    await h.connectPage();
    await expect(h.provider().signMessage('hello', await foreignTestnetAddress())).rejects.toThrow(/not .*this wallet|not owned/i);
    expect(h.createdWindows.filter(w => w.url.includes('approve=sign'))).toHaveLength(0);
  });

  it('getBalance(address) returns that address\'s balance', async () => {
    h = await createHarness();
    const account = await h.setupWallet();
    const addr1 = await secondAddress(account);
    h.utxos.push({ address: addr1, satoshis: 5 * 1e8, txid: 'ef'.repeat(32), vout: 1 });
    await h.connectPage();
    expect(await h.provider().getBalance(addr1)).toBe(5);
    expect(await h.provider().getBalance()).toBe(1005);
    await expect(h.provider().getBalance(await foreignTestnetAddress())).rejects.toThrow(/not .*this wallet|not owned/i);
  });
});

describe('#8 sends below the dust threshold are refused', () => {
  it('the popup send refuses 0.0000545 and accepts 0.0000546', async () => {
    h = await createHarness();
    await h.setupWallet();
    const to = await foreignTestnetAddress();
    const low = await h.popup('SEND_TRANSACTION', { to, amount: 0.0000545 });
    expect(low.success).toBe(false);
    expect(low.error).toMatch(/dust/i);
    expect(h.broadcasts).toHaveLength(0);
    const ok = await h.popup('SEND_TRANSACTION', { to, amount: 0.0000546 });
    expect(ok.success).toBe(true);
    expect(h.broadcasts).toHaveLength(1);
  });

  it('a site\'s dust send is refused before any popup opens', async () => {
    h = await createHarness();
    await h.setupWallet();
    await h.connectPage();
    const windows = h.createdWindows.length;
    await expect(h.provider().sendTransaction({ to: await foreignTestnetAddress(), amount: 0.00001 })).rejects.toThrow(/dust/i);
    expect(h.createdWindows.length).toBe(windows);
    expect(h.broadcasts).toHaveLength(0);
  });
});
