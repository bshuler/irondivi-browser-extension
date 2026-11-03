/**
 * Player certificates for the Sidechain Licence Service
 * (divi-nft-chain docs/LICENCE-SERVICE.md §12.1 & §12.5).
 *
 * A media player (such as VLC Hypercaption) generates its own secp256k1 key
 * pair locally and displays the 33-byte compressed public key as text or a QR
 * code. The holder's wallet signs a human-readable DT/1 §12.1 player
 * certificate delegating playback authority for licences held by `address`
 * without ever sharing the wallet key or signing an opaque hex digest.
 */

import jsQR from 'jsqr';
import { Address } from './address';
import { bytesToHex, hexToBytes } from './hex';
import { isValidCompressedPublicKey } from './secp256k1';
import { Signer } from './signer';
import type { NetworkType } from '../shared/constants';

export const PLAYER_CERT_TITLE = 'Divi licence player certificate';
export const WALLET_RELEASE_TITLE = 'Divi licence release request';
export const DT1_SIGNIN_TITLE = 'Divi NFT sign-in';
export const DEFAULT_LICENCE_DOMAIN = 'licence.divi';

export type PlayerCertExportFormat = 'text' | 'base64' | 'json';

export interface PlayerCertFields {
  domain?: string;
  network: NetworkType;
  address: string;
  player: string;
  serial: string;
  issued: string;
  expires?: string;
}

export interface ParsedPlayerCertificate {
  domain: string;
  network: NetworkType;
  address: string;
  player: string;
  serial: string;
  issued: string;
  issuedMs: number;
  expires?: string;
  expiresMs?: number;
  signedText: string;
  signature: string;
}

export interface SignedPlayerCertificate extends ParsedPlayerCertificate {
  certificateText: string;
}

const DOMAIN_RE = /^licence\.[a-z0-9-]+$/;
const SERIAL_RE = /^[0-9a-f]{32}$/;
const PLAYER_HEX_CANDIDATE_RE = /(?:^|[^0-9a-fA-F])(0[23][0-9a-fA-F]{64})(?=$|[^0-9a-fA-F])/g;
const RFC3339_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/;

/** Format a Date as UTC ISO-8601 seconds (`YYYY-MM-DDTHH:MM:SSZ`) compatible with VLC and chrono. */
export function formatCertIsoTime(date: Date = new Date()): string {
  if (Number.isNaN(date.getTime())) throw new Error('Invalid timestamp');
  return date.toISOString().replace(/\.\d{3}Z$/, 'Z');
}

/** Parse a strict RFC 3339 timestamp to epoch milliseconds, or null if malformed. */
export function parseCertIsoTime(value: string): number | null {
  const trimmed = value.trim();
  if (!RFC3339_RE.test(trimmed)) return null;
  const ms = Date.parse(trimmed);
  return Number.isNaN(ms) ? null : ms;
}

/** Generate a fresh 16-byte CSPRNG certificate serial as 32 lowercase hex chars. */
export function generatePlayerCertSerial(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return bytesToHex(bytes);
}

/** Validate a 66-hex-character compressed secp256k1 player public key and return lowercase hex. */
export function normalizePlayerPublicKey(hex: string): string | null {
  const trimmed = hex.trim().toLowerCase();
  if (!/^0[23][0-9a-f]{64}$/.test(trimmed)) return null;
  try {
    const bytes = hexToBytes(trimmed);
    return isValidCompressedPublicKey(bytes) ? trimmed : null;
  } catch {
    return null;
  }
}

/**
 * Extract a single valid 33-byte compressed secp256k1 player public key from
 * pasted text or a QR payload (e.g. raw 66-hex, `player:02...`, VLC's
 * `Player key: 02...` notice, or JSON `{"player":"02..."}`).
 *
 * Refuses raw transaction hex, uncompressed 65-byte keys, 32-byte private keys,
 * off-curve points, or ambiguous text containing two different keys.
 */
