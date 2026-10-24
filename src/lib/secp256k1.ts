// Consolidated secp256k1 elliptic curve primitives
// Single source of truth for all curve operations used in signing and HD derivation

/**
 * secp256k1 curve parameters
 */
export const CURVE = {
    P: BigInt('0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEFFFFFC2F'),
    N: BigInt('0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEBAAEDCE6AF48A03BBFD25E8CD0364141'),
    Gx: BigInt('0x79BE667EF9DCBBAC55A06295CE870B07029BFCDB2DCE28D959F2815B16F81798'),
    Gy: BigInt('0x483ADA7726A3C4655DA4FBFC0E1108A8FD17B448A68554199C47D08FFB10D4B8')
} as const;

/**
 * Modular arithmetic - handles negative values correctly
 */
export function mod(a: bigint, m: bigint): bigint {
    const result = a % m;
    return result >= 0n ? result : result + m;
}

/**
 * Extended Euclidean algorithm for modular multiplicative inverse
 */
export function modInverse(a: bigint, m: bigint): bigint {
    let [old_r, r] = [mod(a, m), m];
    let [old_s, s] = [1n, 0n];
    while (r !== 0n) {
        const q = old_r / r;
        [old_r, r] = [r, old_r - q * r];
        [old_s, s] = [s, old_s - q * s];
    }
    return mod(old_s, m);
}

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
 * Elliptic curve point addition
 * @param p1 First point or null (point at infinity)
 * @param p2 Second point or null (point at infinity)
 * @param P Field prime (defaults to CURVE.P)
 */
export function pointAdd(
    p1: [bigint, bigint] | null,
    p2: [bigint, bigint] | null,
    P: bigint = CURVE.P
): [bigint, bigint] | null {
    if (p1 === null) return p2;
    if (p2 === null) return p1;

    const [x1, y1] = p1;
    const [x2, y2] = p2;

    if (x1 === x2 && y1 !== y2) return null;

    let m: bigint;
    if (x1 === x2) {
        m = mod((3n * x1 * x1) * modInverse(2n * y1, P), P);
    } else {
        m = mod((y2 - y1) * modInverse(x2 - x1, P), P);
    }

    const x3 = mod(m * m - x1 - x2, P);
    const y3 = mod(m * (x1 - x3) - y1, P);

    return [x3, y3];
}

/**
 * Elliptic curve scalar multiplication (double-and-add)
 * @param k Scalar multiplier
 * @param point Base point
 * @param P Field prime (defaults to CURVE.P)
 */
export function scalarMult(
    k: bigint,
    point: [bigint, bigint],
    P: bigint = CURVE.P
): [bigint, bigint] | null {
    let result: [bigint, bigint] | null = null;
    let addend: [bigint, bigint] | null = point;

    while (k > 0n) {
        if (k & 1n) {
            result = pointAdd(result, addend, P);
        }
        addend = pointAdd(addend, addend, P);
        k = k >> 1n;
    }

    return result;
}

/**
 * A private key is 32 bytes holding a number from 1 to n - 1
 */
export function isValidPrivateKey(privateKey: Uint8Array): boolean {
    if (!(privateKey instanceof Uint8Array) || privateKey.length !== 32) return false;
    const d = bytesToBigInt(privateKey);
    return d > 0n && d < CURVE.N;
}

/**
 * Derive compressed public key from private key
 * Returns 33-byte compressed format (0x02/0x03 prefix + 32-byte x coordinate)
 */
export function derivePublicKey(privateKey: Uint8Array): Uint8Array {
    const k = bytesToBigInt(privateKey);
    const point = scalarMult(k, [CURVE.Gx, CURVE.Gy]);

    if (!point) throw new Error('Invalid point');

    // Compressed public key format
    const prefix = point[1] % 2n === 0n ? 0x02 : 0x03;
    const xBytes = bigIntToBytes(point[0], 32);

    const pubKey = new Uint8Array(33);
    pubKey[0] = prefix;
    pubKey.set(xBytes, 1);

    return pubKey;
}
