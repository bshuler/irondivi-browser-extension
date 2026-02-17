// PrivateDivi Address Generation
// Converts public keys to human-readable addresses

import { Base58 } from './base58';
import { Hash } from './hash';
import { RIPEMD160 } from './ripemd160';

// Network parameters for PrivateDivi
const NETWORKS = {
    mainnet: {
        pubKeyHash: 0x1e,  // 'D' prefix
        scriptHash: 0x13
    },
    testnet: {
        pubKeyHash: 0x8b,  // 'xy' prefix
        scriptHash: 0x13
    }
} as const;

type Network = keyof typeof NETWORKS;

// Generate address from public key
function publicKeyToAddress(publicKey: Uint8Array, network: Network = 'testnet'): string {
    // Hash160 = RIPEMD160(SHA256(pubKey))
    const sha = Hash.sha256(publicKey);
    const hash160 = RIPEMD160.hash(sha);

    // Add version byte
    const version = NETWORKS[network].pubKeyHash;
    const payload = new Uint8Array(21);
    payload[0] = version;
    payload.set(hash160, 1);

    // Add checksum (first 4 bytes of double SHA256)
    const checksum = Hash.doubleSha256(payload).slice(0, 4);

    // Combine and encode
    const address = new Uint8Array(25);
    address.set(payload);
    address.set(checksum, 21);

    return Base58.encode(address);
}

// Decode address to get pubKeyHash
function decodeAddress(address: string): { version: number; hash: Uint8Array } {
    const decoded = Base58.decode(address);

    if (decoded.length !== 25) {
        throw new Error('Invalid address length');
    }

    // Verify checksum
    const payload = decoded.slice(0, 21);
    const checksum = decoded.slice(21);
    const expectedChecksum = Hash.doubleSha256(payload).slice(0, 4);

    for (let i = 0; i < 4; i++) {
        if (checksum[i] !== expectedChecksum[i]) {
            throw new Error('Invalid address checksum');
        }
    }

    return {
        version: decoded[0],
        hash: decoded.slice(1, 21)
    };
}

// Validate address format
function validateAddress(address: string, network: Network = 'testnet'): boolean {
    try {
        const decoded = decodeAddress(address);
        const expectedVersion = NETWORKS[network].pubKeyHash;
        return decoded.version === expectedVersion;
    } catch {
        return false;
    }
}

export const Address = {
    fromPublicKey: publicKeyToAddress,
    decode: decodeAddress,
    validate: validateAddress,
    NETWORKS
};
