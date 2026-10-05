// Transaction Signing using secp256k1 ECDSA
// Signs transaction hashes with user's derived keys
// All operations happen client-side - keys never leave the browser

import { Hash } from './hash';
import { bytesToHex } from './hex';
import {
    CURVE,
    mod,
    modInverse,
    bytesToBigInt,
    bigIntToBytes,
    pointAdd,
    scalarMult
} from './secp256k1';

// HMAC-SHA256 using Web Crypto API
async function hmacSha256(key: Uint8Array, data: Uint8Array): Promise<Uint8Array> {
    const cryptoKey = await crypto.subtle.importKey(
        'raw',
        key.buffer.slice(key.byteOffset, key.byteOffset + key.byteLength) as ArrayBuffer,
        { name: 'HMAC', hash: 'SHA-256' },
        false,
        ['sign']
    );
    const signature = await crypto.subtle.sign(
        'HMAC',
        cryptoKey,
        data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) as ArrayBuffer
    );
    return new Uint8Array(signature);
}

// RFC 6979 deterministic nonce generation using HMAC-DRBG
async function generateRfc6979K(privateKey: Uint8Array, hash: Uint8Array): Promise<bigint> {
    // Step a: h1 = H(m) - hash is already provided
    // Ensure hash is reduced modulo N if needed (already 32 bytes for SHA256)

    // Step b: V = 0x01 0x01 0x01 ... 0x01 (32 bytes)
    let V: Uint8Array = new Uint8Array(32).fill(0x01);

    // Step c: K = 0x00 0x00 0x00 ... 0x00 (32 bytes)
    let K: Uint8Array = new Uint8Array(32).fill(0x00);

    // Step d: K = HMAC_K(V || 0x00 || int2octets(x) || bits2octets(h1))
    K = await hmacSha256(K, new Uint8Array([...V, 0x00, ...privateKey, ...hash]));

    // Step e: V = HMAC_K(V)
    V = await hmacSha256(K, V);

    // Step f: K = HMAC_K(V || 0x01 || int2octets(x) || bits2octets(h1))
    K = await hmacSha256(K, new Uint8Array([...V, 0x01, ...privateKey, ...hash]));

    // Step g: V = HMAC_K(V)
    V = await hmacSha256(K, V);

    // Step h: Loop until valid k found
    while (true) {
        // Step h.1 and h.2: Generate T (empty initially, then fill with V values)
        // For secp256k1, we need exactly 32 bytes, so one V is sufficient
        V = await hmacSha256(K, V);

        // Step h.3: k = bits2int(T)
        const k = bytesToBigInt(V);

        // Check if k is valid: 1 <= k < N
        if (k >= 1n && k < CURVE.N) {
            return k;
        }

        // If k is invalid, update K and V and retry
        K = await hmacSha256(K, new Uint8Array([...V, 0x00]));
        V = await hmacSha256(K, V);
    }
}

// Sign a hash with a key
async function signHash(hash: Uint8Array, key: Uint8Array): Promise<Uint8Array> {
    const z = bytesToBigInt(hash);
    const d = bytesToBigInt(key);

    // Generate deterministic k using RFC 6979 HMAC-DRBG
    const k = await generateRfc6979K(key, hash);

    const G: [bigint, bigint] = [CURVE.Gx, CURVE.Gy];
    const kG = scalarMult(k, G);
    if (kG === null) throw new Error('Invalid k');

    const r = mod(kG[0], CURVE.N);
    if (r === 0n) throw new Error('Invalid r');

    let s = mod(modInverse(k, CURVE.N) * (z + r * d), CURVE.N);

    // Low-S normalization (BIP 62)
    if (s > CURVE.N / 2n) {
        s = CURVE.N - s;
    }

    return derEncode(r, s);
}

