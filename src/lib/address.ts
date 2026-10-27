// IronDivi Address Generation
// Converts public keys to human-readable addresses

import { Base58 } from './base58';
import { Hash } from './hash';
import { RIPEMD160 } from './ripemd160';

import { NETWORKS as CHAIN_PARAMS } from '../shared/constants';

// Address version bytes, taken from the shared network definitions
const NETWORKS = {
    mainnet: {
        pubKeyHash: CHAIN_PARAMS.mainnet.addressPrefix,
        scriptHash: CHAIN_PARAMS.mainnet.scriptPrefix
    },
    testnet: {
        pubKeyHash: CHAIN_PARAMS.testnet.addressPrefix,
        scriptHash: CHAIN_PARAMS.testnet.scriptPrefix
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

// Whether the wallet can pay this address on this network: a key address
// (P2PKH) or a script address (P2SH), such as DNSDivi's registration address
function validateAddress(address: string, network: Network = 'testnet'): boolean {
    try {
        const { version } = decodeAddress(address);
        return version === NETWORKS[network].pubKeyHash || version === NETWORKS[network].scriptHash;
    } catch {
        return false;
    }
}

// The output script that pays an address: P2PKH for a key address, P2SH for a script address
function outputScript(address: string, network: Network): string {
    const { version, hash } = decodeAddress(address);
    const h = Array.from(hash, b => b.toString(16).padStart(2, '0')).join('');
    if (version === NETWORKS[network].pubKeyHash) return '76a914' + h + '88ac';
    if (version === NETWORKS[network].scriptHash) return 'a914' + h + '87';
    throw new Error('Address is not on this network');
}

export const Address = {
    outputScript,
    fromPublicKey: publicKeyToAddress,
    decode: decodeAddress,
    validate: validateAddress,
    NETWORKS
};
