import { readFileSync } from 'node:fs';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createHarness, TEST_PASSWORD, type Harness } from '../test-support/harness';

// Regression tests for the security recommendations' item 6: until the store
// review and notarization are done, sites may use the wallet on testnet only.
// The owner keeps mainnet in the popup.

vi.setConfig({ testTimeout: 30000 });

let h: Harness;
let account: any;

beforeEach(async () => {
  vi.resetModules();
  h = await createHarness();
  account = await h.setupWallet();
});

async function toMainnet() {
  expect((await h.popup('UPDATE_SETTINGS', { network: 'mainnet', password: TEST_PASSWORD })).error).toBeUndefined();
  expect((await h.popup('AUTHENTICATE', { accountId: account.id, password: TEST_PASSWORD })).success).toBe(true);
}

describe('item 6 sites are testnet only', () => {
  it('on mainnet a site can learn the network and nothing that reveals or moves funds', async () => {
    await toMainnet();
    const windows = h.createdWindows.length;
    for (const [type, payload] of [
      ['CONNECT', undefined],
      ['GET_ADDRESSES', undefined],
      ['GET_BALANCE', undefined],
      ['SIGN_MESSAGE', { message: 'hello' }],
      ['SEND_TRANSACTION', { to: account.addresses[0].address, amount: 1 }],
    ] as const) {
      expect(await h.fromTab(type, payload)).toEqual({ success: false, error: 'Sites can use IronDivi on testnet only' });
    }
    expect(h.createdWindows).toHaveLength(windows);
    expect(h.broadcasts).toHaveLength(0);
    expect((await h.fromTab('GET_NETWORK')).success).toBe(true);
    expect((await h.fromTab('IS_CONNECTED')).data.connected).toBe(false);
  });

  it('on testnet a site connects as before', async () => {
    await h.connectPage();
    expect((await h.fromTab('IS_CONNECTED')).data.connected).toBe(true);
  });

  it('the owner can still send on mainnet from the popup', async () => {
    await toMainnet();
    const r = await h.popup('SEND_TRANSACTION', { password: TEST_PASSWORD, to: account.addresses[0].address, amount: 500 });
    // refused for the balance, not for the network
    expect(r.error).not.toMatch(/testnet only/);
  });

  it('the mainnet bar tells the owner sites are shut out', () => {
    const css = readFileSync(new URL('../popup/styles.css', import.meta.url), 'utf8');
    expect(css).toMatch(/content: "Mainnet · real DIVI · closed to sites"/);
  });
});
