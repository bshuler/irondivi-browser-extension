import { describe, expect, it, vi } from 'vitest';
import { buildRecord, DVNS_API, DVNS_REGISTRY, dvnsApiBase, isRecordFee, looksLikeName, normalizeName, notifyRecord, recordFeeSats, resolveName } from './dvns';

const PAYER = 'y2wgejXn4xeS95Jw5vdHzyQkfPjAihXYBU';
const REGISTRY = 'yKmDgfDZJmVTiPCkcWXfqGe1KAWL3bkXgx';

function reply(status: number, body: unknown) {
  return vi.fn(async (_url: string, _init?: RequestInit) =>
    ({ status, json: async () => body }) as unknown as Response);
}

describe('names (SPEC §1)', () => {
  it('lowercases, reads @handle as handle@telegram, and keeps tags', () => {
    expect(normalizeName('Human')).toBe('human');
    expect(normalizeName(' @Human ')).toBe('human@telegram');
    expect(normalizeName('human@siegeworlds')).toBe('human@siegeworlds');
    expect(normalizeName('a@siegeworlds')).toBe('a@siegeworlds');
    expect(normalizeName('my_name-2')).toBe('my_name-2');
  });

  it('refuses what is not a name', () => {
    for (const bad of ['', 'ab', '-abc', 'abc-', '_abc', 'a b c', 'a@b@c', 'x'.repeat(33), 'human@ab', 'bé', 'a.b.c']) {
      expect(normalizeName(bad), bad).toBeNull();
    }
  });

  it('a Divi address is never a name', () => {
    expect(looksLikeName(PAYER)).toBe(false);
    expect(looksLikeName('DJxDEd6GtyU95vN6iZxbcG7v6SgJyHWkJg')).toBe(false);
    expect(looksLikeName('capsizetest')).toBe(true);
  });
});

describe('the API base', () => {
  it('is name.irondivi.com in a release build', () => {
    expect(DVNS_API).toBe('https://name.irondivi.com/api/v1');
    expect(dvnsApiBase()).toBe(DVNS_API);
  });
});

describe('resolve (SPEC §8)', () => {
  const found = { name: 'human', network: 'testnet', divi: PAYER, owner: PAYER, fields: { kind: 'person' } };

  it('returns the address for a registered name', async () => {
    const f = reply(200, found);
    const r = await resolveName('Human', 'testnet', f);
    expect(r).toEqual({ status: 'found', record: { ...found } });
    expect(f.mock.calls[0][0]).toBe(`${DVNS_API}/resolve/human?network=testnet`);
  });

  it('a 404 is "not registered"', async () => {
    expect(await resolveName('nosuchname', 'testnet', reply(404, { error: 'not registered' })))
      .toEqual({ status: 'not-registered', name: 'nosuchname' });
  });

  it('any other answer is an error, never an address', async () => {
    await expect(resolveName('human', 'testnet', reply(500, { error: 'boom' }))).rejects.toThrow(/boom/);
    await expect(resolveName('human', 'testnet', vi.fn(async () => { throw new TypeError('offline'); })))
      .rejects.toThrow(/could not be reached/);
    // An answer for another network or name is refused
    await expect(resolveName('human', 'mainnet', reply(200, found))).rejects.toThrow(/not for this name/);
    await expect(resolveName('telegram', 'testnet', reply(200, found))).rejects.toThrow(/not for this name/);
    await expect(resolveName('human', 'testnet', reply(200, { ...found, divi: '' }))).rejects.toThrow();
  });
});

