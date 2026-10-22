import { describe, expect, it } from 'vitest';
import { walletCore } from './wallet-core';
import { Mnemonic } from '../lib/mnemonic';
import { deriveAddresses } from '../lib/derivation';
import { Address } from '../lib/address';

const MNEMONIC = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';

async function fixture() {
  const own = await deriveAddresses(await Mnemonic.toSeed(MNEMONIC), 'testnet', 0, 1);
  const [dest] = await deriveAddresses(await Mnemonic.toSeed(MNEMONIC, 'other-account'), 'testnet', 0, 1);
  const hash = Array.from(Address.decode(own[0].address).hash, (b: number) => b.toString(16).padStart(2, '0')).join('');
  const utxos = [{
    txid: 'cd'.repeat(32), vout: 0, address: own[0].address, amount: 10,
    scriptPubKey: `76a914${hash}88ac`, confirmations: 10,
  }];
  return { own, dest: dest.address, utxos };
}

describe('#8 dust: buildTransaction refuses a send below 0.0000546 DIVI', () => {
  it('refuses 0.0000545 DIVI', async () => {
    const { own, dest, utxos } = await fixture();
    expect(() => walletCore.buildTransaction(utxos, own, { to: dest, amount: 0.0000545 }, 'testnet'))
      .toThrow(/dust/i);
  });

  it('refuses zero, negative and non-numeric amounts', async () => {
    const { own, dest, utxos } = await fixture();
    for (const amount of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => walletCore.buildTransaction(utxos, own, { to: dest, amount }, 'testnet')).toThrow();
    }
  });

  it('accepts exactly 0.0000546 DIVI', async () => {
    const { own, dest, utxos } = await fixture();
    const built = walletCore.buildTransaction(utxos, own, { to: dest, amount: 0.0000546 }, 'testnet');
    expect(built.hex.length).toBeGreaterThan(0);
  });
});
