import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createHarness, TEST_MNEMONIC, TEST_PASSWORD, type Harness } from '../test-support/harness';
import { Mnemonic } from '../lib/mnemonic';
import { deriveAddresses } from '../lib/derivation';
import { bytesToHex, opReturnScript, Transaction } from '../lib/transaction';
import { walletCore } from './wallet-core';
import { CAPABILITIES, ERR, errorCode } from '../shared/provider-errors';

// IronDivi Connect "memo" capability: sendTransaction({to, amount, memo})
// sends the memo, UTF-8 and 1 to 599 bytes, unchanged in one OP_RETURN
// output, or refuses; it never sends without it. Also the capabilities list
// and the error codes a site is given.

vi.setConfig({ testTimeout: 30000 });

const scriptHex = (s: Uint8Array | string) => typeof s === 'string' ? s : bytesToHex(s);

async function foreignTestnetAddress(): Promise<string> {
  const seed = await Mnemonic.toSeed(TEST_MNEMONIC, 'other-account');
  const [a] = await deriveAddresses(seed, 'testnet', 0, 1);
  return a.address;
}

describe('the OP_RETURN script', () => {
  const hex = (text: string) => bytesToHex(new TextEncoder().encode(text));

  it('pushes up to 75 bytes directly, 76-255 with PUSHDATA1 and 256-599 with PUSHDATA2', () => {
    expect(opReturnScript('hi')).toBe('6a02' + hex('hi'));
    expect(opReturnScript('x'.repeat(75))).toBe('6a4b' + hex('x'.repeat(75)));
    expect(opReturnScript('x'.repeat(76))).toBe('6a4c4c' + hex('x'.repeat(76)));
    expect(opReturnScript('x'.repeat(255))).toBe('6a4cff' + hex('x'.repeat(255)));
    expect(opReturnScript('x'.repeat(256))).toBe('6a4d0001' + hex('x'.repeat(256)));
    expect(opReturnScript('x'.repeat(300))).toBe('6a4d2c01' + hex('x'.repeat(300)));
    expect(opReturnScript('x'.repeat(512))).toBe('6a4d0002' + hex('x'.repeat(512)));
    // A Divi Name Service record is at most 599 bytes (SPEC §7)
    expect(opReturnScript('x'.repeat(599))).toBe('6a4d5702' + hex('x'.repeat(599)));
    expect(() => opReturnScript('x'.repeat(600))).toThrow(/599/);
  });

  it('counts UTF-8 bytes, not characters', () => {
    // 200 three-byte characters is 600 bytes
    expect(() => opReturnScript('€'.repeat(200))).toThrow();
    expect(opReturnScript('€'.repeat(199)).startsWith('6a4d5502')).toBe(true);
  });

  for (const [what, memo] of [['empty', ''], ['over 599 bytes', 'x'.repeat(600)], ['a lone surrogate', 'a\ud800b'], ['not text', 42]] as const) {
    it(`refuses ${what}`, async () => {
      expect(() => opReturnScript(memo as string)).toThrow();
      const to = await foreignTestnetAddress();
      expect(() => walletCore.checkRequest({ to, amount: 1, memo: memo as string }, 'testnet')).toThrow(/memo/i);
    });
  }
});

describe('error codes', () => {
  it('map the background\'s messages', () => {
    expect(errorCode('User rejected the request')).toBe(ERR.REJECTED);
    expect(errorCode('NOT_CONNECTED')).toBe(ERR.NOT_CONNECTED);
    expect(errorCode('Unsupported option: x')).toBe(ERR.UNSUPPORTED);
    expect(errorCode('Wallet is locked')).toBe(ERR.LOCKED);
    expect(errorCode('Invalid memo: it must be text of 1 to 599 bytes (UTF-8)')).toBe(ERR.INVALID_PARAMS);
    expect(errorCode('The wallet cannot make this payment')).toBe(ERR.INTERNAL);
  });
});

