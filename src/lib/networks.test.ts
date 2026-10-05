import { describe, expect, it } from 'vitest';
import { NETWORKS } from '../shared/constants';
import { Address } from './address';
import { Base58 } from './base58';
import { Hash } from './hash';
import { Mnemonic } from './mnemonic';
import { deriveAddresses } from './derivation';

// Values from IronDivi (crates/divi-wallet/src/address.rs, hd.rs) in `divi` chain mode.
// If one of these fails, the extension no longer agrees with the node.
describe('network parameters match IronDivi', () => {
  it('mainnet', () => {
    expect(NETWORKS.mainnet).toMatchObject({ coinType: 301, addressPrefix: 0x1e, scriptPrefix: 0x0d });
  });
  it('testnet', () => {
    expect(NETWORKS.testnet).toMatchObject({ coinType: 1, addressPrefix: 0x8b, scriptPrefix: 0x13 });
  });
});

async function encodeCheck(version: number): Promise<string> {
  const payload = new Uint8Array(21);
  payload[0] = version;
  payload.fill(7, 1);
  const checksum = (await Hash.doubleSha256(payload)).slice(0, 4);
  return Base58.encode(new Uint8Array([...payload, ...checksum]));
}

describe('address validation is network-specific', () => {
  it('accepts each network\'s P2PKH address only on that network', async () => {
    const main = await encodeCheck(NETWORKS.mainnet.addressPrefix);
    const test = await encodeCheck(NETWORKS.testnet.addressPrefix);
    expect(main[0]).toBe('D');
    expect(Address.validate(main, 'mainnet')).toBe(true);
    expect(Address.validate(main, 'testnet')).toBe(false);
    expect(Address.validate(test, 'testnet')).toBe(true);
    expect(Address.validate(test, 'mainnet')).toBe(false);
  });
});

describe('one seed derives distinct accounts per network', () => {
  const mnemonic = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';

  it('uses coin type 301 on mainnet and 1 on testnet', async () => {
    const seed = await Mnemonic.toSeed(mnemonic);
    const [main] = await deriveAddresses(seed, 'mainnet', 0, 1);
    const [test] = await deriveAddresses(await Mnemonic.toSeed(mnemonic), 'testnet', 0, 1);
    expect(main.path).toBe("m/44'/301'/0'/0/0");
    expect(test.path).toBe("m/44'/1'/0'/0/0");
    expect(Address.validate(main.address, 'mainnet')).toBe(true);
    expect(Address.validate(test.address, 'testnet')).toBe(true);
  });
});
