import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createHarness, TEST_PASSWORD, type Harness } from '../test-support/harness';
import { encryptWithPassword } from '../shared/crypto-utils';

// Regression tests for the security review's EXT-3: the accounts, settings,
// connections and address book are stored unencrypted, and anything that can
// write storage.local could change them unnoticed

vi.setConfig({ testTimeout: 60000 });

const OTHER_MNEMONIC = 'legal winner thank year wave sausage worth useful legal winner thank yellow';
const EVIL = 'evil.example';

let h: Harness;
let account: any;

beforeEach(async () => {
  vi.resetModules();
  h = await createHarness();
  account = await h.setupWallet();
});

// The browser restarted: the worker's memory and session storage are gone
async function browserRestart() {
  await h.restartWorker();
  for (const k of Object.keys(h.sessionStorage)) delete h.sessionStorage[k];
}

const unlock = () => h.popup('AUTHENTICATE', { accountId: account.id, password: TEST_PASSWORD });

function plantLooseSettings() {
  h.storage.settings = {
    ...h.storage.settings,
    allowedSites: ['games.divi.domains', EVIL],
    transactionLimits: { maxAmountAbsolute: 0, maxAmountPercent: 0, dailyLimitAbsolute: 0, dailyLimitPercent: 0 },
    authTimeoutMinutes: 30,
    limitsVersion: 2,
  };
  h.storage.connections = { [account.id]: { [`https://${EVIL}`]: { connected: true, connectedAt: 1, permissions: ['sign'] } } };
}

function expectProtectionsBack() {
  const s = h.storage.settings;
  expect(s.allowedSites).not.toContain(EVIL);
  expect(s.transactionLimits.maxAmountPercent).toBeGreaterThan(0);
  expect(s.transactionLimits.dailyLimitPercent).toBeGreaterThan(0);
  expect(s.authTimeoutMinutes).toBeLessThan(30);
  expect(JSON.stringify(h.storage.connections ?? {})).not.toContain(EVIL);
}

describe('EXT-3 the records seal cannot be stripped', () => {
  it('deleting the seal and planting settings, after a restart, puts the defaults back on unlock', async () => {
    await browserRestart();
    delete h.storage.recordsSeal;
    delete h.storage.recordsWarning;
    plantLooseSettings();
    expect((await unlock()).success).toBe(true);
    expectProtectionsBack();
    expect(h.storage.recordsSeal).toBeTruthy();
    expect((await h.popup('GET_RECORDS_WARNING')).data.warning).toMatch(/changed outside the wallet/);
  });

  it('relabeling the secret as an older version does not turn the check off', async () => {
    await browserRestart();
    delete h.storage.recordsSeal;
    h.storage.secrets[account.id].version = 2;
    plantLooseSettings();
    expect((await unlock()).success).toBe(true);
    expectProtectionsBack();
    // and the secret is written back with its true label, so the next
    // unlock finds nothing wrong
    expect(h.storage.secrets[account.id].version).toBe(3);
    await h.popup('DISMISS_RECORDS_WARNING');
    expect((await unlock()).success).toBe(true);
    expect((await h.popup('GET_RECORDS_WARNING')).data.warning).toBeNull();
  });

  it('the records key is kept only inside the encrypted secret and session storage', async () => {
    const key = h.sessionStorage.recordsKey;
    expect(typeof key).toBe('string');
    expect(JSON.stringify(h.storage)).not.toContain(key);
  });
});

describe('EXT-3 a wallet from before the seal is sealed as it is', () => {
  it('the first unlock after the upgrade keeps the owner\'s own settings and seals them', async () => {
    // Make it a 0.0.4 wallet: a version 2 secret and no seal
    h.storage.secrets[account.id] = await encryptWithPassword(
      'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about', TEST_PASSWORD);
    delete h.storage.recordsSeal;
    h.storage.settings = { ...h.storage.settings, allowedSites: ['games.divi.domains', 'my.site'], limitsVersion: 2 };
    await browserRestart();

    expect((await unlock()).success).toBe(true);
    expect(h.storage.settings.allowedSites).toContain('my.site');
    expect(h.storage.secrets[account.id].version).toBe(3);
    expect(h.storage.recordsSeal).toBeTruthy();
    expect((await h.popup('GET_RECORDS_WARNING')).data.warning).toBeNull();
  });
});

