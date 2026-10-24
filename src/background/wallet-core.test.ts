import { describe, expect, it } from 'vitest';
import { walletCore, p2pkhScript, MAX_FEE_SATS, type SendIntent, type UTXO } from './wallet-core';
import { Mnemonic } from '../lib/mnemonic';
import { deriveAddresses } from '../lib/derivation';
import { HDKey } from '../lib/hdkey';
import { Transaction, MAX_MONEY } from '../lib/transaction';
import { NETWORKS } from '../shared/constants';

const MNEMONIC = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
const COIN = 100_000_000n;

function utxo(address: string, divi: number, txidByte = 'cd', vout = 0): UTXO {
  const satoshis = BigInt(Math.round(divi * 1e8));
  return { txid: txidByte.repeat(32), vout, address, satoshis, amount: divi, confirmations: 10 };
}

async function fixture() {
  const seed = await Mnemonic.toSeed(MNEMONIC);
  const own = await deriveAddresses(seed, 'testnet', 0, 2);
  const [dest] = await deriveAddresses(await Mnemonic.toSeed(MNEMONIC, 'other-account'), 'testnet', 0, 1);
  const utxos = [utxo(own[0].address, 10)];
  return { seed, own, dest: dest.address, utxos };
}

async function keysFor(seed: Uint8Array, indices: number[]): Promise<Uint8Array[]> {
  const hd = await HDKey.fromMasterSeed(seed);
  const coinType = NETWORKS.testnet.coinType;
  return Promise.all(indices.map(async i => (await hd.derive(`m/44'/${coinType}'/0'/0/${i}`)).privateKey!));
}

function intentFor(to: string, amountSats: bigint, own: { address: string }[]): SendIntent {
  return { to, amountSats, ownAddresses: own.map(a => a.address), network: 'testnet' };
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
    expect(built.amountSats).toBe(5460n);
  });
});

describe('fees (C1)', () => {
  it('refuses a fee above the cap', async () => {
    const { own, dest, utxos } = await fixture();
    expect(() => walletCore.buildTransaction(utxos, own, { to: dest, amount: 1, fee: 5 }, 'testnet'))
      .toThrow(/fee/i);
  });

  it('refuses a fee below the relay minimum', async () => {
    const { own, dest, utxos } = await fixture();
    expect(() => walletCore.buildTransaction(utxos, own, { to: dest, amount: 1, fee: 0.00000001 }, 'testnet'))
      .toThrow(/fee/i);
  });

  it('pays exactly in - out as fee, and never more than the cap', async () => {
    const { own, dest, utxos } = await fixture();
    const built = walletCore.buildTransaction(utxos, own, { to: dest, amount: 1 }, 'testnet');
    const out = built.tx.outputs.reduce((s, o) => s + o.value, 0n);
    expect(10n * COIN - out).toBe(built.feeSats);
    expect(built.feeSats <= MAX_FEE_SATS).toBe(true);
  });

  it('sends change back to one of the account\'s own addresses', async () => {
    const { own, dest, utxos } = await fixture();
    const built = walletCore.buildTransaction(utxos, own, { to: dest, amount: 1 }, 'testnet');
    expect(built.tx.outputs).toHaveLength(2);
    expect(Transaction.prototype.toHex.call(built.tx)).toBe(built.hex);
    const change = built.tx.outputs[1];
    expect(change.script).toBe(p2pkhScript(own[0].address));
  });
});

describe('coin selection (H1, L4)', () => {
  it('ignores coins the node says belong to someone else', async () => {
    const { own, dest } = await fixture();
    const utxos = [utxo(dest, 1000), utxo(own[0].address, 1, 'ab')];
    expect(() => walletCore.buildTransaction(utxos, own, { to: dest, amount: 5 }, 'testnet'))
      .toThrow(/insufficient/i);
  });

  it('keeps whole satoshis for large balances', async () => {
    const { own, dest } = await fixture();
    const big: UTXO = { ...utxo(own[0].address, 0), satoshis: 123_456_789_012_345_678n, amount: 1234567890 };
    const built = walletCore.buildTransaction([big], own, { to: dest, amount: 1 }, 'testnet');
    const out = built.tx.outputs.reduce((s, o) => s + o.value, 0n);
    expect(big.satoshis - out).toBe(built.feeSats);
  });

  it('refuses a send to the wrong network', async () => {
    const { own, utxos } = await fixture();
    const [mainnet] = await deriveAddresses(await Mnemonic.toSeed(MNEMONIC), 'mainnet', 0, 1);
    expect(() => walletCore.buildTransaction(utxos, own, { to: mainnet.address, amount: 1 }, 'testnet')).toThrow();
  });
});

