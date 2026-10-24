// Hierarchical Deterministic (HD) Key Derivation
// BIP32/BIP44 standard for deriving multiple addresses from a single seed
// This allows users to backup one phrase and recover all addresses

import { secureWipe } from '../shared/crypto-utils';
import {
    CURVE,
    bytesToBigInt,
    bigIntToBytes,
    derivePublicKey
} from './secp256k1';

class HDKey {
    privateKey: Uint8Array | null = null;
    publicKey: Uint8Array | null = null;
    chainCode: Uint8Array | null = null;

    static async fromMasterSeed(seed: Uint8Array): Promise<HDKey> {
        const key = new HDKey();

        // HMAC-SHA512 with "Bitcoin seed" as key
        const hmacKey = new TextEncoder().encode('Bitcoin seed');
        const cryptoKey = await crypto.subtle.importKey(
            'raw', hmacKey, { name: 'HMAC', hash: 'SHA-512' }, false, ['sign']
        );
        const I = await crypto.subtle.sign('HMAC', cryptoKey, seed as BufferSource);
        const IBytes = new Uint8Array(I);

        key.privateKey = IBytes.slice(0, 32);
        key.chainCode = IBytes.slice(32);
        secureWipe(IBytes);
        key.publicKey = derivePublicKey(key.privateKey);

        return key;
    }

    async derive(path: string): Promise<HDKey> {
        // Validate BIP32/BIP44 path format
        // Must start with 'm', followed by /number or /number' segments
        const pathRegex = /^m(\/\d+'?)*$/;
        if (!pathRegex.test(path)) {
            throw new Error(`Invalid derivation path format: ${path}`);
        }

        const segments = path.split('/');
        let current: HDKey = this;

        for (const segment of segments) {
            if (segment === 'm') continue;

            const hardened = segment.endsWith("'");
            const indexStr = segment.replace("'", '');

            // Validate index is a valid number (no leading zeros except for '0')
            if (!/^(0|[1-9]\d*)$/.test(indexStr)) {
                throw new Error(`Invalid path segment: ${segment}`);
            }

            const index = parseInt(indexStr);

            // Validate index range (0 to 2^31 - 1)
            if (index < 0 || index > 0x7FFFFFFF) {
                throw new Error(`Path index out of range: ${index}`);
            }

            const child = await current.deriveChild(hardened ? index + 0x80000000 : index);
            // Keys part way down the path are not returned, so wipe them now.
            // The key derive was called on belongs to the caller.
            if (current !== this) current.wipe();
            current = child;
        }

        return current;
    }

    wipe(): void {
        if (this.privateKey) {
            secureWipe(this.privateKey);
            this.privateKey = null;
        }
        if (this.chainCode) {
            secureWipe(this.chainCode);
            this.chainCode = null;
        }
    }

    async deriveChild(index: number): Promise<HDKey> {
        if (!this.privateKey || !this.publicKey || !this.chainCode) {
            throw new Error('Cannot derive from incomplete key');
        }

        const child = new HDKey();
        const data = new Uint8Array(37);

        if (index >= 0x80000000) {
            // Hardened derivation
            data[0] = 0;
            data.set(this.privateKey, 1);
        } else {
            // Normal derivation
            data.set(this.publicKey, 0);
        }

        // Index as big-endian 32-bit
        data[33] = (index >>> 24) & 0xff;
        data[34] = (index >>> 16) & 0xff;
        data[35] = (index >>> 8) & 0xff;
        data[36] = index & 0xff;

        // HMAC-SHA512
        const cryptoKey = await crypto.subtle.importKey(
            'raw', this.chainCode as BufferSource, { name: 'HMAC', hash: 'SHA-512' }, false, ['sign']
        );
        const I = await crypto.subtle.sign('HMAC', cryptoKey, data);
        const IBytes = new Uint8Array(I);

        const IL = IBytes.slice(0, 32);
        const IR = IBytes.slice(32);
        // data holds the parent's private key for a hardened step
        secureWipe(data);
        secureWipe(IBytes);

        // Add IL to parent private key (mod n)
        child.privateKey = addPrivateKeys(IL, this.privateKey);
        secureWipe(IL);
        child.chainCode = IR;
        child.publicKey = derivePublicKey(child.privateKey);

        return child;
    }
}

// Uses CURVE.N from secp256k1.ts for curve order
function addPrivateKeys(a: Uint8Array, b: Uint8Array): Uint8Array {
    const aBig = bytesToBigInt(a);
    const bBig = bytesToBigInt(b);
    const sum = (aBig + bBig) % CURVE.N;
    return bigIntToBytes(sum, 32);
}

export { HDKey };
