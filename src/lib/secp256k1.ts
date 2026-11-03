// secp256k1 for the wallet: the curve itself is @noble/secp256k1 (audited,
// constant-time point multiplication); this file keeps the few helpers the
// rest of the code uses, so nothing else imports the library directly

import * as secp from '@noble/secp256k1';
import { hmac } from '@noble/hashes/hmac.js';
import { sha256 } from '@noble/hashes/sha2.js';

// The synchronous sign and getPublicKey need these
secp.hashes.sha256 = sha256;
secp.hashes.hmacSha256 = (key, msg) => hmac(sha256, key, msg);

export { secp };

/**
 * secp256k1 curve parameters
 */
export const CURVE = {
    P: BigInt('0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEFFFFFC2F'),
    N: BigInt('0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEBAAEDCE6AF48A03BBFD25E8CD0364141'),
} as const;

/**
 * Convert byte array to bigint (big-endian)
 */
export function bytesToBigInt(bytes: Uint8Array): bigint {
    let result = 0n;
    for (const b of bytes) {
        result = (result << 8n) + BigInt(b);
    }
    return result;
}

/**
 * Convert bigint to byte array (big-endian, fixed length)
 */
export function bigIntToBytes(num: bigint, length: number): Uint8Array {
    const bytes = new Uint8Array(length);
    for (let i = length - 1; i >= 0; i--) {
        bytes[i] = Number(num & 0xffn);
        num = num >> 8n;
    }
    return bytes;
}

/**
 * A private key is 32 bytes holding a number from 1 to n - 1
 */
export function isValidPrivateKey(privateKey: Uint8Array): boolean {
    if (!(privateKey instanceof Uint8Array) || privateKey.length !== 32) return false;
    return secp.utils.isValidSecretKey(privateKey);
}

/**
 * Derive compressed public key from private key
 * Returns 33-byte compressed format (0x02/0x03 prefix + 32-byte x coordinate)
 */
export function derivePublicKey(privateKey: Uint8Array): Uint8Array {
    return secp.getPublicKey(privateKey, true);
}

/**
 * True iff `publicKey` is a valid 33-byte compressed SEC point (0x02/0x03) on secp256k1.
 */
export function isValidCompressedPublicKey(publicKey: Uint8Array): boolean {
    if (!(publicKey instanceof Uint8Array) || publicKey.length !== 33) return false;
    if (publicKey[0] !== 0x02 && publicKey[0] !== 0x03) return false;
    try {
        secp.Point.fromBytes(publicKey);
        return true;
    } catch {
        return false;
    }
}

/**
 * Recover the signer public key from a 32-byte message digest and a 65-byte
 * Divi/Bitcoin compact recoverable signature (`header 27..34 || r32 || s32`).
 */
export function recoverPublicKeyFromCompact(hash32: Uint8Array, compactSig65: Uint8Array): Uint8Array | null {
    if (!(hash32 instanceof Uint8Array) || hash32.length !== 32) return null;
    if (!(compactSig65 instanceof Uint8Array) || compactSig65.length !== 65) return null;
    const header = compactSig65[0];
    if (header < 27 || header > 34) return null;
    const compressed = header >= 31;
    const recid = (header - 27) & 3;
    const recoveredSig = new Uint8Array(65);
    recoveredSig[0] = recid;
    recoveredSig.set(compactSig65.subarray(1, 65), 1);
    try {
        const pubCompressed = secp.recoverPublicKey(recoveredSig, hash32, { prehash: false });
        return compressed ? pubCompressed : secp.Point.fromBytes(pubCompressed).toBytes(false);
    } catch {
        return null;
    }
}
