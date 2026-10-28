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

async function setLimits(h: Harness, limits: Record<string, number | boolean>) {
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
    const r = await h.popup('SEND_TRANSACTION', { password: TEST_PASSWORD, to: await foreignTestnetAddress(), amount: 1 });
    expect(r.success).toBe(false);
    expect(r.error).toMatch(/does not match/i);
    expect(h.broadcasts).toHaveLength(0);
  });

  it('refuses when the node returns a different transaction for the coin', async () => {
    const txid = h.utxos[0].txid;
    const other = h.fund(h.utxos[0].address, 1e8);
    h.rawHex[txid] = h.rawHex[other];
    h.utxos.splice(h.utxos.findIndex(u => u.txid === other), 1);
    const r = await h.popup('SEND_TRANSACTION', { password: TEST_PASSWORD, to: await foreignTestnetAddress(), amount: 1 });
    expect(r.success).toBe(false);
    expect(h.broadcasts).toHaveLength(0);
  });

  it('refuses a coin the node lists under our address but that pays someone else', async () => {
    const to = await foreignTestnetAddress();
    const txid = h.fund(to, 500 * 1e8);
    const coin = h.utxos.find(u => u.txid === txid)!;
    coin.address = h.utxos[0].address;
    h.utxos.splice(0, h.utxos.length, coin);
    const r = await h.popup('SEND_TRANSACTION', { password: TEST_PASSWORD, to, amount: 1 });
    expect(r.success).toBe(false);
    expect(h.broadcasts).toHaveLength(0);
  });

  // L11: the script being signed is rebuilt from our own address
  it('ignores the script the node reports for a coin', async () => {
    for (const u of h.utxos as any[]) u.script = '6a0464656164';
    const r = await h.popup('SEND_TRANSACTION', { password: TEST_PASSWORD, to: await foreignTestnetAddress(), amount: 1 });
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
    const r = await h.popup('SEND_TRANSACTION', { password: TEST_PASSWORD, to: await foreignTestnetAddress(), amount: 1, fee: 5 });
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
    const r = await h.popup('SEND_TRANSACTION', { password: TEST_PASSWORD, to: await foreignTestnetAddress(), amount: 150 });
    expect(r.success).toBe(false);
    expect(r.error).toMatch(/10% of your balance per send/);
    expect(h.broadcasts).toHaveLength(0);
  });

  it('the daily absolute limit counts earlier sends', async () => {
    await setLimits(h, { dailyLimitAbsolute: 3 });
    // A second coin, so the second send is not refused for reusing the first (EXT-27)
    h.fund(h.utxos[0].address, 1000 * 1e8);
    const to = await foreignTestnetAddress();
    const first = await h.popup('SEND_TRANSACTION', { password: TEST_PASSWORD, to, amount: 2 });
    expect(first.success).toBe(true);
    const second = await h.popup('SEND_TRANSACTION', { password: TEST_PASSWORD, to, amount: 2 });
    expect(second.success).toBe(false);
    expect(second.error).toMatch(/Over your spending limit: 3 DIVI a day \(up to 0\.99995 DIVI now, fee included\)/);
    expect(h.broadcasts).toHaveLength(1);
  });

  it('the daily limit survives a service worker restart', async () => {
    await setLimits(h, { dailyLimitAbsolute: 3 });
    const to = await foreignTestnetAddress();
    expect((await h.popup('SEND_TRANSACTION', { password: TEST_PASSWORD, to, amount: 2 })).success).toBe(true);
    const saved = Object.keys(h.storage).filter(k => k.startsWith('spendLedger:'));
    expect(saved).toHaveLength(1);
    expect(JSON.stringify(h.storage[saved[0]])).toMatch(/"sats":"\d+"/);
  });

  it('the absolute per-send limit includes the fee', async () => {
    await setLimits(h, { maxAmountAbsolute: 1 });
    const r = await h.popup('SEND_TRANSACTION', { password: TEST_PASSWORD, to: await foreignTestnetAddress(), amount: 1 });
    expect(r.success).toBe(false);
    expect(r.error).toMatch(/1 DIVI per send/);
  });
});