describe('a site sending with a memo', () => {
  let h: Harness;

  beforeEach(async () => {
    vi.resetModules();
    h = await createHarness();
    await h.setupWallet();
  });

  it('connect says the wallet supports memo, and so does window.irondivi', async () => {
    await h.connectPage();
    expect(h.provider().capabilities).toEqual(['memo']);
    expect([...CAPABILITIES]).toEqual(['memo']);
    const again = await h.fromTab('CONNECT');
    expect(again.data.capabilities).toEqual(['memo']);
  });

  it('a connect asking for the other network is refused with 4901 and opens no window', async () => {
    await h.connectPage();
    const windows = h.createdWindows.length;
    const r = await h.fromTab('CONNECT', { network: 'mainnet' });
    expect(r.success).toBe(false);
    expect(r.code).toBe(ERR.NETWORK_MISMATCH);
    expect(h.createdWindows).toHaveLength(windows);
    await expect(h.provider().connect({ network: 'mainnet' })).rejects.toMatchObject({ code: 4901 });
  });

  it('the memo is shown for approval and sent unchanged in one OP_RETURN output', async () => {
    await h.connectPage();
    const memo = 'order #42 — ünïcode ✓ ' + 'x'.repeat(280);
    const to = await foreignTestnetAddress();
    const sent = h.provider().sendTransaction({ to, amount: 1, memo });
    const req = await h.waitForPending('send_transaction');
    expect(req.data.memo).toBe(memo);
    const ok = await h.approvalWindow('APPROVE_SIGNING_REQUEST', { requestId: req.id, password: TEST_PASSWORD });
    expect(ok.success).toBe(true);
    await sent;
    expect(h.broadcasts).toHaveLength(1);
    const tx = Transaction.fromHex(h.broadcasts[0]);
    const memos = tx.outputs.filter(o => scriptHex(o.script).startsWith('6a'));
    expect(memos).toHaveLength(1);
    expect(memos[0].value).toBe(0n);
    expect(scriptHex(memos[0].script)).toBe(opReturnScript(memo));
  });

  it('a send without a memo has no OP_RETURN output', async () => {
    await h.connectPage();
    const sent = h.provider().sendTransaction({ to: await foreignTestnetAddress(), amount: 1 });
    const req = await h.waitForPending('send_transaction');
    expect(req.data.memo).toBeUndefined();
    await h.approvalWindow('APPROVE_SIGNING_REQUEST', { requestId: req.id, password: TEST_PASSWORD });
    await sent;
    const tx = Transaction.fromHex(h.broadcasts[0]);
    expect(tx.outputs.some(o => scriptHex(o.script).startsWith('6a'))).toBe(false);
  });

  it('a memo that cannot be attached is refused before any window opens, and nothing is sent', async () => {
    await h.connectPage();
    const windows = h.createdWindows.length;
    const to = await foreignTestnetAddress();
    for (const memo of ['', 'x'.repeat(600), 'a\ud800b', 7]) {
      const r = await h.fromTab('SEND_TRANSACTION', { to, amount: 1, memo });
      expect(r.success).toBe(false);
      expect(r.error).toMatch(/memo/i);
    }
    expect(h.createdWindows).toHaveLength(windows);
    expect(h.broadcasts).toHaveLength(0);
  });

  it('an option the wallet does not know is refused with 4200, not dropped', async () => {
    await h.connectPage();
    const to = await foreignTestnetAddress();
    const r = await h.fromTab('SEND_TRANSACTION', { to, amount: 1, data: 'x' });
    expect(r).toMatchObject({ success: false, code: ERR.UNSUPPORTED });
    await expect(h.provider().sendTransaction({ to, amount: 1, data: 'x' } as any))
      .rejects.toMatchObject({ code: 4200 });
    expect(h.broadcasts).toHaveLength(0);
  });

  it('opReturn is the memo by another name: a 599-byte record is shown and sent', async () => {
    await h.connectPage();
    const record = 'dvns1 ' + 'r'.repeat(593);
    const to = await foreignTestnetAddress();
    const sent = h.provider().request({ method: 'irondivi_sendTransaction', params: { to, amount: 1, opReturn: record } });
    const req = await h.waitForPending('send_transaction');
    expect(req.data.memo).toBe(record);
    await h.approvalWindow('APPROVE_SIGNING_REQUEST', { requestId: req.id, password: TEST_PASSWORD });
    await sent;
    const tx = Transaction.fromHex(h.broadcasts[0]);
    expect(scriptHex(tx.outputs[tx.outputs.length - 1].script)).toBe(opReturnScript(record));
  });

  it('memo and opReturn with different values are refused; the same value is one memo', async () => {
    await h.connectPage();
    const to = await foreignTestnetAddress();
    const r = await h.fromTab('SEND_TRANSACTION', { to, amount: 1, memo: 'a', opReturn: 'b' });
    expect(r).toMatchObject({ success: false, code: ERR.INVALID_PARAMS });
    expect(h.broadcasts).toHaveLength(0);
    const sent = h.fromTab('SEND_TRANSACTION', { to, amount: 1, memo: 'same', opReturn: 'same' });
    const req = await h.waitForPending('send_transaction');
    expect(req.data.memo).toBe('same');
    await h.approvalWindow('REJECT_SIGNING_REQUEST', { requestId: req.id });
    await sent;
  });

  it('an unknown method is refused with 4200, and a rejection carries 4001', async () => {
    await h.connectPage();
    await expect(h.provider().request({ method: 'irondivi_nonsense' })).rejects.toMatchObject({ code: 4200 });
    const signed = h.provider().signMessage('hello');
    const req = await h.waitForPending('sign_message');
    await h.approvalWindow('REJECT_SIGNING_REQUEST', { requestId: req.id });
    await expect(signed).rejects.toMatchObject({ code: 4001 });
  });
});