describe('signing checks the transaction against what was asked (M9)', () => {
  it('signs a transaction that matches the intent', async () => {
    const { seed, own, dest, utxos } = await fixture();
    const built = walletCore.buildTransaction(utxos, own, { to: dest, amount: 1 }, 'testnet');
    const keys = await keysFor(seed, built.inputIndices);
    const hex = await walletCore.signTransaction(built, keys, intentFor(dest, COIN, own));
    const signed = Transaction.fromHex(hex);
    expect(signed.inputs).toHaveLength(1);
    expect((signed.inputs[0].script as Uint8Array).length).toBeGreaterThan(100);
    expect(signed.outputs[0].value).toBe(COIN);
  });

  it('refuses when the recipient was changed', async () => {
    const { seed, own, dest, utxos } = await fixture();
    const built = walletCore.buildTransaction(utxos, own, { to: dest, amount: 1 }, 'testnet');
    built.tx.outputs[0].script = p2pkhScript(own[1].address);
    const keys = await keysFor(seed, built.inputIndices);
    await expect(walletCore.signTransaction(built, keys, intentFor(dest, COIN, own))).rejects.toThrow();
  });

  it('refuses when the amount was changed', async () => {
    const { seed, own, dest, utxos } = await fixture();
    const built = walletCore.buildTransaction(utxos, own, { to: dest, amount: 1 }, 'testnet');
    const keys = await keysFor(seed, built.inputIndices);
    await expect(walletCore.signTransaction(built, keys, intentFor(dest, 2n * COIN, own))).rejects.toThrow();
  });

  it('refuses when change goes to an address that is not the account\'s', async () => {
    const { seed, own, dest, utxos } = await fixture();
    const built = walletCore.buildTransaction(utxos, own, { to: dest, amount: 1 }, 'testnet');
    built.tx.outputs[1].script = p2pkhScript(dest);
    const keys = await keysFor(seed, built.inputIndices);
    await expect(walletCore.signTransaction(built, keys, intentFor(dest, COIN, own))).rejects.toThrow();
  });

  it('refuses an extra output', async () => {
    const { seed, own, dest, utxos } = await fixture();
    const built = walletCore.buildTransaction(utxos, own, { to: dest, amount: 1 }, 'testnet');
    built.tx.outputs.push({ value: 1000n, script: p2pkhScript(dest) });
    const keys = await keysFor(seed, built.inputIndices);
    await expect(walletCore.signTransaction(built, keys, intentFor(dest, COIN, own))).rejects.toThrow();
  });

  it('refuses a key that does not own the coin', async () => {
    const { seed, own, dest, utxos } = await fixture();
    const built = walletCore.buildTransaction(utxos, own, { to: dest, amount: 1 }, 'testnet');
    const keys = await keysFor(seed, [1]);
    await expect(walletCore.signTransaction(built, keys, intentFor(dest, COIN, own))).rejects.toThrow();
  });

  it('refuses a zero key', async () => {
    const { own, dest, utxos } = await fixture();
    const built = walletCore.buildTransaction(utxos, own, { to: dest, amount: 1 }, 'testnet');
    await expect(walletCore.signTransaction(built, [new Uint8Array(32)], intentFor(dest, COIN, own))).rejects.toThrow();
  });
});

describe('transaction parsing (L5)', () => {
  it('round-trips and refuses trailing bytes', async () => {
    const { own, dest, utxos } = await fixture();
    const built = walletCore.buildTransaction(utxos, own, { to: dest, amount: 1 }, 'testnet');
    expect(Transaction.fromHex(built.hex).toHex()).toBe(built.hex);
    expect(Transaction.fromHex(built.hex).txid()).toBe(built.txid);
    expect(() => Transaction.fromHex(built.hex + '00')).toThrow(/trailing/);
  });

  it('refuses output values outside 0..MAX_MONEY when serialising', () => {
    const tx = new Transaction();
    tx.inputs.push({ txid: 'ab'.repeat(32), vout: 0, script: '', sequence: 0xffffffff });
    for (const value of [-1n, MAX_MONEY + 1n]) {
      tx.outputs = [{ value, script: '' }];
      expect(() => tx.toHex()).toThrow(/value/);
    }
  });

  it('refuses a short txid', () => {
    const tx = new Transaction();
    tx.inputs.push({ txid: 'ab', vout: 0, script: '', sequence: 0xffffffff });
    expect(() => tx.toHex()).toThrow(/txid/);
  });
});