export function extractPlayerKey(input: string): { player: string } | { error: string } {
  const trimmed = input.trim();
  if (!trimmed) {
    return { error: 'Paste or scan the 66-character player public key shown by your player.' };
  }

  // Reject pure hex strings of the wrong length immediately with a clear explanation
  if (/^[0-9a-fA-F]+$/.test(trimmed) && trimmed.length !== 66) {
    if (trimmed.length === 64) {
      return { error: 'That is 64 hex characters (32 bytes). Paste the 66-character public player key starting with 02 or 03, never a secret key.' };
    }
    if (trimmed.length === 130 && trimmed.startsWith('04')) {
      return { error: 'Uncompressed 65-byte public keys are not used; paste the 33-byte compressed player key (66 hex characters starting with 02 or 03).' };
    }
    return { error: `Expected a 66-character compressed secp256k1 player key (got ${trimmed.length} hex characters).` };
  }

  const found = new Set<string>();
  PLAYER_HEX_CANDIDATE_RE.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = PLAYER_HEX_CANDIDATE_RE.exec(trimmed)) !== null) {
    found.add(match[1].toLowerCase());
  }

  if (found.size === 0) {
    return { error: 'No 33-byte compressed player key (66 hex characters starting with 02 or 03) found.' };
  }
  if (found.size > 1) {
    return { error: 'Multiple public keys were found in the pasted text; paste only one player public key.' };
  }

  const candidate = [...found][0];
  const valid = normalizePlayerPublicKey(candidate);
  if (!valid) {
    return { error: 'That 66-character hex string is not a valid secp256k1 curve point.' };
  }
  return { player: valid };
}

/** Read a player public key from RGBA image pixels (e.g. QR screenshot or tab capture). */
export function playerKeyFromPixels(
  data: Uint8ClampedArray,
  width: number,
  height: number,
): { player: string } | { error: string } | null {
  const qr = jsQR(data, width, height, { inversionAttempts: 'attemptBoth' });
  if (!qr?.data) return null;
  return extractPlayerKey(qr.data);
}

/** Validate a P2PKH holder address on `network` (script addresses cannot sign Divi messages). */
export function isHolderP2pkhAddress(address: string, network: NetworkType): boolean {
  try {
    const decoded = Address.decode(address);
    return decoded.version === Address.NETWORKS[network].pubKeyHash;
  } catch {
    return false;
  }
}

/**
 * Build the canonical DT/1 §12.1 / §12.5 player certificate message lines
 * (joined by `\n` with no trailing newline, ready for Divi `signmessage`).
 */
export function buildPlayerCertMessage(fields: PlayerCertFields): string {
  const domain = (fields.domain ?? DEFAULT_LICENCE_DOMAIN).trim();
  if (!DOMAIN_RE.test(domain)) {
    throw new Error(`Invalid licence domain: ${domain}`);
  }
  if (fields.network !== 'mainnet' && fields.network !== 'testnet') {
    throw new Error(`Unsupported network: ${String(fields.network)}`);
  }
  const address = fields.address.trim();
  if (!isHolderP2pkhAddress(address, fields.network)) {
    throw new Error(`Holder address is not a valid ${fields.network} P2PKH address`);
  }
  const player = normalizePlayerPublicKey(fields.player);
  if (!player) {
    throw new Error('Player key must be a valid 33-byte compressed secp256k1 public key');
  }
  const serial = fields.serial.trim().toLowerCase();
  if (!SERIAL_RE.test(serial)) {
    throw new Error('Certificate serial must be 16 bytes (32 lowercase hex characters)');
  }
  const issued = fields.issued.trim();
  const issuedMs = parseCertIsoTime(issued);
  if (issuedMs === null) {
    throw new Error('Issued time must be an ISO-8601 UTC timestamp');
  }

  const lines = [
    PLAYER_CERT_TITLE,
    `domain:${domain}`,
    `network:${fields.network}`,
    `address:${address}`,
    `player:${player}`,
    `serial:${serial}`,
    `issued:${issued}`,
  ];

  if (fields.expires !== undefined && fields.expires.trim() !== '') {
    const expires = fields.expires.trim();
    const expiresMs = parseCertIsoTime(expires);
    if (expiresMs === null) {
      throw new Error('Expiry time must be an ISO-8601 UTC timestamp');
    }
    if (expiresMs <= issuedMs) {
      throw new Error('Expiry time must be after the issued time');
    }
    lines.push(`expires:${expires}`);
  }

  return lines.join('\n');
}