describe('EXT-16 limits that a node cannot switch off', () => {
  it('a new wallet has a 25% daily limit', async () => {
    const { data } = await h.popup('GET_SETTINGS');
    expect(data.settings.transactionLimits.dailyLimitPercent).toBe(25);
    const { DEFAULT_SETTINGS } = await import('../shared/storage');
    expect(DEFAULT_SETTINGS.transactionLimits.dailyLimitPercent).toBe(25);
  });

  it('settings saved before 0.0.5 with no daily limit get the 25% default', async () => {
    const { data } = await h.popup('GET_SETTINGS');
    const old = { ...data.settings, transactionLimits: { ...data.settings.transactionLimits, dailyLimitPercent: 0, dailyLimitAbsolute: 0 } };
    delete old.limitsVersion;
    h.storage.settings = old;
    const after = (await h.popup('GET_SETTINGS')).data.settings;
    expect(after.transactionLimits.dailyLimitPercent).toBe(25);
    expect(after.limitsVersion).toBe(2);
  });

  it('an owner who turned the daily limit off since 0.0.5 keeps it off', async () => {
    await setLimits(h, { dailyLimitPercent: 0 });
    expect(h.storage.settings.limitsVersion).toBe(2);
    expect((await h.popup('GET_SETTINGS')).data.settings.transactionLimits.dailyLimitPercent).toBe(0);
  });

  it('an old daily limit in DIVI is kept and no percentage is added', async () => {
    const { data } = await h.popup('GET_SETTINGS');
    const old = { ...data.settings, transactionLimits: { ...data.settings.transactionLimits, dailyLimitPercent: 0, dailyLimitAbsolute: 50 } };
    delete old.limitsVersion;
    h.storage.settings = old;
    const after = (await h.popup('GET_SETTINGS')).data.settings;
    expect(after.transactionLimits).toMatchObject({ dailyLimitPercent: 0, dailyLimitAbsolute: 50 });
  });

  it('the daily default stops the fourth send of just under 10%', async () => {
    // The fake node does not take spent coins away, so the balance stays at
    // 1000 and the day's share is spent / (balance + spent). The 1000 is in
    // ten coins, since a coin a pending send spent is not used again (EXT-27)
    const own = h.utxos[0].address;
    h.utxos.length = 0;
    for (let i = 0; i < 10; i++) h.fund(own, 100 * 1e8);
    const to = await foreignTestnetAddress();
    for (let i = 0; i < 3; i++) {
      expect((await h.popup('SEND_TRANSACTION', { password: TEST_PASSWORD, to, amount: 95 })).success).toBe(true);
    }
    const fourth = await h.popup('SEND_TRANSACTION', { password: TEST_PASSWORD, to, amount: 95 });
    expect(fourth.success).toBe(false);
    expect(fourth.error).toMatch(/of your balance a day/);
    expect(h.broadcasts).toHaveLength(3);
  });

  it('a node that hides coins cannot shrink the percentages below the balance seen this week', async () => {
    expect((await h.popup('GET_BALANCE')).data.balance).toBe(1000);
    // The node now shows only a 20 DIVI coin: 5 DIVI is 25% of that, but
    // well under 10% of the 1000 the wallet saw
    const own = h.utxos[0].address;
    h.utxos.length = 0;
    h.fund(own, 20 * 1e8);
    const r = await h.popup('SEND_TRANSACTION', { password: TEST_PASSWORD, to: await foreignTestnetAddress(), amount: 5 });
    expect(r.success).toBe(true);
    expect(Object.keys(h.storage).filter(k => k.startsWith('balanceRecord:'))).toHaveLength(1);
  });

  it('a balance seen more than a week ago no longer counts', async () => {
    await h.popup('GET_BALANCE');
    const key = Object.keys(h.storage).find(k => k.startsWith('balanceRecord:'))!;
    h.storage[key][0].time -= 8 * 24 * 60 * 60 * 1000;
    const own = h.utxos[0].address;
    h.utxos.length = 0;
    h.fund(own, 20 * 1e8);
    const r = await h.popup('SEND_TRANSACTION', { password: TEST_PASSWORD, to: await foreignTestnetAddress(), amount: 5 });
    expect(r.success).toBe(false);
    expect(r.error).toMatch(/10% of your balance per send/);
  });
});

