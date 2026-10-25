// Transaction Signing using secp256k1 ECDSA
// Signs transaction hashes with user's derived keys
// All operations happen client-side - keys never leave the browser

import { Hash } from './hash';
import { bytesToHex } from './hex';
import { isValidPrivateKey, secp } from './secp256k1';

// ECDSA over a 32-byte hash: RFC 6979 nonce and low S (BIP 62), from
// @noble/secp256k1. Returns r, s and the recovery id.
function sign(hash: Uint8Array, key: Uint8Array): { r: Uint8Array; s: Uint8Array; recid: number } {
    // A zero key signs for nobody and an out-of-range one is a corrupted key
    if (!isValidPrivateKey(key)) throw new Error('Invalid private key');
    if (!(hash instanceof Uint8Array) || hash.length !== 32) throw new Error('Hash must be 32 bytes');
    const sig = secp.sign(hash, key, { prehash: false, lowS: true, format: 'recovered' });
    return { recid: sig[0], r: sig.slice(1, 33), s: sig.slice(33, 65) };
}

// Sign a hash with a key
async function signHash(hash: Uint8Array, key: Uint8Array): Promise<Uint8Array> {
    const { r, s } = sign(hash, key);
    return derEncode(r, s);
}

// DER encode signature
function derEncode(rBytes: Uint8Array, sBytes: Uint8Array): Uint8Array {
    function formatInt(bytes: Uint8Array): Uint8Array {
        let start = 0;
        while (start < bytes.length - 1 && bytes[start] === 0) start++;
        let trimmed = bytes.slice(start);
        if (trimmed[0] >= 0x80) {
            const padded = new Uint8Array(trimmed.length + 1);
            padded.set(trimmed, 1);
            trimmed = padded;
        }
        return trimmed;
    }

    const rDer = formatInt(rBytes);
    const sDer = formatInt(sBytes);

    const der = new Uint8Array(6 + rDer.length + sDer.length);
    der[0] = 0x30; // SEQUENCE
    der[1] = 4 + rDer.length + sDer.length;
    der[2] = 0x02; // INTEGER
    der[3] = rDer.length;
    der.set(rDer, 4);
    der[4 + rDer.length] = 0x02; // INTEGER
    der[5 + rDer.length] = sDer.length;
    der.set(sDer, 6 + rDer.length);

    return der;
}

// Create scriptSig from signature and public key
function createScriptSig(signature: Uint8Array, publicKey: Uint8Array): string {
    // signature + SIGHASH_ALL byte + public key
    const sigWithHashType = new Uint8Array([...signature, 0x01]);
    const sigLen = sigWithHashType.length;
    const pubLen = publicKey.length;

    const script = new Uint8Array(1 + sigLen + 1 + pubLen);
    script[0] = sigLen;
    script.set(sigWithHashType, 1);
    script[1 + sigLen] = pubLen;
    script.set(publicKey, 1 + sigLen + 1);

    return bytesToHex(script);
}

// Encode integer as Bitcoin varint
function varintEncode(n: number): Uint8Array {
    if (n < 0xfd) {
        return new Uint8Array([n]);
    } else if (n <= 0xffff) {
        return new Uint8Array([0xfd, n & 0xff, (n >> 8) & 0xff]);
    } else if (n <= 0xffffffff) {
        return new Uint8Array([0xfe, n & 0xff, (n >> 8) & 0xff, (n >> 16) & 0xff, (n >> 24) & 0xff]);
    } else {
        throw new Error('Varint too large');
    }
}

// Sign a message with Bitcoin-style prefix and return base64 compact signature
async function signMessage(message: string, privateKey: Uint8Array, publicKey: Uint8Array): Promise<string> {
    // Construct prefixed message
    // DarkNet Signed Message prefix (Divi, and therefore IronDivi, uses this)
    // \x18 = 24 = length of "DarkNet Signed Message:\n"
    const prefix = "\x18DarkNet Signed Message:\n";
    const messageBytes = new TextEncoder().encode(message);
    const messageLen = varintEncode(messageBytes.length);

    // Concatenate: prefix + varint(len) + message
    const prefixBytes = new TextEncoder().encode(prefix);
    const fullMessage = new Uint8Array(prefixBytes.length + messageLen.length + messageBytes.length);
    fullMessage.set(prefixBytes, 0);
    fullMessage.set(messageLen, prefixBytes.length);
    fullMessage.set(messageBytes, prefixBytes.length + messageLen.length);

    // Double SHA256 hash
    const hash1 = Hash.sha256(fullMessage);
    const hash2 = Hash.sha256(hash1);

    // The recovery id is for the key's own public key, so the two must match
    if (!isValidPrivateKey(privateKey)) throw new Error('Invalid private key');
    const own = secp.getPublicKey(privateKey, true);
    if (publicKey.length !== own.length || !publicKey.every((b, i) => b === own[i])) {
        throw new Error('Public key does not match the private key');
    }
    const { r, s, recid } = sign(hash2, privateKey);

    // Create 65-byte compact signature
    // header_byte = 27 + recid + 4 (for compressed pubkey)
    const headerByte = 27 + recid + 4;
    const compactSig = new Uint8Array(65);
    compactSig[0] = headerByte;
    compactSig.set(r, 1);
    compactSig.set(s, 33);

    // Return base64-encoded signature
    return btoa(String.fromCharCode(...compactSig));
}

export const Signer = { signHash, createScriptSig, signMessage };