describe('the transaction is checked against the memo that was shown', () => {
  async function built(memo?: string) {
    const seed = await Mnemonic.toSeed(TEST_MNEMONIC);
    const own = await deriveAddresses(seed, 'testnet', 0, 1);
    const to = await foreignTestnetAddress();
    const utxos = [{ txid: 'cd'.repeat(32), vout: 0, address: own[0].address, satoshis: 10n * 100_000_000n, amount: 10, confirmations: 10 }];
    const b = walletCore.buildTransaction(utxos, own, { to, amount: 1, memo }, 'testnet');
    return { b, intent: { to, amountSats: 100_000_000n, ownAddresses: [own[0].address], network: 'testnet' as const, memo } };
  }

  it('the memo is the last output and the fee covers its bytes', async () => {
    const plain = await built();
    const { b, intent } = await built('y'.repeat(400));
    expect(scriptHex(b.tx.outputs[b.tx.outputs.length - 1].script)).toBe(opReturnScript('y'.repeat(400)));
    expect(b.feeSats).toBeGreaterThan(plain.b.feeSats);
    expect(() => walletCore.checkIntent(b, intent)).not.toThrow();
  });

  it('a missing memo output is refused', async () => {
    const { b, intent } = await built('hello');
    b.tx.outputs.pop();
    expect(() => walletCore.checkIntent(b, intent)).toThrow(/memo/);
  });

  it('a changed memo is refused', async () => {
    const { b, intent } = await built('hello');
    b.tx.outputs[b.tx.outputs.length - 1].script = opReturnScript('hellp');
    expect(() => walletCore.checkIntent(b, intent)).toThrow(/memo/);
  });

  it('a memo output the owner was not shown is refused', async () => {
    const { b, intent } = await built('hello');
    expect(() => walletCore.checkIntent(b, { ...intent, memo: undefined })).toThrow();
  });
});

describe('fromAddresses', () => {
  it('spends only those addresses, and input 0 is from the first even when a later one has the bigger coin', async () => {
    const seed = await Mnemonic.toSeed(TEST_MNEMONIC);
    const own = await deriveAddresses(seed, 'testnet', 0, 3);
    const to = await foreignTestnetAddress();
    const coin = (i: number, divi: bigint, n: number) =>
      ({ txid: n.toString(16).padStart(64, '0'), vout: 0, address: own[i].address, satoshis: divi * 100_000_000n, amount: Number(divi), confirmations: 10 });
    const utxos = [coin(0, 5n, 1), coin(1, 900n, 2), coin(2, 5000n, 3)];
    const b = walletCore.buildTransaction(utxos, own, { to, amount: 8, fromAddresses: [own[0].address, own[1].address] }, 'testnet');
    expect(b.inputs[0].address).toBe(own[0].address);
    expect(b.inputs.map(i => i.address)).not.toContain(own[2].address);
    // Change goes back to the payer
    expect(b.tx.outputs).toHaveLength(2);
  });

  it('refuses when the first from-address has no coins, rather than paying from another', async () => {
    const seed = await Mnemonic.toSeed(TEST_MNEMONIC);
    const own = await deriveAddresses(seed, 'testnet', 0, 2);
    const to = await foreignTestnetAddress();
    const utxos = [{ txid: 'ab'.repeat(32), vout: 0, address: own[1].address, satoshis: 100n * 100_000_000n, amount: 100, confirmations: 10 }];
    expect(() => walletCore.buildTransaction(utxos, own, { to, amount: 1, fromAddresses: [own[0].address, own[1].address] }, 'testnet'))
      .toThrow(/must come from/);
  });
});
