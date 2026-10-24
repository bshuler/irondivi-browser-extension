import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createHarness, TEST_MNEMONIC, type Harness } from '../test-support/harness';
import { Address } from '../lib/address';

// Regression tests for the security review's L8 and L9: the worker took any
// password the popup sent, and kept any string as a contact's address

vi.setConfig({ testTimeout: 30000 });

// The secp256k1 generator point, compressed: a public key with a known address
const PUBKEY = Uint8Array.from(
  '0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798'.match(/../g)!.map(b => parseInt(b, 16)),
);
const TESTNET_ADDRESS = Address.fromPublicKey(PUBKEY, 'testnet');
const MAINNET_ADDRESS = Address.fromPublicKey(PUBKEY, 'mainnet');

let h: Harness;

beforeEach(async () => {
  vi.resetModules();
  h = await createHarness();
});

describe('L8 the worker enforces the password minimum', () => {
  for (const password of ['', 'short', '1234567', undefined, 12345678, ['12345678']]) {
    it(`importing with ${JSON.stringify(password)} is refused and stores nothing`, async () => {
      const r = await h.popup('IMPORT_ACCOUNT', { name: 'A', mnemonic: TEST_MNEMONIC, password, network: 'testnet' });
      expect(r.success).toBe(false);
      expect(r.error).toMatch(/at least 8 characters/);
      expect(h.storage.accounts ?? []).toEqual([]);
      expect(h.storage.secrets ?? {}).toEqual({});
    });
  }

  it('creating with a short password is refused and stores nothing', async () => {
    const r = await h.popup('CREATE_ACCOUNT', { name: 'A', password: 'abc', network: 'testnet' });
    expect(r.success).toBe(false);
    expect(r.error).toMatch(/at least 8 characters/);
    expect(h.storage.secrets ?? {}).toEqual({});
  });

  it('a password of exactly 8 characters is accepted', async () => {
    const r = await h.popup('IMPORT_ACCOUNT', { name: 'A', mnemonic: TEST_MNEMONIC, password: '12345678', network: 'testnet' });
    expect(r.success).toBe(true);
    expect(Object.keys(h.storage.secrets)).toHaveLength(1);
  });
});

describe('L9 the address book keeps only valid addresses', () => {
  beforeEach(async () => {
    await h.setupWallet();
  });

  const refused: Array<[string, Record<string, unknown>, RegExp]> = [
    ['a string that is not an address', { name: 'n', address: 'not-an-address', network: 'testnet' }, /not a valid testnet address/i],
    ['a mainnet address on testnet', { name: 'n', address: MAINNET_ADDRESS, network: 'testnet' }, /not a valid testnet address/i],
    ['a testnet address on mainnet', { name: 'n', address: TESTNET_ADDRESS, network: 'mainnet' }, /not a valid mainnet address/i],
    ['an address with a changed character', { name: 'n', address: TESTNET_ADDRESS.slice(0, -1) + (TESTNET_ADDRESS.endsWith('a') ? 'b' : 'a'), network: 'testnet' }, /not a valid/i],
    ['an unknown network', { name: 'n', address: TESTNET_ADDRESS, network: 'regtest' }, /unknown network/i],
    ['a prototype key as the network', { name: 'n', address: TESTNET_ADDRESS, network: '__proto__' }, /unknown network/i],
    ['an address that is not a string', { name: 'n', address: [TESTNET_ADDRESS], network: 'testnet' }, /not a valid/i],
    ['an empty name', { name: '  ', address: TESTNET_ADDRESS, network: 'testnet' }, /name must be/i],
    ['a name that is not a string', { name: 42, address: TESTNET_ADDRESS, network: 'testnet' }, /name must be/i],
    ['a very long name', { name: 'x'.repeat(101), address: TESTNET_ADDRESS, network: 'testnet' }, /name must be/i],
    ['very long notes', { name: 'n', address: TESTNET_ADDRESS, network: 'testnet', notes: 'x'.repeat(1001) }, /notes must be/i],
  ];

  for (const [what, payload, error] of refused) {
    it(`${what} is refused and nothing is stored`, async () => {
      const r = await h.popup('ADD_CONTACT', payload);
      expect(r.success).toBe(false);
      expect(r.error).toMatch(error);
      expect(h.storage.addressBook ?? []).toEqual([]);
    });
  }

  it('a valid address for each network is kept', async () => {
    const t = await h.popup('ADD_CONTACT', { name: ' Alice ', address: ` ${TESTNET_ADDRESS} `, network: 'testnet', notes: 'hi' });
    const m = await h.popup('ADD_CONTACT', { name: 'Bob', address: MAINNET_ADDRESS, network: 'mainnet' });
    expect(t.success).toBe(true);
    expect(m.success).toBe(true);
    expect(h.storage.addressBook.map((c: any) => [c.name, c.address, c.network])).toEqual([
      ['Alice', TESTNET_ADDRESS, 'testnet'],
      ['Bob', MAINNET_ADDRESS, 'mainnet'],
    ]);
  });

  it('an update cannot change the address, and checks the name and notes', async () => {
    const added = await h.popup('ADD_CONTACT', { name: 'Alice', address: TESTNET_ADDRESS, network: 'testnet' });
    const id = added.data.id;

    const moved = await h.popup('UPDATE_CONTACT', { contactId: id, updates: { name: 'Alice', address: 'yEvil' } });
    expect(moved.success).toBe(true);
    expect(h.storage.addressBook[0].address).toBe(TESTNET_ADDRESS);

    const long = await h.popup('UPDATE_CONTACT', { contactId: id, updates: { name: 'x'.repeat(101) } });
    expect(long.success).toBe(false);
    const notes = await h.popup('UPDATE_CONTACT', { contactId: id, updates: { notes: { evil: true } } });
    expect(notes.success).toBe(false);
    expect(h.storage.addressBook[0].name).toBe('Alice');
  });
});
