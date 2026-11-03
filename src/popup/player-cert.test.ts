import { describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import QRCode from 'qrcode';
import jsQR from 'jsqr';
import { Address } from '../lib/address';
import { derivePublicKey } from '../lib/secp256k1';
import { Signer } from '../lib/signer';
import { checkMessageToSign } from '../background/sign-policy';
import { createHarness, TEST_PASSWORD } from '../test-support/harness';
import {
  DT1_SIGNIN_TITLE,
  PLAYER_CERT_TITLE,
  WALLET_RELEASE_TITLE,
  buildPlayerCertMessage,
  buildWalletReleaseMessage,
  encodePlayerCertificateBase64,
  exportPlayerCertificate,
  extractPlayerKey,
  formatCertIsoTime,
  formatSignedPlayerCertificate,
  generatePlayerCertSerial,
  parsePlayerCertificate,
  parseWalletReleaseMessage,
  playerKeyFromPixels,
  verifyPlayerCertificate,
} from '../lib/player-cert';

vi.setConfig({ testTimeout: 30000 });

// Canonical cross-repo test vectors from vlc-hypercaption/tests/licence/ & divi-nft-chain/crates/dnsdivi-licence/src/cert.rs
const VECTOR_PLAYER_PUB = '02268dcb6750719f484b7d0daa92c109f12346b96b292d2fe5a423c4b48500f23e';
const VECTOR_SERIAL = '00112233445566778899aabbccddeeff';
const VECTOR_ISSUED = '2026-10-29T12:00:00Z';
const VECTOR_HOLDER_ADDR = 'yFGK9u4GLkmY5JoRZBzo1FC4HQUiMEAKTp';
const VECTOR_SIG = 'IG+oFu0ZKMPrN+fm9LNayuiibSHn07h4/t7+g1CQXTFbWSxO7tUC8RF122zN0BtWlU4Qah84osk+SbyYz10twno=';

const VECTOR_CERT_GOOD = [
  'Divi licence player certificate',
  'domain:licence.divi',
  'network:testnet',
  `address:${VECTOR_HOLDER_ADDR}`,
  `player:${VECTOR_PLAYER_PUB}`,
  `serial:${VECTOR_SERIAL}`,
  `issued:${VECTOR_ISSUED}`,
  `signature:${VECTOR_SIG}`,
  '',
].join('\n');

const VECTOR_CERT_MAINNET_UNCOMPRESSED = [
  'Divi licence player certificate',
  'domain:licence.divi',
  'network:mainnet',
  'address:D8qCsZrb226ybJkFHcLrzpBkY3UGHDFVuG',
  `player:${VECTOR_PLAYER_PUB}`,
  `serial:${VECTOR_SERIAL}`,
  `issued:${VECTOR_ISSUED}`,
  'signature:G6Zc6ftgsHky2rYglw70RlJfESjTcBrGOefAt3EscjhRXexY2Pd2Bd99fOHlkWtY/e+ykhVoplMgGiDsGVfvTtE=',
  '',
].join('\n');

function qrPixels(text: string, scale = 4, margin = 4) {
  const { modules } = QRCode.create(text, { errorCorrectionLevel: 'M' });
  const side = (modules.size + margin * 2) * scale;
  const data = new Uint8ClampedArray(side * side * 4).fill(255);
  for (let y = 0; y < modules.size; y++) {
    for (let x = 0; x < modules.size; x++) {
      if (!modules.get(y, x)) continue;
      for (let dy = 0; dy < scale; dy++) {
        for (let dx = 0; dx < scale; dx++) {
          const i = (((y + margin) * scale + dy) * side + (x + margin) * scale + dx) * 4;
          data[i] = data[i + 1] = data[i + 2] = 0;
        }
      }
    }
  }
  return { data, width: side, height: side };
}

describe('Player certificate wire format & cross-repo test vectors (§12.1 / §12.5)', () => {
  it('reproduces the exact Rust & VLC player-certificate test vector byte-for-byte', async () => {
    const priv = new Uint8Array(createHash('sha256').update('vlc-hypercaption test holder').digest());
    const pub = derivePublicKey(priv);
    const addr = Address.fromPublicKey(pub, 'testnet');
    expect(addr).toBe(VECTOR_HOLDER_ADDR);

    const msg = buildPlayerCertMessage({
      network: 'testnet',
      address: addr,
      player: VECTOR_PLAYER_PUB,
      serial: VECTOR_SERIAL,
      issued: VECTOR_ISSUED,
    });
    const sig = await Signer.signMessage(msg, priv, pub);
    expect(sig).toBe(VECTOR_SIG);

    const full = formatSignedPlayerCertificate(msg, sig);
    expect(full).toBe(VECTOR_CERT_GOOD);

    const verified = verifyPlayerCertificate(full, {
      expectedNetwork: 'testnet',
      nowMs: Date.parse('2026-10-29T12:05:00Z'),
    });
    expect(verified.address).toBe(VECTOR_HOLDER_ADDR);
    expect(verified.player).toBe(VECTOR_PLAYER_PUB);
    expect(verified.serial).toBe(VECTOR_SERIAL);
    expect(verified.expires).toBeUndefined();
  });

  it('verifies uncompressed mainnet holder signatures and optional expires lines', async () => {
    const verifiedMainnet = verifyPlayerCertificate(VECTOR_CERT_MAINNET_UNCOMPRESSED, {
      expectedNetwork: 'mainnet',
      nowMs: Date.parse('2026-10-29T12:05:00Z'),
    });
    expect(verifiedMainnet.address).toBe('D8qCsZrb226ybJkFHcLrzpBkY3UGHDFVuG');

    const priv = new Uint8Array(createHash('sha256').update('vlc-hypercaption test holder').digest());
    const pub = derivePublicKey(priv);
    const msg = buildPlayerCertMessage({
      domain: 'licence.divi',
      network: 'testnet',
      address: VECTOR_HOLDER_ADDR,
      player: VECTOR_PLAYER_PUB,
      serial: VECTOR_SERIAL,
      issued: '2026-11-03T12:00:00Z',
      expires: '2026-11-10T12:00:00Z',
    });
    expect(msg).toContain('expires:2026-11-10T12:00:00Z');
    const cert = formatSignedPlayerCertificate(msg, await Signer.signMessage(msg, priv, pub));

    expect(
      verifyPlayerCertificate(cert, {
        expectedNetwork: 'testnet',
        nowMs: Date.parse('2026-11-05T00:00:00Z'),
      }).expires,
    ).toBe('2026-11-10T12:00:00Z');

    expect(() =>
      verifyPlayerCertificate(cert, {
        expectedNetwork: 'testnet',
        nowMs: Date.parse('2026-11-10T12:00:00Z'),
      }),
    ).toThrow(/expired/i);
  });

  it('rejects tampered serials, wrong-signer signatures, network mismatches, and future issued times', async () => {
    const tampered = VECTOR_CERT_GOOD.replace(VECTOR_SERIAL, 'ffeeddccbbaa99887766554433221100');
    expect(() => verifyPlayerCertificate(tampered)).toThrow(/not signed by its address/i);

    const otherPriv = new Uint8Array(createHash('sha256').update('vlc-hypercaption test other').digest());
    const otherPub = derivePublicKey(otherPriv);
    const parsed = parsePlayerCertificate(VECTOR_CERT_GOOD);
    const wrongSig = await Signer.signMessage(parsed.signedText, otherPriv, otherPub);
    expect(() => verifyPlayerCertificate(formatSignedPlayerCertificate(parsed.signedText, wrongSig))).toThrow(
      /not signed by its address/i,
    );

    expect(() => verifyPlayerCertificate(VECTOR_CERT_GOOD, { expectedNetwork: 'mainnet' })).toThrow(
      /for testnet, expected mainnet/i,
    );

    expect(() =>
      verifyPlayerCertificate(VECTOR_CERT_GOOD, {
        expectedNetwork: 'testnet',
        nowMs: Date.parse('2026-10-29T11:00:00Z'),
      }),
    ).toThrow(/future/i);

    // Rejects out-of-order lines or mid-body signature lines
    const reordered = [
      'Divi licence player certificate',
      'network:testnet',
      'domain:licence.divi',
      `address:${VECTOR_HOLDER_ADDR}`,
      `player:${VECTOR_PLAYER_PUB}`,
      `serial:${VECTOR_SERIAL}`,
      `issued:${VECTOR_ISSUED}`,
      `signature:${VECTOR_SIG}`,
    ].join('\n');
    expect(() => parsePlayerCertificate(reordered)).toThrow(/expected "domain:"/i);

    const midSig = [
      'Divi licence player certificate',
      'domain:licence.divi',
      `signature:${VECTOR_SIG}`,
      'network:testnet',
      `address:${VECTOR_HOLDER_ADDR}`,
      `player:${VECTOR_PLAYER_PUB}`,
      `serial:${VECTOR_SERIAL}`,
      `issued:${VECTOR_ISSUED}`,
    ].join('\n');
    expect(() => parsePlayerCertificate(midSig)).toThrow(/signature must be the final line/i);
  });

  it('builds and parses canonical DT/1 §11 wallet release messages carrying asset + epk + period (§6 / §15 #7)', async () => {
    const priv = new Uint8Array(createHash('sha256').update('vlc-hypercaption test holder').digest());
    const pub = derivePublicKey(priv);
    const asset = '9f2c1a7e3b5d4c6e8f0a1b2c3d4e5f60718293a4b5c6d7e8f9a0b1c2d3e4f5a6';
    const epk = '026b4e91387aa932205308328e54f8235db98ae4651ccc45dfd7a2288428127c24';
    const nonce = '00112233445566778899aabbccddeeff';

    const msg = buildWalletReleaseMessage({
      title: WALLET_RELEASE_TITLE,
      domain: 'licence.divi',
      network: 'testnet',
      address: VECTOR_HOLDER_ADDR,
      nonce,
      issued: VECTOR_ISSUED,
      asset,
      epk,
      period: 7,
    });
    const parsed = parseWalletReleaseMessage(msg);
    expect(parsed.domain).toBe('licence.divi');
    expect(parsed.asset).toBe(asset);
    expect(parsed.epk).toBe(epk);
    expect(parsed.period).toBe(7);

    const sig = await Signer.signMessage(msg, priv, pub);
    expect(Signer.verifyMessage(VECTOR_HOLDER_ADDR, sig, parsed.signedText, 'testnet')).toBe(true);

    // Also accepts the DT/1 §11 "Divi NFT sign-in" header line
    const dt1Msg = buildWalletReleaseMessage({
      title: DT1_SIGNIN_TITLE,
      domain: 'licence.divi-testnet',
      network: 'testnet',
      address: VECTOR_HOLDER_ADDR,
      nonce,
      issued: VECTOR_ISSUED,
      asset,
      epk,
    });
    expect(parseWalletReleaseMessage(dt1Msg).domain).toBe('licence.divi-testnet');
  });
});

describe('Player key extraction, QR scanning & EXT-4 safety boundaries', () => {
  it('extracts a 33-byte compressed secp256k1 key from raw hex, VLC notices, and QR screenshots', () => {
    expect(extractPlayerKey(VECTOR_PLAYER_PUB.toUpperCase())).toEqual({ player: VECTOR_PLAYER_PUB });
    expect(
      extractPlayerKey(`Licence required\nPlayer key: ${VECTOR_PLAYER_PUB}\nTerms: https://irondivi.com/terms`),
    ).toEqual({ player: VECTOR_PLAYER_PUB });

    const { data, width, height } = qrPixels(`player:${VECTOR_PLAYER_PUB}`);
    expect(playerKeyFromPixels(data, width, height)).toEqual({ player: VECTOR_PLAYER_PUB });
    const inverted = data.map((v, i) => (i % 4 === 3 ? v : 255 - v));
    expect(playerKeyFromPixels(inverted, width, height)).toEqual({ player: VECTOR_PLAYER_PUB });
  });

  it('refuses 32-byte private keys, 65-byte uncompressed keys, arbitrary tx hex, off-curve points, and multi-key blobs', () => {
    const secret64 = '2c537aae6633d3f744614c12482b4b9a3f70ddc5bd9946d3db6c9157c6cc49a0';
    expect(extractPlayerKey(secret64)).toEqual({
      error: expect.stringMatching(/never a secret key/i),
    });

    const uncompressed130 = '04' + '11'.repeat(64);
    expect(extractPlayerKey(uncompressed130)).toEqual({
      error: expect.stringMatching(/uncompressed 65-byte/i),
    });

    // x = 5 is off secp256k1 (5^3 + 7 = 132 is not a quadratic residue mod p)
    const offCurve = '02' + '00'.repeat(31) + '05';
    expect(extractPlayerKey(offCurve)).toEqual({
      error: expect.stringMatching(/not a valid secp256k1 curve point/i),
    });

    const secondPub = '026b4e91387aa932205308328e54f8235db98ae4651ccc45dfd7a2288428127c24';
    expect(extractPlayerKey(`${VECTOR_PLAYER_PUB} ${secondPub}`)).toEqual({
      error: expect.stringMatching(/multiple public keys/i),
    });

    // Player certificates never trip EXT-4 game-tx blocking, while game-tx JSON still does
    const msg = buildPlayerCertMessage({
      network: 'testnet',
      address: VECTOR_HOLDER_ADDR,
      player: VECTOR_PLAYER_PUB,
      serial: generatePlayerCertSerial(),
      issued: formatCertIsoTime(new Date('2026-11-03T18:00:00Z')),
    });
    expect(msg.startsWith(`${PLAYER_CERT_TITLE}\n`)).toBe(true);
    expect(checkMessageToSign(msg, 'https://nft.irondivi.com', 'testnet')).toEqual({});
    expect(() =>
      checkMessageToSign('{"action":"move","chain":"divi-games","nonce":1}', 'https://nft.irondivi.com', 'testnet'),
    ).toThrow(/USE_SIGN_GAME_TX/);
  });
});

describe('Popup background signing & export round-trip', () => {
  it('signs a player certificate for a selected non-default HD address and round-trips text, Base64, JSON, and QR', async () => {
    vi.resetModules();
    const h = await createHarness();
    const account = await h.setupWallet();
    const derived = await h.popup('GENERATE_NEW_ADDRESS', {
      accountId: account.id,
      password: TEST_PASSWORD,
    });
    expect(derived.success).toBe(true);
    const secondAddr: string = derived.data.address.address;
    expect(secondAddr).not.toBe(account.addresses[0].address);

    const serial = generatePlayerCertSerial();
    const issued = formatCertIsoTime(new Date('2026-11-03T18:30:00Z'));
    const message = buildPlayerCertMessage({
      network: 'testnet',
      address: secondAddr,
      player: VECTOR_PLAYER_PUB,
      serial,
      issued,
    });

    const signed = await h.popup('SIGN_MESSAGE', {
      accountId: account.id,
      password: TEST_PASSWORD,
      message,
      address: secondAddr,
    });
    expect(signed.success).toBe(true);
    expect(signed.data.address).toBe(secondAddr);

    const certText = formatSignedPlayerCertificate(message, signed.data.signature);
    const cert = verifyPlayerCertificate(certText, { expectedNetwork: 'testnet' });
    expect(cert.address).toBe(secondAddr);

    // Base64 export decodes back to the exact verified certificate text
    const b64 = encodePlayerCertificateBase64(cert.certificateText);
    expect(exportPlayerCertificate(cert, 'base64')).toBe(b64);
    expect(Buffer.from(b64, 'base64').toString('utf8')).toBe(cert.certificateText);

    // JSON export carries both structured fields and the canonical certificate string
    const jsonParsed = JSON.parse(exportPlayerCertificate(cert, 'json'));
    expect(jsonParsed.address).toBe(secondAddr);
    expect(jsonParsed.player).toBe(VECTOR_PLAYER_PUB);
    expect(jsonParsed.serial).toBe(serial);
    expect(verifyPlayerCertificate(jsonParsed.certificate).address).toBe(secondAddr);

    // QR export scans back cleanly with jsQR for mobile/TV VLC players
    const qr = qrPixels(cert.certificateText, 3, 4);
    const scanned = jsQR(qr.data, qr.width, qr.height)?.data;
    expect(scanned).toBe(cert.certificateText);
  });

  it('wires #view-player-cert in popup.html and player-cert-ui.ts with zero innerHTML', () => {
    const html = readFileSync(new URL('./popup.html', import.meta.url), 'utf8');
    for (const id of [
      'player-cert-btn',
      'settings-player-cert-btn',
      'view-player-cert',
      'player-cert-address',
      'player-cert-key-input',
      'player-cert-scan-tab-btn',
      'player-cert-qr-input',
      'player-cert-expires-preset',
      'player-cert-preview',
      'player-cert-sign-btn',
      'player-cert-result',
      'player-cert-format',
      'player-cert-output',
      'player-cert-copy-btn',
      'player-cert-download-btn',
    ]) {
      expect(html).toContain(`id="${id}"`);
    }
    const uiSrc = readFileSync(new URL('./player-cert-ui.ts', import.meta.url), 'utf8');
    expect(uiSrc).not.toContain('innerHTML');
    expect(uiSrc).toContain('MSG.SIGN_MESSAGE');
    expect(uiSrc).toContain('verifyPlayerCertificate');
    const popupSrc = readFileSync(new URL('./popup.ts', import.meta.url), 'utf8');
    expect(popupSrc).toContain('setupPlayerCertUIHandlers()');
  });
});