describe('EXT-16 the owner can see and set the daily limits', () => {
  it('the popup has daily limit inputs wired to the settings', async () => {
    const { readFileSync } = await import('node:fs');
    const html = readFileSync('src/popup/popup.html', 'utf8');
    const ui = readFileSync('src/popup/settings-ui.ts', 'utf8');
    for (const id of ['setting-daily-limit-percent', 'setting-daily-limit-absolute']) {
      expect(html).toContain(`id="${id}"`);
      expect(ui).toContain(`'${id}'`);
    }
    expect(ui).toMatch(/dailyLimitPercent: Math\.min\(100/);
    expect(ui).toMatch(/dailyLimitAbsolute: Math\.max\(0/);
  });
});

describe('ADR 0002 the Spending limits switch', () => {
  it('a new wallet has the switch on', async () => {
    const { data } = await h.popup('GET_SETTINGS');
    expect(data.settings.transactionLimits.enabled).toBe(true);
  });

  it('switching it off needs the password, switching it on does not', async () => {
    const { data } = await h.popup('GET_SETTINGS');
    const off = { ...data.settings.transactionLimits, enabled: false };
    expect((await h.popup('UPDATE_SETTINGS', { transactionLimits: off })).success).toBe(false);
    expect((await h.popup('UPDATE_SETTINGS', { transactionLimits: off, password: TEST_PASSWORD })).success).toBe(true);
    const on = { ...off, enabled: true };
    expect((await h.popup('UPDATE_SETTINGS', { transactionLimits: on })).success).toBe(true);
  });

  it('a switch that is not true or false is refused', async () => {
    const r = await h.popup('UPDATE_SETTINGS', { transactionLimits: { enabled: 'no' }, password: TEST_PASSWORD });
    expect(r).toEqual({ success: false, error: 'Invalid limits' });
  });

  it('off, the whole wallet can be sent, past the fixed DIVI caps too', async () => {
    await setLimits(h, { maxAmountAbsolute: 1, dailyLimitAbsolute: 1 });
    await setLimits(h, { enabled: false });
    const r = await h.popup('SEND_TRANSACTION', { password: TEST_PASSWORD, to: await foreignTestnetAddress(), amount: 999 });
    expect(r.success).toBe(true);
    expect(h.broadcasts).toHaveLength(1);
  });

  it('off, every send still needs the password', async () => {
    await setLimits(h, { enabled: false });
    const r = await h.popup('SEND_TRANSACTION', { to: await foreignTestnetAddress(), amount: 999 });
    expect(r.success).toBe(false);
    expect(h.broadcasts).toHaveLength(0);
  });

  it('a refusal names the limit, the most that can go now, and where to change it', async () => {
    const r = await h.popup('SEND_TRANSACTION', { password: TEST_PASSWORD, to: await foreignTestnetAddress(), amount: 500 });
    expect(r.error).toBe('Over your spending limit: 10% of your balance per send (up to 100 DIVI now, fee included). Settings → Spending limits');
  });

  for (const [what, numbers, enabled] of [
    ['with a limit set is on', { maxAmountPercent: 10, dailyLimitPercent: 0 }, true],
    ['with only a DIVI cap set is on', { maxAmountPercent: 0, dailyLimitPercent: 0, maxAmountAbsolute: 50 }, true],
    ['with every limit at 0 is off', { maxAmountPercent: 0, dailyLimitPercent: 0, maxAmountAbsolute: 0, dailyLimitAbsolute: 0 }, false],
  ] as const) {
    it(`settings from before the switch ${what}`, async () => {
      const { data } = await h.popup('GET_SETTINGS');
      const limits = { ...data.settings.transactionLimits, ...numbers };
      delete limits.enabled;
      h.storage.settings = { ...data.settings, transactionLimits: limits };
      expect((await h.popup('GET_SETTINGS')).data.settings.transactionLimits.enabled).toBe(enabled);
    });
  }
});
