import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createHarness, TEST_MNEMONIC, TEST_PASSWORD, type Harness } from '../test-support/harness';
import { Mnemonic } from '../lib/mnemonic';
import { deriveAddresses } from '../lib/derivation';
import { Transaction } from '../lib/transaction';

vi.setConfig({ testTimeout: 30000 });

let h: Harness;
let ours: string;
const FAUCET_ADDRESS = 'yFaucetFaucetFaucetFaucetFaucetFau';
const STRANGER = 'yStrangerStrangerStrangerStranger1';

beforeEach(async () => {
  vi.resetModules();
  h = await createHarness();
  const account = await h.setupWallet();
  ours = account.addresses[0].address;
});

// A testnet address the wallet does not own (other account of the test mnemonic).
async function foreignTestnetAddress(): Promise<string> {
  const seed = await Mnemonic.toSeed(TEST_MNEMONIC, 'other-account');
  const [a] = await deriveAddresses(seed, 'testnet', 0, 1);
  return a.address;
}

// A verbose getrawtransaction answer paying `to` from `from`.
function tx(txid: string, confirmations: number, from: string, to: string, value: number) {
  return {
    txid, confirmations, time: 1_700_000_000,
    vin: [{ address: from, value: value + 0.01 }],
    vout: [{ value, scriptPubKey: { addresses: [to] } }],
  };
}

async function history() {
  const r = await h.popup('GET_TRANSACTIONS', {});
  expect(r?.success).toBe(true);
  return r.data.transactions as any[];
}

describe('transactions show before they are mined', () => {
  it('a faucet payout shows at once with 0 confirmations, even before the node lists it', async () => {
    const txid = '11'.repeat(32);
    h.faucetReply = { success: true, txid };
    h.rawTxs[txid] = tx(txid, 0, FAUCET_ADDRESS, ours, 1000);

    const r = await h.popup('REQUEST_FAUCET', { address: ours });
    expect(r).toEqual({ success: true, data: { success: true, txid } });
    expect(h.faucetRequests).toEqual([ours]);

    const [first] = await history();
    expect(first).toMatchObject({ txid, type: 'receive', amount: 1000, confirmations: 0 });
  });

  it('a payment in the mempool shows; a stranger\'s mempool transaction does not', async () => {
    const mine = '22'.repeat(32);
    const theirs = '33'.repeat(32);
    h.mempool.push(theirs, mine);
    h.rawTxs[mine] = tx(mine, 0, STRANGER, ours, 5);
    h.rawTxs[theirs] = tx(theirs, 0, STRANGER, FAUCET_ADDRESS, 7);

    const list = await history();
    expect(list.map(t => t.txid)).toEqual([mine]);
    expect(list[0]).toMatchObject({ type: 'receive', amount: 5, confirmations: 0 });
  });

  it('a send from the popup shows at once as pending', async () => {
    const to = await foreignTestnetAddress();
    const r = await h.popup('SEND_TRANSACTION', { password: TEST_PASSWORD, to, amount: 1 });
    expect(r?.success).toBe(true);
    const txid = Transaction.fromHex(h.broadcasts[0]).txid();
    h.rawTxs[txid] = { txid, confirmations: 0, vin: [{ address: ours, value: 1000 }], vout: [{ value: 1, scriptPubKey: { addresses: [to] } }] };

    const [first] = await history();
    expect(first).toMatchObject({ txid, type: 'send', confirmations: 0 });
  });

  it('once mined it shows its confirmations and the wallet stops tracking it', async () => {
    const txid = '44'.repeat(32);
    h.faucetReply = { success: true, txid };
    h.rawTxs[txid] = tx(txid, 0, FAUCET_ADDRESS, ours, 1000);
    await h.popup('REQUEST_FAUCET', { address: ours });
    expect(h.storage.pendingTxs.testnet.map((p: any) => p.txid)).toEqual([txid]);

    h.addressTxids.push(txid);
    h.rawTxs[txid].confirmations = 6;
    const list = await history();
    expect(list.filter(t => t.txid === txid)).toEqual([expect.objectContaining({ confirmations: 6 })]);
    expect(h.storage.pendingTxs.testnet).toEqual([]);
  });

  it('a txid that never confirms is forgotten after a day', async () => {
    const txid = '55'.repeat(32);
    h.faucetReply = { success: true, txid };
    await h.popup('REQUEST_FAUCET', { address: ours });
    h.storage.pendingTxs.testnet[0].addedAt -= 25 * 60 * 60 * 1000;

    expect(await history()).toEqual([]);
    expect(h.storage.pendingTxs.testnet).toEqual([]);
  });

  it('pending txids are kept per network', async () => {
    const txid = '66'.repeat(32);
    h.faucetReply = { success: true, txid };
    h.rawTxs[txid] = tx(txid, 0, FAUCET_ADDRESS, ours, 1000);
    await h.popup('REQUEST_FAUCET', { address: ours });

    const switched = await h.popup('UPDATE_SETTINGS', { network: 'mainnet', password: TEST_PASSWORD });
    expect(switched?.success).toBe(true);
    expect(await history()).toEqual([]);
    expect(h.storage.pendingTxs.testnet.map((p: any) => p.txid)).toEqual([txid]);
  });
});