// DER encode signature
function derEncode(r: bigint, s: bigint): Uint8Array {
    const rBytes = bigIntToBytes(r, 32);
    const sBytes = bigIntToBytes(s, 32);

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

// Elliptic curve helpers imported from secp256k1.ts

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

// Sign hash with recovery ID
async function signMessageWithRecovery(hash: Uint8Array, privateKey: Uint8Array, publicKey: Uint8Array): Promise<{ r: Uint8Array; s: Uint8Array; recid: number }> {
    const z = bytesToBigInt(hash);
    const d = bytesToBigInt(privateKey);

    // Generate deterministic k using RFC 6979 HMAC-DRBG
    const k = await generateRfc6979K(privateKey, hash);

    const G: [bigint, bigint] = [CURVE.Gx, CURVE.Gy];
    const kG = scalarMult(k, G);
    if (kG === null) throw new Error('Invalid k');

    const r = mod(kG[0], CURVE.N);
    if (r === 0n) throw new Error('Invalid r');

    let s = mod(modInverse(k, CURVE.N) * (z + r * d), CURVE.N);

    // Low-S normalization (BIP 62)
    if (s > CURVE.N / 2n) {
        s = CURVE.N - s;
    }

    // Determine recovery ID by trying to recover the public key
    const rBytes = bigIntToBytes(r, 32);
    const sBytes = bigIntToBytes(s, 32);

    // Extract x and y from public key (assuming compressed format)
    let pubX: bigint, pubY: bigint;
    if (publicKey[0] === 0x04) {
        // Uncompressed
        pubX = bytesToBigInt(publicKey.slice(1, 33));
        pubY = bytesToBigInt(publicKey.slice(33, 65));
    } else {
        // Compressed
        pubX = bytesToBigInt(publicKey.slice(1, 33));
        const ySquared = mod((pubX * pubX * pubX + 7n), CURVE.P);
        pubY = modSqrt(ySquared, CURVE.P) || 0n;
        if ((publicKey[0] === 0x02 && (pubY & 1n) === 1n) ||
            (publicKey[0] === 0x03 && (pubY & 1n) === 0n)) {
            pubY = CURVE.P - pubY;
        }
    }

    // Try recovery IDs 0-3
    let recid = -1;
    for (let i = 0; i < 4; i++) {
        try {
            const recovered = recoverPublicKey(rBytes, sBytes, hash, i);
            if (recovered && recovered[0] === pubX && recovered[1] === pubY) {
                recid = i;
                break;
            }
        } catch (e) {
            continue;
        }
    }

    if (recid === -1) {
        throw new Error('Could not determine recovery ID');
    }

    return { r: rBytes, s: sBytes, recid };
}

// Recover public key from signature (for recovery ID determination)
function recoverPublicKey(rBytes: Uint8Array, sBytes: Uint8Array, hash: Uint8Array, recid: number): [bigint, bigint] | null {
    const r = bytesToBigInt(rBytes);
    const s = bytesToBigInt(sBytes);
    const z = bytesToBigInt(hash);

    // Compute x coordinate of R
    const x = r + (BigInt(recid >> 1) * CURVE.N);
    if (x >= CURVE.P) return null;

    // Compute y coordinate
    const ySquared = mod((x * x * x + 7n), CURVE.P);
    let y = modSqrt(ySquared, CURVE.P);
    if (y === null) return null;

    // Choose correct y based on recid
    if (((y & 1n) === 1n) !== ((recid & 1) === 1)) {
        y = CURVE.P - y;
    }

    const R: [bigint, bigint] = [x, y];
    const rInv = modInverse(r, CURVE.N);

    // Q = r^-1 * (s*R - z*G)
    const sR = scalarMult(s, R);
    const zG = scalarMult(z, [CURVE.Gx, CURVE.Gy]);
    const negZG = zG ? [zG[0], mod(-zG[1], CURVE.P)] as [bigint, bigint] : null;
    const sum = pointAdd(sR, negZG);

    return sum ? scalarMult(rInv, sum) : null;
}

// Modular square root (Tonelli-Shanks algorithm)
function modSqrt(a: bigint, p: bigint): bigint | null {
    if (modPow(a, (p - 1n) / 2n, p) !== 1n) return null;

    // For secp256k1, p ≡ 3 (mod 4), so we can use the simple formula
    if (p % 4n === 3n) {
        return modPow(a, (p + 1n) / 4n, p);
    }

    return null; // Fallback for other primes
}

// Modular exponentiation
function modPow(base: bigint, exp: bigint, mod: bigint): bigint {
    let result = 1n;
    base = base % mod;
    while (exp > 0n) {
        if (exp & 1n) {
            result = (result * base) % mod;
        }
        exp = exp >> 1n;
        base = (base * base) % mod;
    }
    return result;
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

    // Sign with recovery
    const { r, s, recid } = await signMessageWithRecovery(hash2, privateKey, publicKey);

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
