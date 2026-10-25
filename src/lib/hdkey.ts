// Hierarchical Deterministic (HD) Key Derivation
// BIP32/BIP44 standard for deriving multiple addresses from a single seed
// This allows users to backup one phrase and recover all addresses
//
// The derivation is @scure/bip32's; this class keeps the wallet's own
// interface (async, plain fields, wipe) and wipes the library's copies

import { HDKey as ScureHDKey } from '@scure/bip32';
import { secureWipe } from '../shared/crypto-utils';

// Zero what a library key holds. Its getters return copies, so the chain
// code is reached through the field they copy from.
function wipeScure(key: ScureHDKey): void {
    key.wipePrivateData();
    const chainCode = (key as unknown as { _chainCode?: Uint8Array | null })._chainCode;
    if (chainCode) secureWipe(chainCode);
}

class HDKey {
    privateKey: Uint8Array | null = null;
    publicKey: Uint8Array | null = null;
    chainCode: Uint8Array | null = null;

    private static from(scure: ScureHDKey): HDKey {
        const key = new HDKey();
        key.privateKey = scure.privateKey;
        key.publicKey = scure.publicKey;
        key.chainCode = scure.chainCode;
        wipeScure(scure);
        return key;
    }

    static async fromMasterSeed(seed: Uint8Array): Promise<HDKey> {
        let master: ScureHDKey;
        try {
            master = ScureHDKey.fromMasterSeed(seed);
        } catch {
            // BIP32: a master key of 0 or at least n is invalid. The chance is
            // about 2^-127, so refuse the seed rather than guess a recovery
            throw new Error('Seed gives an invalid master key');
        }
        return HDKey.from(master);
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
        // The library copies what it is given
        const parent = new ScureHDKey({ privateKey: this.privateKey, chainCode: this.chainCode });
        let child: ScureHDKey;
        try {
            child = parent.deriveChild(index);
        } catch {
            throw new Error(`Index ${index} gives an invalid key`);
        } finally {
            wipeScure(parent);
        }
        // BIP32: if IL >= n or the child key is 0, this index has no key, and
        // the library moves on to the next index. The wallet names a key by
        // its path, so a key for another index is refused instead (the chance
        // is about 2^-127)
        if (child.index !== index) {
            wipeScure(child);
            throw new Error(`Index ${index} gives an invalid key`);
        }
        return HDKey.from(child);
    }
}

export { HDKey };