/** Attach a Base64 compact Divi `signmessage` signature to form the complete §12.5 certificate text. */
export function formatSignedPlayerCertificate(signedMessage: string, signatureBase64: string): string {
  const sig = signatureBase64.trim();
  if (!sig || !/^[A-Za-z0-9+/]+={0,2}$/.test(sig)) {
    throw new Error('Invalid base64 signature');
  }
  return `${signedMessage}\nsignature:${sig}\n`;
}

/**
 * Parse a §12.5 player certificate text in strict canonical field order:
 * optional title line (`Divi licence player certificate`), `domain`, `network`,
 * `address`, `player`, `serial`, `issued`, optional `expires`, and `signature:`
 * strictly last (matching `dnsdivi_licence::cert::Certificate::parse` and
 * `vlc-hypercaption/src/licence.c:hc_cert_parse`).
 */
export function parsePlayerCertificate(text: string): ParsedPlayerCertificate {
  const normalized = text.split('\n').map(l => (l.endsWith('\r') ? l.slice(0, -1) : l));
  while (normalized.length > 0 && normalized[normalized.length - 1] === '') {
    normalized.pop();
  }
  if (normalized.length < 7) {
    throw new Error('incomplete player certificate');
  }

  const sigLine = normalized[normalized.length - 1];
  if (!sigLine.startsWith('signature:')) {
    throw new Error('signature must be the final line of a player certificate');
  }
  const signature = sigLine.slice('signature:'.length).trim();
  if (!signature) {
    throw new Error('missing signature');
  }

  const bodyLines = normalized.slice(0, -1);
  let cursor = 0;
  if (bodyLines[0] === PLAYER_CERT_TITLE) {
    cursor = 1;
  }

  const expectedOrder = ['domain', 'network', 'address', 'player', 'serial', 'issued'] as const;
  const slots: Record<string, string> = {};

  for (const expectedKey of expectedOrder) {
    if (cursor >= bodyLines.length) {
      throw new Error(`missing ${expectedKey}`);
    }
    const line = bodyLines[cursor++];
    const colon = line.indexOf(':');
    if (colon < 0) throw new Error(`line ${cursor} has no ':'`);
    const key = line.slice(0, colon);
    if (key !== expectedKey) {
      throw new Error(`expected "${expectedKey}:" line, got "${key}:"`);
    }
    slots[key] = line.slice(colon + 1).trim();
  }

  let expires: string | undefined;
  let expiresMs: number | undefined;
  if (cursor < bodyLines.length) {
    const line = bodyLines[cursor++];
    const colon = line.indexOf(':');
    if (colon < 0) throw new Error(`line ${cursor} has no ':'`);
    const key = line.slice(0, colon);
    if (key !== 'expires') {
      throw new Error(`unexpected trailing line "${key}:"`);
    }
    expires = line.slice(colon + 1).trim();
    const ms = parseCertIsoTime(expires);
    if (ms === null) throw new Error('expires is not an ISO time');
    expiresMs = ms;
  }

  if (cursor !== bodyLines.length) {
    throw new Error('unexpected extra lines in player certificate');
  }

  const domain = slots.domain;
  if (!DOMAIN_RE.test(domain)) {
    throw new Error(`domain "${domain}" is not licence.divi or licence.<chain>`);
  }
  const networkRaw = slots.network;
  if (networkRaw !== 'mainnet' && networkRaw !== 'testnet') {
    throw new Error(`unknown network "${networkRaw}"`);
  }
  const address = slots.address;
  const player = normalizePlayerPublicKey(slots.player);
  if (!player) {
    throw new Error('player is not a 33-byte compressed key');
  }
  const serial = slots.serial.toLowerCase();
  if (!SERIAL_RE.test(serial)) {
    throw new Error('serial is not 16 bytes of hex');
  }
  const issued = slots.issued;
  const issuedMs = parseCertIsoTime(issued);
  if (issuedMs === null) {
    throw new Error('issued is not an ISO time');
  }

  return {
    domain,
    network: networkRaw,
    address,
    player,
    serial,
    issued,
    issuedMs,
    expires,
    expiresMs,
    signedText: bodyLines.join('\n'),
    signature,
  };
}

