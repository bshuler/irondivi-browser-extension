import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createHarness, TEST_MNEMONIC, TEST_PASSWORD, type Harness } from '../test-support/harness';

// Regression tests for the security review's L3: sending wiped the seed and
// the input keys, but not the master key, the derived keys' chain codes, the
// keys part way down each path, or the seed used to sign a message or derive
// an address

vi.setConfig({ testTimeout: 30000 });

let h: Harness;
let account: any;
// Every key and seed made while a test runs
let keys: any[];
let seeds: Uint8Array[];

beforeEach(async () => {
  vi.resetModules();
  h = await createHarness();
  account = await h.setupWallet();

  // The worker's own copies of these modules, so their calls are recorded
  const { HDKey } = await import('../lib/hdkey');
  const { Mnemonic } = await import('../lib/mnemonic');
  keys = [];
  seeds = [];
  const fromMasterSeed = HDKey.fromMasterSeed.bind(HDKey);
  vi.spyOn(HDKey, 'fromMasterSeed').mockImplementation(async seed => {
    const key = await fromMasterSeed(seed);
    keys.push(key);
    return key;
  });
  const deriveChild = HDKey.prototype.deriveChild;
  vi.spyOn(HDKey.prototype, 'deriveChild').mockImplementation(async function (this: any, index: number) {
    const key = await deriveChild.call(this, index);
    keys.push(key);
    return key;
  });
  const toSeed = Mnemonic.toSeed;
  vi.spyOn(Mnemonic, 'toSeed').mockImplementation(async (...args) => {
    const seed = await toSeed(...args);
    seeds.push(seed);
    return seed;
  });
});

async function foreignTestnetAddress(): Promise<string> {
  const { Mnemonic } = await import('../lib/mnemonic');
  const { deriveAddresses } = await import('../lib/derivation');
  const seed = await Mnemonic.toSeed(TEST_MNEMONIC, 'other-account');
  const [a] = await deriveAddresses(seed, 'testnet', 0, 1);
  keys = [];
  seeds = [];
  return a.address;
}

function expectAllWiped() {
  expect(keys.length).toBeGreaterThan(0);
  for (const key of keys) {
    expect(key.privateKey).toBeNull();
    expect(key.chainCode).toBeNull();
  }
  expect(seeds.length).toBeGreaterThan(0);
  for (const seed of seeds) expect(seed.every(b => b === 0)).toBe(true);
}

describe('L3 every key and seed is wiped after use', () => {
  it('sending a payment', async () => {
    const to = await foreignTestnetAddress();
    const r = await h.popup('SEND_TRANSACTION', { password: TEST_PASSWORD, to, amount: 1 });
    expect(r.success).toBe(true);
    // Master, the four hardened and normal steps, and the input key
    expect(keys.length).toBeGreaterThanOrEqual(6);
    expectAllWiped();
  });

  it('a payment that fails after the keys are derived', async () => {
    const to = await foreignTestnetAddress();
    const { walletCore } = await import('./wallet-core');
    vi.spyOn(walletCore, 'signTransaction').mockRejectedValue(new Error('boom'));
    const r = await h.popup('SEND_TRANSACTION', { password: TEST_PASSWORD, to, amount: 1 });
    expect(r.success).toBe(false);
    expectAllWiped();
  });

  it('signing a message', async () => {
    const r = await h.popup('SIGN_MESSAGE', { password: TEST_PASSWORD, message: 'hello', accountId: account.id, addressIndex: 0 });
    expect(r.success).toBe(true);
    expectAllWiped();
  });

  it('adding an address', async () => {
    const r = await h.popup('GENERATE_NEW_ADDRESS', { accountId: account.id, password: TEST_PASSWORD });
    expect(r.success).toBe(true);
    expectAllWiped();
  });

  it('importing an account', async () => {
    const r = await h.popup('IMPORT_ACCOUNT', { name: 'B', mnemonic: TEST_MNEMONIC, password: TEST_PASSWORD, network: 'testnet' });
    expect(r.success).toBe(true);
    expectAllWiped();
  });
});

describe('L3 derive wipes the keys part way down the path', () => {
  it('only the key returned and the one derive was called on are left', async () => {
    const { HDKey } = await import('../lib/hdkey');
    const master = await HDKey.fromMasterSeed(new Uint8Array(64).fill(7));
    keys = [];
    const leaf = await master.derive("m/44'/1'/0'/0/3");
    expect(keys).toHaveLength(5);
    for (const key of keys.slice(0, -1)) expect(key.privateKey).toBeNull();
    expect(keys.at(-1)).toBe(leaf);
    expect(leaf.privateKey).not.toBeNull();
    expect(master.privateKey).not.toBeNull();
  });

  it('a key derived in one step equals one derived step by step', async () => {
    const { HDKey } = await import('../lib/hdkey');
    const master = await HDKey.fromMasterSeed(new Uint8Array(64).fill(9));
    const direct = await master.derive("m/0'/1/2'");
    const a = await master.deriveChild(0x80000000);
    const b = await a.deriveChild(1);
    const c = await b.deriveChild(2 + 0x80000000);
    expect(Array.from(direct.privateKey!)).toEqual(Array.from(c.privateKey!));
    expect(Array.from(direct.chainCode!)).toEqual(Array.from(c.chainCode!));
  });
});
