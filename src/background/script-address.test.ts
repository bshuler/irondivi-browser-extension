import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createHarness, TEST_PASSWORD, type Harness } from '../test-support/harness';
import { Base58 } from '../lib/base58';
import { Hash } from '../lib/hash';
import { Transaction, bytesToHex } from '../lib/transaction';
import { NETWORKS } from '../shared/constants';

// I5 (revised in 0.0.9): the wallet pays script (P2SH) addresses, such as
// DNSDivi's registration address, and testnet key addresses starting 'x'

// A checksummed address with the given version byte and hash filler
function addressWith(version: number, fill: number): string {
  const payload = new Uint8Array(21).fill(fill);
  payload[0] = version;
  const out = new Uint8Array(25);
  out.set(payload);
  out.set(Hash.doubleSha256(payload).slice(0, 4), 21);
  return Base58.encode(out);
}

const hex = (s: Uint8Array | string) => (typeof s === 'string' ? s : bytesToHex(s));

vi.setConfig({ testTimeout: 30000 });

let h: Harness;

beforeEach(async () => {
  vi.resetModules();
  h = await createHarness();
  await h.setupWallet();
});

describe('I5 script addresses are payment destinations', () => {
  it('the popup pays a testnet script address with a P2SH output and keeps change P2PKH', async () => {
    const to = addressWith(NETWORKS.testnet.scriptPrefix, 7);
    expect(to).toMatch(/^[89]/);
    const r = await h.popup('SEND_TRANSACTION', { password: TEST_PASSWORD, to, amount: 1 });
    expect(r.success).toBe(true);
    const tx = Transaction.fromHex(h.broadcasts[0]);
    expect(hex(tx.outputs[0].script)).toBe('a914' + '07'.repeat(20) + '87');
    expect(tx.outputs[0].value).toBe(100_000_000n);
    for (const o of tx.outputs.slice(1)) expect(hex(o.script)).toMatch(/^76a914[0-9a-f]{40}88ac$/);
  });

  it('a site pays a script address through the approval window', async () => {
    await h.connectPage();
    const to = addressWith(NETWORKS.testnet.scriptPrefix, 9);
    const sent = h.provider().sendTransaction({ to, amount: 1 });
    const req = await h.waitForPending('send_transaction');
    const ok = await h.approvalWindow('APPROVE_SIGNING_REQUEST', { requestId: req.id, password: TEST_PASSWORD });
    expect(ok.success).toBe(true);
    await sent;
    expect(hex(Transaction.fromHex(h.broadcasts[0]).outputs[0].script)).toBe('a914' + '09'.repeat(20) + '87');
  });

  it('a mainnet script address is refused on testnet', async () => {
    const r = await h.popup('SEND_TRANSACTION', { password: TEST_PASSWORD, to: addressWith(NETWORKS.mainnet.scriptPrefix, 7), amount: 1 });
    expect(r.success).toBe(false);
    expect(r.error).toMatch(/testnet address/);
    expect(h.broadcasts).toHaveLength(0);
  });
});

describe('testnet key addresses start with x or y', () => {
  it('pays an x address', async () => {
    const to = addressWith(NETWORKS.testnet.addressPrefix, 0);
    expect(to[0]).toBe('x');
    const r = await h.popup('SEND_TRANSACTION', { password: TEST_PASSWORD, to, amount: 1 });
    expect(r.success).toBe(true);
    expect(hex(Transaction.fromHex(h.broadcasts[0]).outputs[0].script)).toBe('76a914' + '00'.repeat(20) + '88ac');
  });

  it('refuses a bad checksum', async () => {
    const good = addressWith(NETWORKS.testnet.addressPrefix, 0);
    const bad = good.slice(0, -1) + (good.endsWith('1') ? '2' : '1');
    const r = await h.popup('SEND_TRANSACTION', { password: TEST_PASSWORD, to: bad, amount: 1 });
    expect(r.success).toBe(false);
    expect(h.broadcasts).toHaveLength(0);
  });
});
