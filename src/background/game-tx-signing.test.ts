import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createHarness, TEST_MNEMONIC, TEST_PASSWORD, type Harness } from '../test-support/harness';
import { Mnemonic } from '../lib/mnemonic';
import { HDKey } from '../lib/hdkey';
import { Signer } from '../lib/signer';
import { gameTxid } from './sign-policy';

// EXT-4: a Divi Games chain transaction offered as a message was shown as an
// opaque text, from any connected site. It now goes through signGameTx: the
// Divi Games site only, shown as a transaction, signed over the exact body.

vi.setConfig({ testTimeout: 30000 });

let h: Harness;

beforeEach(() => { vi.resetModules(); });

function txBody(from: string, action: Record<string, unknown>): string {
  return JSON.stringify({ v: 1, chain: 'divi-games-testnet-1', from, nonce: 0, action });
}

async function expectedSignature(message: string): Promise<string> {
  const seed = await Mnemonic.toSeed(TEST_MNEMONIC);
  const key = await (await HDKey.fromMasterSeed(seed)).derive("m/44'/1'/0'/0/0");
  return Signer.signMessage(message, key.privateKey!, key.publicKey!);
}

describe('EXT-4 signGameTx', () => {
  it('shows the transaction and signs its exact body after approval', async () => {
    h = await createHarness();
    const account = await h.setupWallet();
    await h.connectPage();
    const from = account.addresses[0].address;
    const body = txBody(from, { type: 'bridge', op: { kind: 'withdraw', amount: '250000000', divi_address: 'yDiviOut' } });

    const signed = h.provider().signGameTx(body);
    const req = await h.waitForPending('sign_game_tx');
    expect(req.data.gameTx.title).toBe('Bridge withdraw to Divi');
    expect(req.data.gameTx.movesFunds).toBe(true);
    expect(req.data.gameTx.rows).toContainEqual({ label: 'Amount', value: '2.5 TDIVI' });
    expect(req.data.gameTx.rows).toContainEqual({ label: 'To Divi address', value: 'yDiviOut' });

    const ok = await h.approvalWindow('APPROVE_SIGNING_REQUEST', { requestId: req.id, password: TEST_PASSWORD });
    expect(ok.success).toBe(true);
    const r = await signed;
    expect(r.address).toBe(from);
    expect(r.txid).toBe(gameTxid(body));
    expect(r.signature).toBe(await expectedSignature(body));
  });

  it('the same body through signMessage is refused, before any window opens', async () => {
    h = await createHarness();
    const account = await h.setupWallet();
    await h.connectPage();
    const windows = h.createdWindows.length;
    const body = txBody(account.addresses[0].address, { type: 'transfer', to: 'yX', token: 'GOLD', amount: '1' });
    await expect(h.provider().signMessage(body)).rejects.toThrow(/USE_SIGN_GAME_TX/);
    expect(h.createdWindows.length).toBe(windows);
  });

  it('another connected site cannot ask for one', async () => {
    h = await createHarness('https://example.org/', { allowedSites: ['example.org'] });
    const account = await h.setupWallet();
    await h.connectPage();
    const body = txBody(account.addresses[0].address, { type: 'transfer', to: 'yX', token: 'GOLD', amount: '1' });
    await expect(h.provider().signGameTx(body)).rejects.toThrow(/Divi Games site/);
  });

  it('a body from an address outside the wallet is refused', async () => {
    h = await createHarness();
    await h.setupWallet();
    await h.connectPage();
    const body = txBody('yNotMine', { type: 'transfer', to: 'yX', token: 'GOLD', amount: '1' });
    await expect(h.provider().signGameTx(body)).rejects.toThrow(/not from an address/);
  });

  it('a session grant is shown as one', async () => {
    h = await createHarness();
    await h.setupWallet();
    await h.connectPage();
    const text = 'Divi Games session: key yKey may play as this address on divi-games-testnet-1 until 2026-11-01T00:00:00Z';
    void h.provider().signMessage(text).catch(() => {});
    const req = await h.waitForPending('sign_message');
    expect(req.data.session).toEqual({ key: 'yKey', chain: 'divi-games-testnet-1', until: '2026-11-01T00:00:00Z' });
  });
});
