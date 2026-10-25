import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Base58 } from './base58';
import { deriveAddresses } from './derivation';
import { HDKey } from './hdkey';
import { bytesToHex, hexToBytes } from './hex';
import { Mnemonic, type WordlistLanguage } from './mnemonic';
import { derivePublicKey } from './secp256k1';
import { Signer } from './signer';

// Regression tests for the security review's EXT-17: the curve, BIP32 and
// BIP39 code had no reference vectors. bip-vectors.json holds the published
// BIP32 vectors 1-3 and the Trezor BIP39 vectors; wallet-vectors.json holds
// what 0.0.4 derived and signed, which every later version must reproduce or
// the wallets people already made would show other addresses.

vi.setConfig({ testTimeout: 60000 });

const load = (name: string) => JSON.parse(readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8'));
const bip = load('bip-vectors.json');
const wallet = load('wallet-vectors.json');

afterEach(() => { vi.restoreAllMocks(); });

// An xprv is version(4) depth(1) parent(4) child(4) chain code(32) 0x00 key(32)
function decodeXprv(xprv: string) {
  const raw = Base58.decode(xprv);
  const bytes = raw.slice(raw.length - 82, raw.length - 4);
  return { chainCode: bytesToHex(bytes.slice(13, 45)), privateKey: bytesToHex(bytes.slice(46, 78)) };
}

describe('EXT-17 BIP32 test vectors 1-3', () => {
  for (const [n, vector] of bip.bip32.entries()) {
    for (const chain of vector.chains) {
      it(`vector ${n + 1} ${chain.path}`, async () => {
        const master = await HDKey.fromMasterSeed(hexToBytes(vector.seed));
        const key = chain.path === 'm' ? master : await master.derive(chain.path);
        const want = decodeXprv(chain.xprv);
        expect(bytesToHex(key.privateKey!)).toBe(want.privateKey);
        expect(bytesToHex(key.chainCode!)).toBe(want.chainCode);
        expect(bytesToHex(key.publicKey!)).toBe(bytesToHex(derivePublicKey(key.privateKey!)));
      });
    }
  }
});

describe('EXT-17 BIP39 test vectors', () => {
  for (const [language, vectors] of Object.entries<any[]>(bip.bip39)) {
    it(`${language}: phrase from entropy, checksum and seed`, async () => {
      for (const v of vectors) {
        const entropy = hexToBytes(v.entropy);
        if (entropy.length === 16 || entropy.length === 32) {
          vi.spyOn(crypto, 'getRandomValues').mockImplementationOnce(((a: Uint8Array) => {
            a.set(entropy);
            return a;
          }) as typeof crypto.getRandomValues);
          const made = await Mnemonic.generate(entropy.length === 32 ? 24 : 12, language as WordlistLanguage);
          expect(Mnemonic.normalize(made)).toBe(Mnemonic.normalize(v.mnemonic));
          // A 12 or 24 word phrase is what the wallet accepts
          expect(Mnemonic.validate(Mnemonic.normalize(v.mnemonic))).toBe(true);
          expect(Mnemonic.validate(Mnemonic.normalize(v.mnemonic), language as WordlistLanguage)).toBe(true);
          // Some phrases are valid in both Chinese lists; any language whose
          // checksum holds gives the same seed, so detection need only find one
          const detected = Mnemonic.detectLanguage(Mnemonic.normalize(v.mnemonic))!;
          expect(Mnemonic.validate(Mnemonic.normalize(v.mnemonic), detected)).toBe(true);
          if (!language.startsWith('chinese')) expect(detected).toBe(language);
        }
        expect(bytesToHex(await Mnemonic.toSeed(Mnemonic.normalize(v.mnemonic), 'TREZOR'))).toBe(v.seed);
      }
    });
  }

  it('a changed word breaks the checksum', () => {
    const words = bip.bip39.english[0].mnemonic.split(' ');
    words[11] = words[11] === 'abandon' ? 'ability' : 'abandon';
    expect(Mnemonic.validate(words.join(' '))).toBe(false);
  });
});

describe('EXT-17 wallets made by 0.0.4 derive and sign the same', () => {
  for (const w of wallet.wallets) {
    it(`${w.normalized.split(' ').slice(0, 2).join(' ')}…`, async () => {
      expect(Mnemonic.normalize(w.phrase)).toBe(w.normalized);
      const seed = await Mnemonic.toSeed(w.normalized);
      expect(bytesToHex(seed)).toBe(w.seed);
      for (const net of ['mainnet', 'testnet'] as const) {
        expect(await deriveAddresses(seed, net, 0, 3)).toEqual(w.addresses[net]);
      }
      const key = await (await HDKey.fromMasterSeed(seed)).derive(w.addresses.testnet[0].path);
      expect(bytesToHex(key.publicKey!)).toBe(w.publicKey);
      for (const s of w.signatures) {
        expect(await Signer.signMessage(s.message, key.privateKey!, key.publicKey!)).toBe(s.signature);
      }
      expect(bytesToHex(await Signer.signHash(hexToBytes(w.signHash.hash), key.privateKey!))).toBe(w.signHash.der);
    });
  }

  it('40 keys give the same public keys, transaction signatures and message signatures', async () => {
    for (const k of wallet.keys) {
      const priv = hexToBytes(k.privateKey);
      const pub = derivePublicKey(priv);
      expect(bytesToHex(pub)).toBe(k.publicKey);
      expect(bytesToHex(await Signer.signHash(hexToBytes(k.hash), priv))).toBe(k.der);
      expect(await Signer.signMessage(k.message, priv, pub)).toBe(k.signature);
    }
  });
});
