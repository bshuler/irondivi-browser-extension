import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createHarness, TEST_MNEMONIC, TEST_PASSWORD, type Harness } from '../test-support/harness';
import { Mnemonic } from '../lib/mnemonic';
import { deriveAddresses } from '../lib/derivation';
import { Transaction } from '../lib/transaction';
import { parseDiviAmount, satoshisText } from './wallet-core';

// Regression tests for the security review's EXT-25: a site's amount went
// through a double and toFixed(8), so above about 9e7 DIVI, or with more than
// 8 decimals, the amount signed was a rounded version of the one asked for

vi.setConfig({ testTimeout: 30000 });

describe('EXT-25 parseDiviAmount is exact', () => {
  it('a decimal string is parsed straight to satoshis, however large', () => {
    expect(parseDiviAmount('123456789.12345678')).toBe(12345678912345678n);
    expect(parseDiviAmount('0.00000001')).toBe(1n);
    expect(parseDiviAmount('5')).toBe(500000000n);
  });

  it('a number is accepted only where a double holds it to the satoshi', () => {
    expect(parseDiviAmount(1.5)).toBe(150000000n);
    expect(parseDiviAmount(0.1)).toBe(10000000n);
    expect(parseDiviAmount(1e-7)).toBe(10n);
    expect(() => parseDiviAmount(123456789.1)).toThrow(/decimal string/);
    expect(() => parseDiviAmount(0.123456789)).toThrow(/8 decimal places/);
  });

  for (const bad of ['', '1.', '.5', '-1', '1e5', '0x10', ' 1', '1.123456789', '0', '0.00000000', '1,5', NaN, Infinity, -1, 0, null, {}, [1], 10n]) {
    it(`${typeof bad === 'string' ? JSON.stringify(bad) : String(bad)} is refused`, () => {
      expect(() => parseDiviAmount(bad)).toThrow(/Invalid amount/);
    });
  }

  it('satoshisText is the exact inverse', () => {
    for (const s of ['123456789.12345678', '0.00000001', '5', '21000000.1']) {
      expect(satoshisText(parseDiviAmount(s))).toBe(s);
    }
    expect(satoshisText(-150000000n)).toBe('-1.5');
  });
});

describe('EXT-25 a site\'s amount is shown and signed exactly', () => {
  let h: Harness;
  let to: string;

  beforeEach(async () => {
    vi.resetModules();
    h = await createHarness();
    await h.setupWallet();
    const seed = await Mnemonic.toSeed(TEST_MNEMONIC, 'other-account');
    to = (await deriveAddresses(seed, 'testnet', 0, 1))[0].address;
  });

  it('an amount as a string reaches the approval window and the transaction to the satoshi', async () => {
    await h.connectPage();
    const sent = h.provider().sendTransaction({ to, amount: '0.12345678' });
    const req = await h.waitForPending('send_transaction');
    expect(req.data.amount).toBe('0.12345678');
    expect(req.data.total).toBe(satoshisText(12345678n + BigInt(Math.round(req.data.fee * 1e8))));
    expect((await h.approvalWindow('APPROVE_SIGNING_REQUEST', { requestId: req.id, password: TEST_PASSWORD })).success).toBe(true);
    await sent;
    expect(h.broadcasts).toHaveLength(1);
    expect(Transaction.fromHex(h.broadcasts[0]).outputs[0].value).toBe(12345678n);
  });

  it('a number with more than 8 decimals is refused, not rounded', async () => {
    await h.connectPage();
    const windows = h.createdWindows.length;
    const r = await h.fromTab('SEND_TRANSACTION', { to, amount: 0.123456789 });
    expect(r.success).toBe(false);
    expect(r.error).toMatch(/8 decimal places/);
    expect(h.createdWindows).toHaveLength(windows);
  });

  it('the popup sends what the owner typed, as text', async () => {
    const r = await h.popup('SEND_TRANSACTION', { password: TEST_PASSWORD, to, amount: '1.00000001' });
    expect(r.success).toBe(true);
    expect(Transaction.fromHex(h.broadcasts[0]).outputs[0].value).toBe(100000001n);
  });
});