export interface WalletReleaseFields {
  title?: typeof WALLET_RELEASE_TITLE | typeof DT1_SIGNIN_TITLE;
  domain?: string;
  network: NetworkType;
  address: string;
  nonce: string;
  issued: string;
  asset: string;
  epk: string;
  period?: number;
}

export interface ParsedWalletReleaseMessage {
  domain: string;
  network: NetworkType;
  address: string;
  nonce: string;
  issued: string;
  issuedMs: number;
  asset: string;
  epk: string;
  period?: number;
  signedText: string;
}

/**
 * Build a canonical versioned DT/1 §11 / `LICENCE-SERVICE.md` §6 wallet-signed
 * release request carrying `asset` and `epk` (and optional `period`).
 */
export function buildWalletReleaseMessage(fields: WalletReleaseFields): string {
  const title = fields.title ?? WALLET_RELEASE_TITLE;
  if (title !== WALLET_RELEASE_TITLE && title !== DT1_SIGNIN_TITLE) {
    throw new Error('Unsupported wallet release message title');
  }
  const domain = (fields.domain ?? DEFAULT_LICENCE_DOMAIN).trim();
  if (!DOMAIN_RE.test(domain)) {
    throw new Error(`Invalid licence domain: ${domain}`);
  }
  if (fields.network !== 'mainnet' && fields.network !== 'testnet') {
    throw new Error(`Unsupported network: ${String(fields.network)}`);
  }
  const address = fields.address.trim();
  if (!isHolderP2pkhAddress(address, fields.network)) {
    throw new Error(`Holder address is not a valid ${fields.network} P2PKH address`);
  }
  const nonce = fields.nonce.trim().toLowerCase();
  if (!/^([0-9a-f]{2}){8,32}$/.test(nonce)) {
    throw new Error('nonce must be 8-32 bytes of hex');
  }
  const issued = fields.issued.trim();
  if (parseCertIsoTime(issued) === null) {
    throw new Error('issued is not an ISO time');
  }
  const asset = fields.asset.trim().toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(asset)) {
    throw new Error('asset is not 32 bytes of hex');
  }
  const epk = normalizePlayerPublicKey(fields.epk);
  if (!epk) {
    throw new Error('epk is not a 33-byte compressed key');
  }

  const lines = [
    title,
    `domain:${domain}`,
    `network:${fields.network}`,
    `address:${address}`,
    `nonce:${nonce}`,
    `issued:${issued}`,
    `asset:${asset}`,
    `epk:${epk}`,
  ];
  if (fields.period !== undefined) {
    if (!Number.isInteger(fields.period) || fields.period < 0) {
      throw new Error('period must be a non-negative integer epoch');
    }
    lines.push(`period:${fields.period}`);
  }
  return lines.join('\n');
}

/**
 * Parse a versioned DT/1 §11 / `LICENCE-SERVICE.md` §6 wallet-signed release message,
 * matching `dnsdivi_licence::request::WalletReleaseRequest::parse`.
 */
