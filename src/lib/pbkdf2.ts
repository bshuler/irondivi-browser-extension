// PBKDF2-HMAC-SHA512 implementation
// Uses Web Crypto API for secure key derivation

// PBKDF2 implementation
async function pbkdf2(password: string, salt: string, iterations: number, keyLen: number): Promise<Uint8Array> {
    // Use Web Crypto API for PBKDF2
    const enc = new TextEncoder();
    const keyMaterial = await crypto.subtle.importKey(
        'raw',
        enc.encode(password),
        'PBKDF2',
        false,
        ['deriveBits']
    );

    const derivedBits = await crypto.subtle.deriveBits(
        {
            name: 'PBKDF2',
            salt: enc.encode(salt),
            iterations: iterations,
            hash: 'SHA-512'
        },
        keyMaterial,
        keyLen * 8
    );

    return new Uint8Array(derivedBits);
}

// Derive seed from mnemonic
async function mnemonicToSeed(mnemonic: string, passphrase: string = ''): Promise<Uint8Array> {
    const password = mnemonic.normalize('NFKD');
    const salt = 'mnemonic' + passphrase.normalize('NFKD');
    return await pbkdf2(password, salt, 2048, 64);
}

export const PBKDF2 = { mnemonicToSeed };