describe('EXT-3 changes made outside the wallet are undone', () => {
  it('allowed sites, limits and connections planted while the wallet runs are put back on unlock', async () => {
    plantLooseSettings();
    expect((await unlock()).success).toBe(true);
    expectProtectionsBack();
  });

  it('a wallet write finds the planted settings, repairs them and refuses the write', async () => {
    plantLooseSettings();
    const r = await h.popup('UPDATE_SETTINGS', { hideBalance: true });
    expect(r.success).toBe(false);
    expect(r.error).toMatch(/changed outside the wallet/);
    expectProtectionsBack();
    expect((await h.popup('UPDATE_SETTINGS', { hideBalance: true })).success).toBe(true);
  });

  it('a changed contact address is put back', async () => {
    const added = await h.popup('ADD_CONTACT', { name: 'Friend', address: account.addresses[0].address, network: 'testnet' });
    expect(added.success).toBe(true);
    h.storage.addressBook[0].address = 'yAttackerAddressxxxxxxxxxxxxxxxxx';
    expect((await unlock()).success).toBe(true);
    expect(h.storage.addressBook[0].address).toBe(account.addresses[0].address);
  });

  it('a changed address of the account is derived again from the phrase on unlock', async () => {
    const real = account.addresses[0].address;
    await browserRestart();
    h.storage.accounts[0].addresses[0].address = 'yAttackerAddressxxxxxxxxxxxxxxxxx';
    h.storage.accounts[0].networks.testnet.addresses[0].address = 'yAttackerAddressxxxxxxxxxxxxxxxxx';
    expect((await unlock()).success).toBe(true);
    expect(h.storage.accounts[0].addresses[0].address).toBe(real);
    expect(h.storage.accounts[0].networks.testnet.addresses[0].address).toBe(real);
  });

  it('a new address is generated from the true records, not the planted ones', async () => {
    const real = account.addresses[0].address;
    h.storage.accounts[0].networks.testnet.addresses[0].address = 'yAttackerAddressxxxxxxxxxxxxxxxxx';
    h.storage.accounts[0].addresses[0].address = 'yAttackerAddressxxxxxxxxxxxxxxxxx';
    const r = await h.popup('GENERATE_NEW_ADDRESS', { accountId: account.id, password: TEST_PASSWORD });
    expect(r.success).toBe(true);
    expect(r.data.address.index).toBe(1);
    const stored = h.storage.accounts[0].networks.testnet.addresses;
    expect(stored.map((a: any) => a.address)).toEqual([real, r.data.address.address]);
  });

  it('addresses planted far past what the wallet makes are dropped', async () => {
    h.storage.accounts[0].networks.testnet.addresses.push({ index: 5000, address: 'yFar', path: "m/44'/1'/0'/0/5000" });
    h.storage.accounts[0].networks.testnet.addressIndex = 5001;
    expect((await unlock()).success).toBe(true);
    const entry = h.storage.accounts[0].networks.testnet;
    expect(entry.addresses).toHaveLength(1);
    expect(entry.addressIndex).toBe(1);
  });
});

describe('EXT-3 while the records key is not known', () => {
  beforeEach(browserRestart);

  it('a change that loosens nothing is saved', async () => {
    const r = await h.popup('UPDATE_SETTINGS', { hideBalance: true });
    expect(r.success).toBe(true);
    expect(h.storage.settings.hideBalance).toBe(true);
  });

  it('a change that adds something asks for the password, and is saved after it', async () => {
    const contact = { name: 'Friend', address: account.addresses[0].address, network: 'testnet' };
    const r = await h.popup('ADD_CONTACT', contact);
    expect(r.success).toBe(false);
    expect(r.error).toMatch(/^UNLOCK_NEEDED:/);
    expect(h.storage.addressBook ?? []).toHaveLength(0);
    expect((await unlock()).success).toBe(true);
    expect((await h.popup('ADD_CONTACT', contact)).success).toBe(true);
    expect(h.storage.addressBook).toHaveLength(1);
  });

  it('a second account cannot be added until the password is entered', async () => {
    const add = () => h.popup('IMPORT_ACCOUNT', { name: 'Two', mnemonic: OTHER_MNEMONIC, password: TEST_PASSWORD, network: 'testnet' });
    const refused = await add();
    expect(refused.success).toBe(false);
    expect(refused.error).toMatch(/^UNLOCK_NEEDED:/);
    expect(h.storage.accounts).toHaveLength(1);
    expect(Object.keys(h.storage.secrets)).toHaveLength(1);

    expect((await unlock()).success).toBe(true);
    const added = await add();
    expect(added.success).toBe(true);
    expect(h.storage.accounts).toHaveLength(2);
    expect(h.storage.secrets[added.data.account.id].version).toBe(3);
  });

  it('a second account opened with the shared password finds the key in the first', async () => {
    expect((await unlock()).success).toBe(true);
    const added = await h.popup('IMPORT_ACCOUNT', { name: 'Two', mnemonic: OTHER_MNEMONIC, password: TEST_PASSWORD, network: 'testnet' });
    expect(added.success).toBe(true);
    await browserRestart();
    plantLooseSettings();
    const r = await h.popup('AUTHENTICATE', { accountId: added.data.account.id, password: TEST_PASSWORD });
    expect(r.success).toBe(true);
    expectProtectionsBack();
  });
});

describe('EXT-3 contacts kept through a reset are marked for the owner to check', () => {
  it('a reset marks every contact unverified, and the owner can clear the mark', async () => {
    const added = await h.popup('ADD_CONTACT', { name: 'Friend', address: account.addresses[0].address, network: 'testnet' });
    expect(added.success).toBe(true);
    await browserRestart();
    delete h.storage.recordsSeal;
    expect((await unlock()).success).toBe(true);
    expect(h.storage.addressBook[0].unverified).toBe(true);
    const r = await h.popup('UPDATE_CONTACT', { contactId: h.storage.addressBook[0].id, updates: { checked: true } });
    expect(r.success).toBe(true);
    expect(h.storage.addressBook[0].unverified).toBeUndefined();
  });
});
