import { describe, expect, it } from 'vitest';
import { Base58 } from './base58';
import { Hash } from './hash';
import { NETWORKS } from '../shared/constants';
import { formatPaymentUri, parsePaymentUri } from './payment-uri';

// A checksummed address with the given version byte
function addressWith(version: number, fill = 7): string {
  const payload = new Uint8Array(21).fill(fill);
  payload[0] = version;
  const out = new Uint8Array(25);
  out.set(payload);
  out.set(Hash.doubleSha256(payload).slice(0, 4), 21);
  return Base58.encode(out);
}

const TEST = addressWith(NETWORKS.testnet.addressPrefix);
const MAIN = addressWith(NETWORKS.mainnet.addressPrefix);

const ok = (text: string, network: 'mainnet' | 'testnet' = 'testnet') => {
  const r = parsePaymentUri(text, network);
  if (!r.ok) throw new Error(r.error);
  return r.request;
};
const err = (text: string, network: 'mainnet' | 'testnet' = 'testnet') => {
  const r = parsePaymentUri(text, network);
  if (r.ok) throw new Error(`accepted ${text}`);
  return r.error;
};

describe('formatPaymentUri', () => {
  it('is the bare address when nothing else is asked', () => {
    expect(formatPaymentUri({ address: TEST })).toBe(TEST);
    expect(formatPaymentUri({ address: TEST, amount: '', label: '', memo: '' })).toBe(TEST);
  });

  it('writes amount, label, message, memo in that order, percent-encoded', () => {
    expect(formatPaymentUri({ address: TEST, memo: 'inv #7', message: 'a&b=c', label: 'Café Bob', amount: '1.5' }))
      .toBe(`divi:${TEST}?amount=1.5&label=Caf%C3%A9%20Bob&message=a%26b%3Dc&memo=inv%20%237`);
  });

  it('refuses an amount or memo a wallet would refuse', () => {
    expect(() => formatPaymentUri({ address: TEST, amount: '1.123456789' })).toThrow(/8 decimal/);
    expect(() => formatPaymentUri({ address: TEST, amount: '0' })).toThrow(/more than zero/);
    expect(() => formatPaymentUri({ address: TEST, amount: '-1' })).toThrow();
    expect(() => formatPaymentUri({ address: TEST, memo: 'x'.repeat(513) })).toThrow(/513 bytes/);
  });

  it('round-trips through parsePaymentUri', () => {
    const request = { address: TEST, amount: '0.00000001', label: 'L+ü', message: '100% sure?', memo: '日本 ✓ & =' };
    expect(ok(formatPaymentUri(request))).toEqual(request);
  });
});

describe('parsePaymentUri', () => {
  it('accepts a bare address', () => {
    expect(ok(TEST)).toEqual({ address: TEST });
    expect(ok(`  ${TEST}\n`)).toEqual({ address: TEST });
  });

  it('accepts divi: in any case', () => {
    expect(ok(`DIVI:${TEST}?amount=2`)).toEqual({ address: TEST, amount: '2' });
    expect(ok(`Divi:${TEST}`)).toEqual({ address: TEST });
  });

  it('reads label, message and memo', () => {
    expect(ok(`divi:${TEST}?label=Shop&message=Order%2042&memo=ref%3A42`))
      .toEqual({ address: TEST, label: 'Shop', message: 'Order 42', memo: 'ref:42' });
  });

  it('keeps + as a plus', () => {
    expect(ok(`divi:${TEST}?label=a+b`).label).toBe('a+b');
  });

  it('ignores unknown parameters but refuses unknown req- ones', () => {
    expect(ok(`divi:${TEST}?foo=bar&amount=1`)).toEqual({ address: TEST, amount: '1' });
    expect(err(`divi:${TEST}?req-somethingnew=1`)).toMatch(/req-somethingnew/);
  });

  it('refuses a bad amount', () => {
    for (const amount of ['0', '0.0', '-1', '1e3', '1.123456789', '.5', '1.', 'abc', '', '1,5', '0x10']) {
      expect(err(`divi:${TEST}?amount=${amount}`), amount).toMatch(/amount/i);
    }
  });

  it('accepts an amount with 8 decimals', () => {
    expect(ok(`divi:${TEST}?amount=12.34567891`).amount).toBe('12.34567891');
  });

  it('refuses a memo that does not fit on chain', () => {
    expect(err(`divi:${TEST}?memo=${'x'.repeat(513)}`)).toMatch(/512/);
    expect(ok(`divi:${TEST}?memo=${'x'.repeat(512)}`).memo).toHaveLength(512);
    // 171 three-byte characters are 513 bytes
    expect(err(`divi:${TEST}?memo=${encodeURIComponent('€'.repeat(171))}`)).toMatch(/513 bytes/);
    // A lone surrogate is not text UTF-8 carries
    expect(err(`divi:${TEST}?memo=%ED%A0%80`)).toMatch(/encoded|text/);
  });

  it('treats an empty memo, label or message as absent', () => {
    expect(ok(`divi:${TEST}?memo=&label=&message=`)).toEqual({ address: TEST });
  });

  it('refuses a repeated parameter', () => {
    expect(err(`divi:${TEST}?amount=1&amount=2`)).toMatch(/twice/);
  });

  it('refuses bad percent-encoding', () => {
    expect(err(`divi:${TEST}?label=%E0%A4%A`)).toMatch(/encoded/);
  });

  it('refuses a wrong-network address with a clear message', () => {
    expect(err(MAIN, 'testnet')).toBe('That is a Mainnet address; this wallet is on Testnet');
    expect(err(`divi:${TEST}?amount=1`, 'mainnet')).toBe('That is a Testnet address; this wallet is on Mainnet');
    expect(ok(MAIN, 'mainnet')).toEqual({ address: MAIN });
  });

  it('accepts a script address on its own network only', () => {
    const script = addressWith(NETWORKS.testnet.scriptPrefix);
    expect(ok(`divi:${script}`)).toEqual({ address: script });
    expect(err(`divi:${script}`, 'mainnet')).toBe('That is a Testnet address; this wallet is on Mainnet');
  });

  it('refuses garbage', () => {
    expect(err('divi:notanaddress')).toMatch(/not a valid/);
    expect(err('divi:')).toMatch(/no address/);
    expect(err('')).toMatch(/no address/);
    expect(err('irondivi-connect:v1?topic=x')).toMatch(/not a Divi payment request/);
    expect(err(`bitcoin:${TEST}`)).toMatch(/not a valid/);
    // A checksum error
    expect(err(TEST.slice(0, -1) + (TEST.endsWith('1') ? '2' : '1'))).toMatch(/not a valid/);
  });
});
