// RIPEMD160 hash function
// Used in cryptocurrency address generation (combined with SHA256)

function ripemd160(data: Uint8Array): Uint8Array {
    const K = [0x00000000, 0x5a827999, 0x6ed9eba1, 0x8f1bbcdc, 0xa953fd4e];
    const KP = [0x50a28be6, 0x5c4dd124, 0x6d703ef3, 0x7a6d76e9, 0x00000000];

    const R = [
        0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15,
        7, 4, 13, 1, 10, 6, 15, 3, 12, 0, 9, 5, 2, 14, 11, 8,
        3, 10, 14, 4, 9, 15, 8, 1, 2, 7, 0, 6, 13, 11, 5, 12,
        1, 9, 11, 10, 0, 8, 12, 4, 13, 3, 7, 15, 14, 5, 6, 2,
        4, 0, 5, 9, 7, 12, 2, 10, 14, 1, 3, 8, 11, 6, 15, 13
    ];

    const RP = [
        5, 14, 7, 0, 9, 2, 11, 4, 13, 6, 15, 8, 1, 10, 3, 12,
        6, 11, 3, 7, 0, 13, 5, 10, 14, 15, 8, 12, 4, 9, 1, 2,
        15, 5, 1, 3, 7, 14, 6, 9, 11, 8, 12, 2, 10, 0, 4, 13,
        8, 6, 4, 1, 3, 11, 15, 0, 5, 12, 2, 13, 9, 7, 10, 14,
        12, 15, 10, 4, 1, 5, 8, 7, 6, 2, 13, 14, 0, 3, 9, 11
    ];

    const S = [
        11, 14, 15, 12, 5, 8, 7, 9, 11, 13, 14, 15, 6, 7, 9, 8,
        7, 6, 8, 13, 11, 9, 7, 15, 7, 12, 15, 9, 11, 7, 13, 12,
        11, 13, 6, 7, 14, 9, 13, 15, 14, 8, 13, 6, 5, 12, 7, 5,
        11, 12, 14, 15, 14, 15, 9, 8, 9, 14, 5, 6, 8, 6, 5, 12,
        9, 15, 5, 11, 6, 8, 13, 12, 5, 12, 13, 14, 11, 8, 5, 6
    ];

    const SP = [
        8, 9, 9, 11, 13, 15, 15, 5, 7, 7, 8, 11, 14, 14, 12, 6,
        9, 13, 15, 7, 12, 8, 9, 11, 7, 7, 12, 7, 6, 15, 13, 11,
        9, 7, 15, 11, 8, 6, 6, 14, 12, 13, 5, 14, 13, 13, 7, 5,
        15, 5, 8, 11, 14, 14, 6, 14, 6, 9, 12, 9, 12, 5, 15, 8,
        8, 5, 12, 9, 12, 5, 14, 6, 8, 13, 6, 5, 15, 13, 11, 11
    ];

    function f(j: number, x: number, y: number, z: number): number {
        if (j < 16) return x ^ y ^ z;
        if (j < 32) return (x & y) | (~x & z);
        if (j < 48) return (x | ~y) ^ z;
        if (j < 64) return (x & z) | (y & ~z);
        return x ^ (y | ~z);
    }

    function rotl(x: number, n: number): number {
        return ((x << n) | (x >>> (32 - n))) >>> 0;
    }

    const msg = new Uint8Array(data);
    const msgLen = msg.length;

    const padLen = ((msgLen + 8) % 64 === 0) ? 64 : 64 - ((msgLen + 8) % 64);
    const padded = new Uint8Array(msgLen + padLen + 8);
    padded.set(msg);
    padded[msgLen] = 0x80;

    const msgBits = msgLen * 8;
    padded[padded.length - 8] = msgBits & 0xff;
    padded[padded.length - 7] = (msgBits >>> 8) & 0xff;
    padded[padded.length - 6] = (msgBits >>> 16) & 0xff;
    padded[padded.length - 5] = (msgBits >>> 24) & 0xff;

    let h0 = 0x67452301;
    let h1 = 0xefcdab89;
    let h2 = 0x98badcfe;
    let h3 = 0x10325476;
    let h4 = 0xc3d2e1f0;

    for (let i = 0; i < padded.length; i += 64) {
        const X = new Uint32Array(16);
        for (let j = 0; j < 16; j++) {
            X[j] = padded[i + j * 4] | (padded[i + j * 4 + 1] << 8) |
                   (padded[i + j * 4 + 2] << 16) | (padded[i + j * 4 + 3] << 24);
        }

        let a = h0, b = h1, c = h2, d = h3, e = h4;
        let ap = h0, bp = h1, cp = h2, dp = h3, ep = h4;

        for (let j = 0; j < 80; j++) {
            const rj = Math.floor(j / 16);

            let t = (a + f(j, b, c, d) + X[R[j]] + K[rj]) >>> 0;
            t = (rotl(t, S[j]) + e) >>> 0;
            a = e; e = d; d = rotl(c, 10); c = b; b = t;

            t = (ap + f(79 - j, bp, cp, dp) + X[RP[j]] + KP[rj]) >>> 0;
            t = (rotl(t, SP[j]) + ep) >>> 0;
            ap = ep; ep = dp; dp = rotl(cp, 10); cp = bp; bp = t;
        }

        const t = (h1 + c + dp) >>> 0;
        h1 = (h2 + d + ep) >>> 0;
        h2 = (h3 + e + ap) >>> 0;
        h3 = (h4 + a + bp) >>> 0;
        h4 = (h0 + b + cp) >>> 0;
        h0 = t;
    }

    const result = new Uint8Array(20);
    [h0, h1, h2, h3, h4].forEach((h, i) => {
        result[i * 4] = h & 0xff;
        result[i * 4 + 1] = (h >>> 8) & 0xff;
        result[i * 4 + 2] = (h >>> 16) & 0xff;
        result[i * 4 + 3] = (h >>> 24) & 0xff;
    });

    return result;
}

export const RIPEMD160 = { hash: ripemd160 };
