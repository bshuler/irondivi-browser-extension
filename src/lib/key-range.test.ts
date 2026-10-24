import { afterEach, describe, expect, it, vi } from 'vitest';
import { CURVE, bigIntToBytes, isValidPrivateKey } from './secp256k1';
import { Signer } from './signer';
import { HDKey } from './hdkey';

// Regression tests for the security review's I2 and I3: signHash signed with
// a zero or out-of-range private key, and BIP32 derivation used IL >= n and a
// zero child key instead of refusing them

const hash = new Uint8Array(32).fill(7);
const seed = new Uint8Array(64).fill(1);

afterEach(() => { vi.restoreAllMocks(); });

describe('isValidPrivateKey', () => {
  it('accepts 1 and n - 1', () => {
    expect(isValidPrivateKey(bigIntToBytes(1n, 32))).toBe(true);
    expect(isValidPrivateKey(bigIntToBytes(CURVE.N - 1n, 32))).toBe(true);
  });

  it('refuses 0, n, a value above n and the wrong length', () => {
    expect(isValidPrivateKey(new Uint8Array(32))).toBe(false);
    expect(isValidPrivateKey(bigIntToBytes(CURVE.N, 32))).toBe(false);
    expect(isValidPrivateKey(new Uint8Array(32).fill(0xff))).toBe(false);
    expect(isValidPrivateKey(new Uint8Array(31).fill(1))).toBe(false);
    expect(isValidPrivateKey(new Uint8Array(33).fill(1))).toBe(false);
  });
});

describe('I3 signHash refuses a bad private key', () => {
  it('signs with a valid key', async () => {
    const sig = await Signer.signHash(hash, bigIntToBytes(12345n, 32));
    expect(sig[0]).toBe(0x30);
  });

  it('refuses a zero key', async () => {
    await expect(Signer.signHash(hash, new Uint8Array(32))).rejects.toThrow('Invalid private key');
  });

  it('refuses a key of n or more', async () => {
    await expect(Signer.signHash(hash, bigIntToBytes(CURVE.N, 32))).rejects.toThrow('Invalid private key');
    await expect(Signer.signHash(hash, new Uint8Array(32).fill(0xff))).rejects.toThrow('Invalid private key');
  });

  it('refuses a hash that is not 32 bytes', async () => {
    await expect(Signer.signHash(new Uint8Array(31), bigIntToBytes(1n, 32))).rejects.toThrow('Hash must be 32 bytes');
  });
});

// Make the next HMAC-SHA512 return IL || IR, then behave normally again
function forceNextHmac(IL: Uint8Array) {
  const real = crypto.subtle.sign.bind(crypto.subtle);
  const spy = vi.spyOn(crypto.subtle, 'sign');
  spy.mockImplementationOnce(async () => {
    const out = new Uint8Array(64);
    out.set(IL, 0);
    out.fill(9, 32);
    return out.buffer;
  });
  spy.mockImplementation(real);
}

describe('I2 BIP32 refuses keys outside 1 .. n - 1', () => {
  it('refuses a master key of 0', async () => {
    forceNextHmac(new Uint8Array(32));
    await expect(HDKey.fromMasterSeed(seed)).rejects.toThrow('invalid master key');
  });

  it('refuses a master key of n or more', async () => {
    forceNextHmac(bigIntToBytes(CURVE.N, 32));
    await expect(HDKey.fromMasterSeed(seed)).rejects.toThrow('invalid master key');
  });

  it('refuses a child when IL is n or more', async () => {
    const master = await HDKey.fromMasterSeed(seed);
    forceNextHmac(bigIntToBytes(CURVE.N, 32));
    await expect(master.deriveChild(0)).rejects.toThrow('invalid key');
  });

  it('refuses a child whose key adds up to 0', async () => {
    const master = await HDKey.fromMasterSeed(seed);
    const parent = BigInt('0x' + Array.from(master.privateKey!, b => b.toString(16).padStart(2, '0')).join(''));
    forceNextHmac(bigIntToBytes(CURVE.N - parent, 32));
    await expect(master.deriveChild(0x80000000)).rejects.toThrow('invalid key');
  });

  it('still derives normal paths', async () => {
    const master = await HDKey.fromMasterSeed(seed);
    const child = await master.derive("m/44'/301'/0'/0/0");
    expect(isValidPrivateKey(child.privateKey!)).toBe(true);
    expect(child.publicKey).toHaveLength(33);
  });
});
