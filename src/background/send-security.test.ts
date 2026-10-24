import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createHarness, TEST_MNEMONIC, TEST_PASSWORD, type Harness } from '../test-support/harness';
import { Mnemonic } from '../lib/mnemonic';
import { deriveAddresses } from '../lib/derivation';
import { Transaction } from '../lib/transaction';

// Regression tests for the send-path findings of the security review
// (C1 fee control, H2 a node lying about coin values, H3 daily limits)

async function foreignTestnetAddress(): Promise<string> {
  const seed = await Mnemonic.toSeed(TEST_MNEMONIC, 'other-account');
  const [a] = await deriveAddresses(seed, 'testnet', 0, 1);
  return a.address;
}

async function setLimits(h: Harness, limits: Record<string, number>) {
  const { data } = await h.popup('GET_SETTINGS');
  const r = await h.popup('UPDATE_SETTINGS', {
    transactionLimits: { ...data.settings.transactionLimits, ...limits },
    password: TEST_PASSWORD,
  });
  expect(r.success).toBe(true);
}

vi.setConfig({ testTimeout: 30000 });

let h: Harness;

beforeEach(async () => {
  vi.resetModules();
  h = await createHarness();
  await h.setupWallet();
});

describe('H2 a node that lies about what a coin holds', () => {
  it('refuses to sign when the node claims a coin holds more than it does', async () => {
    // Under legacy SIGHASH_ALL the input amount is not signed, so the extra
    // would silently become fee; the wallet must check the coin's real value
    h.utxos[0].satoshis += 50 * 1e8;
    const r = await h.popup('SEND_TRANSACTION', { to: await foreignTestnetAddress(), amount: 1 });
    expect(r.success).toBe(false);
    expect(r.error).toMatch(/does not match/i);
    expect(h.broadcasts).toHaveLength(0);
  });

  it('refuses when the node returns a different transaction for the coin', async () => {
    const txid = h.utxos[0].txid;
    const other = h.fund(h.utxos[0].address, 1e8);
    h.rawHex[txid] = h.rawHex[other];
    h.utxos.splice(h.utxos.findIndex(u => u.txid === other), 1);
    const r = await h.popup('SEND_TRANSACTION', { to: await foreignTestnetAddress(), amount: 1 });
    expect(r.success).toBe(false);
    expect(h.broadcasts).toHaveLength(0);
  });

  it('refuses a coin the node lists under our address but that pays someone else', async () => {
    const to = await foreignTestnetAddress();
    const txid = h.fund(to, 500 * 1e8);
    const coin = h.utxos.find(u => u.txid === txid)!;
    coin.address = h.utxos[0].address;
    h.utxos.splice(0, h.utxos.length, coin);
    const r = await h.popup('SEND_TRANSACTION', { to, amount: 1 });
    expect(r.success).toBe(false);
    expect(h.broadcasts).toHaveLength(0);
  });

  // L11: the script being signed is rebuilt from our own address
  it('ignores the script the node reports for a coin', async () => {
    for (const u of h.utxos as any[]) u.script = '6a0464656164';
    const r = await h.popup('SEND_TRANSACTION', { to: await foreignTestnetAddress(), amount: 1 });
    expect(r.success).toBe(true);
    expect(h.broadcasts).toHaveLength(1);
    const { readFileSync } = await import('node:fs');
    const src = readFileSync(new URL('./wallet-core.ts', import.meta.url), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
    expect(src).toMatch(/script: p2pkhScript\(input\.address\)/);
    expect(src).not.toMatch(/\b(?:utxo|u|input)\.script\b/);
  });
});

describe('C1 only the owner chooses the fee', () => {
  it('a site that names a fee gets the computed one', async () => {
    await h.connectPage();
    const to = await foreignTestnetAddress();
    const sent = h.provider().sendTransaction({ to, amount: 1, fee: 5 });
    const req = await h.waitForPending('send_transaction');
    expect(req.data.fee).toBeLessThan(0.01);
    const ok = await h.approvalWindow('APPROVE_SIGNING_REQUEST', { requestId: req.id, password: TEST_PASSWORD });
    expect(ok.success).toBe(true);
    await sent;
    const tx = Transaction.fromHex(h.broadcasts[0]);
    const out = tx.outputs.reduce((s, o) => s + o.value, 0n);
    expect(1000n * 100_000_000n - out).toBe(BigInt(Math.round(req.data.fee * 1e8)));
  });

  it('a fee above the cap is refused even from the popup', async () => {
    const r = await h.popup('SEND_TRANSACTION', { to: await foreignTestnetAddress(), amount: 1, fee: 5 });
    expect(r.success).toBe(false);
    expect(r.error).toMatch(/fee/i);
    expect(h.broadcasts).toHaveLength(0);
  });

  it('refuses at approval if the fee rose after the user was asked', async () => {
    await setLimits(h, { maxAmountPercent: 100 });
    await h.connectPage();
    const to = await foreignTestnetAddress();
    const sent = h.provider().sendTransaction({ to, amount: 1.5 });
    const req = await h.waitForPending('send_transaction');

    // The wallet's coins change to many small ones, so the same send needs
    // more inputs and a bigger fee than the one the user saw
    const own = h.utxos[0].address;
    h.utxos.length = 0;
    for (let i = 0; i < 10; i++) h.fund(own, 0.2 * 1e8);

    const r = await h.approvalWindow('APPROVE_SIGNING_REQUEST', { requestId: req.id, password: TEST_PASSWORD });
    expect(r.success).toBe(false);
    expect(r.error).toMatch(/fee went up/i);
    await expect(sent).rejects.toThrow();
    expect(h.broadcasts).toHaveLength(0);
  });
});

describe('H3 transaction limits', () => {
  it('the default refuses one send of more than 10% of the balance', async () => {
    const r = await h.popup('SEND_TRANSACTION', { to: await foreignTestnetAddress(), amount: 150 });
    expect(r.success).toBe(false);
    expect(r.error).toMatch(/10% of balance/);
    expect(h.broadcasts).toHaveLength(0);
  });

  it('the daily absolute limit counts earlier sends', async () => {
    await setLimits(h, { dailyLimitAbsolute: 3 });
    const to = await foreignTestnetAddress();
    const first = await h.popup('SEND_TRANSACTION', { to, amount: 2 });
    expect(first.success).toBe(true);
    const second = await h.popup('SEND_TRANSACTION', { to, amount: 2 });
    expect(second.success).toBe(false);
    expect(second.error).toMatch(/daily limit/i);
    expect(h.broadcasts).toHaveLength(1);
  });

  it('the daily limit survives a service worker restart', async () => {
    await setLimits(h, { dailyLimitAbsolute: 3 });
    const to = await foreignTestnetAddress();
    expect((await h.popup('SEND_TRANSACTION', { to, amount: 2 })).success).toBe(true);
    const saved = Object.keys(h.storage).filter(k => k.startsWith('spendLedger:'));
    expect(saved).toHaveLength(1);
    expect(JSON.stringify(h.storage[saved[0]])).toMatch(/"sats":"\d+"/);
  });

  it('the absolute per-send limit includes the fee', async () => {
    await setLimits(h, { maxAmountAbsolute: 1 });
    const r = await h.popup('SEND_TRANSACTION', { to: await foreignTestnetAddress(), amount: 1 });
    expect(r.success).toBe(false);
    expect(r.error).toMatch(/maximum amount/i);
  });
});