describe('build and notify (SPEC §7)', () => {
  const memo = `DVNS1\nop=register\nname=lanetest\ndivi=${PAYER}\nowner=${PAYER}`;
  const body = { fee: '500', warnings: [], send: { to: REGISTRY, amount: '500', amount_sat: 50_000_000_000, memo, from: PAYER } };

  it('posts the request and returns the payment to make', async () => {
    const f = reply(200, body);
    const b = await buildRecord({ network: 'testnet', op: 'register', name: 'lanetest', payer: PAYER, divi: PAYER }, f);
    expect(b.send).toEqual(body.send);
    expect(b.fee).toBe('500');
    const [url, init] = f.mock.calls[0];
    expect(url).toBe(`${DVNS_API}/build`);
    expect(JSON.parse(String(init?.body))).toEqual({ network: 'testnet', op: 'register', name: 'lanetest', payer: PAYER, divi: PAYER });
  });

  it('refuses a payment that is not the one asked for', async () => {
    const req = { network: 'testnet' as const, op: 'register' as const, name: 'lanetest', payer: PAYER, divi: PAYER };
    await expect(buildRecord(req, reply(200, { ...body, send: { ...body.send, from: REGISTRY } }))).rejects.toThrow(/not the one/);
    await expect(buildRecord(req, reply(200, { ...body, send: { ...body.send, memo: memo.replace('lanetest', 'other') } }))).rejects.toThrow(/not the one/);
    await expect(buildRecord({ ...req, op: 'delete' }, reply(200, body))).rejects.toThrow(/not the one/);
    await expect(buildRecord(req, reply(400, { error: 'record rejected: missing `divi`' }))).rejects.toThrow(/missing/);
  });

  it('notify posts the txid', async () => {
    const f = reply(200, { ok: true });
    await notifyRecord('testnet', 'ab'.repeat(32), f);
    expect(JSON.parse(String(f.mock.calls[0][1]?.body))).toEqual({ network: 'testnet', txid: 'ab'.repeat(32) });
    await expect(notifyRecord('testnet', 'x', reply(400, { error: 'bad txid' }))).rejects.toThrow(/bad txid/);
  });
});

describe('a record\'s fee (SPEC §4, §6)', () => {
  const DIVI = 100_000_000n;
  const memo = (op: string, name: string, extra = '') => `DVNS1\nop=${op}\nname=${name}${extra}`;

  it('is priced from the record alone', () => {
    expect(recordFeeSats(memo('register', 'abc', `\ndivi=${PAYER}`))).toBe(10_000n * DIVI);
    expect(recordFeeSats(memo('register', 'abcd'))).toBe(5_000n * DIVI);
    expect(recordFeeSats(memo('register', 'abcde'))).toBe(1_000n * DIVI);
    expect(recordFeeSats(memo('register', 'siegeworlds'))).toBe(500n * DIVI);
    expect(recordFeeSats(memo('register', 'human@telegram'))).toBe(10n * DIVI);
    expect(recordFeeSats(memo('update', 'siegeworlds'))).toBe(10n * DIVI);
    expect(recordFeeSats(memo('delete', 'human@telegram'))).toBe(10n * DIVI);
  });

  it('is unknown for anything that is not one plain record', () => {
    expect(recordFeeSats('hello')).toBeNull();
    expect(recordFeeSats(memo('register', 'divi'))).toBeNull(); // reserved: registry only
    expect(recordFeeSats(memo('transfer', 'siegeworlds'))).toBeNull();
    expect(recordFeeSats(memo('register', 'Siegeworlds'))).toBeNull();
    expect(recordFeeSats(memo('register', '@human'))).toBeNull();
    expect(recordFeeSats(memo('register', 'siegeworlds', '\nname=abc'))).toBeNull();
    expect(recordFeeSats(memo('register', 'siegeworlds', '\nno equals'))).toBeNull();
  });

  it('counts only when the registry of the network gets exactly that fee', () => {
    const m = memo('register', 'siegeworlds');
    expect(DVNS_REGISTRY.testnet).toBe(REGISTRY);
    expect(isRecordFee('testnet', REGISTRY, 500n * DIVI, m)).toBe(true);
    expect(isRecordFee('mainnet', REGISTRY, 500n * DIVI, m)).toBe(false);
    expect(isRecordFee('testnet', PAYER, 500n * DIVI, m)).toBe(false);
    expect(isRecordFee('testnet', REGISTRY, 501n * DIVI, m)).toBe(false);
    expect(isRecordFee('testnet', REGISTRY, 500n * DIVI, undefined)).toBe(false);
  });
});