export function parseWalletReleaseMessage(text: string): ParsedWalletReleaseMessage {
  const lines = text.split('\n').map(l => (l.endsWith('\r') ? l.slice(0, -1) : l));
  while (lines.length > 0 && lines[lines.length - 1] === '') {
    lines.pop();
  }
  if (lines.length === 0) {
    throw new Error('empty release request message');
  }

  let cursor = 0;
  if (lines[0] === WALLET_RELEASE_TITLE || lines[0] === DT1_SIGNIN_TITLE) {
    cursor = 1;
  }

  const expectedOrder = ['domain', 'network', 'address', 'nonce', 'issued', 'asset', 'epk'] as const;
  const slots: Record<string, string> = {};
  for (const expectedKey of expectedOrder) {
    if (cursor >= lines.length) throw new Error(`missing ${expectedKey} line`);
    const line = lines[cursor++];
    const colon = line.indexOf(':');
    if (colon < 0) throw new Error(`line ${cursor} has no ':'`);
    const key = line.slice(0, colon);
    if (key !== expectedKey) {
      throw new Error(`expected "${expectedKey}:" line, got "${key}:"`);
    }
    slots[key] = line.slice(colon + 1).trim();
  }

  let period: number | undefined;
  if (cursor < lines.length) {
    const line = lines[cursor++];
    const colon = line.indexOf(':');
    if (colon < 0) throw new Error(`line ${cursor} has no ':'`);
    const key = line.slice(0, colon);
    if (key !== 'period') throw new Error(`unknown field "${key}" in release message`);
    const rawPeriod = line.slice(colon + 1).trim();
    if (!/^\d+$/.test(rawPeriod)) throw new Error('period must be an unsigned integer epoch');
    period = Number(rawPeriod);
    if (!Number.isSafeInteger(period)) throw new Error('period overflows safe integer');
  }

  if (cursor !== lines.length) {
    throw new Error('unexpected extra lines in release message');
  }

  const domain = slots.domain;
  if (!DOMAIN_RE.test(domain)) {
    throw new Error(`domain "${domain}" must be licence.divi or licence.<chain>`);
  }
  const networkRaw = slots.network;
  if (networkRaw !== 'mainnet' && networkRaw !== 'testnet') {
    throw new Error(`unknown network "${networkRaw}"`);
  }
  const nonce = slots.nonce.toLowerCase();
  if (!/^([0-9a-f]{2}){8,32}$/.test(nonce)) {
    throw new Error('nonce must be 8-32 bytes of hex');
  }
  const issuedMs = parseCertIsoTime(slots.issued);
  if (issuedMs === null) {
    throw new Error('issued is not an ISO time');
  }
  const asset = slots.asset.toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(asset)) {
    throw new Error('asset is not 32 bytes of hex');
  }
  const epk = normalizePlayerPublicKey(slots.epk);
  if (!epk) {
    throw new Error('epk is not a 33-byte compressed key');
  }

  return {
    domain,
    network: networkRaw,
    address: slots.address,
    nonce,
    issued: slots.issued,
    issuedMs,
    asset,
    epk,
    ...(period !== undefined ? { period } : {}),
    signedText: lines.join('\n'),
  };
}

/**
 * Parse and cryptographically verify a §12.5 player certificate (`DarkNet Signed Message:\n`
 * signature recovery + optional network and time-window check).
 */
export function verifyPlayerCertificate(
  text: string,
  options: { expectedNetwork?: NetworkType; nowMs?: number } = {},
): SignedPlayerCertificate {
  const parsed = parsePlayerCertificate(text);
  if (options.expectedNetwork && parsed.network !== options.expectedNetwork) {
    throw new Error(`certificate is for ${parsed.network}, expected ${options.expectedNetwork}`);
  }
  if (!Signer.verifyMessage(parsed.address, parsed.signature, parsed.signedText, parsed.network)) {
    throw new Error('certificate is not signed by its address');
  }
  if (options.nowMs !== undefined) {
    if (parsed.issuedMs > options.nowMs + 5 * 60 * 1000) {
      throw new Error('certificate is issued in the future');
    }
    if (parsed.expiresMs !== undefined && options.nowMs >= parsed.expiresMs) {
      throw new Error(`certificate expired at ${parsed.expires}`);
    }
  }
  return {
    ...parsed,
    certificateText: `${parsed.signedText}\nsignature:${parsed.signature}\n`,
  };
}

/** Encode UTF-8 certificate text as standard single-line Base64. */
export function encodePlayerCertificateBase64(certificateText: string): string {
  const bytes = new TextEncoder().encode(certificateText);
  let bin = '';
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin);
}

/** Export a verified/signed player certificate in the user's chosen format (`text`, `base64`, or `json`). */
export function exportPlayerCertificate(cert: SignedPlayerCertificate, format: PlayerCertExportFormat): string {
  switch (format) {
    case 'text':
      return cert.certificateText;
    case 'base64':
      return encodePlayerCertificateBase64(cert.certificateText);
    case 'json':
      return JSON.stringify(
        {
          certificate: cert.certificateText,
          domain: cert.domain,
          network: cert.network,
          address: cert.address,
          player: cert.player,
          serial: cert.serial,
          issued: cert.issued,
          ...(cert.expires !== undefined ? { expires: cert.expires } : {}),
          signature: cert.signature,
        },
        null,
        2,
      );
  }
}
