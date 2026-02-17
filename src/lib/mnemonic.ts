// BIP39 Mnemonic implementation
// Generates human-readable recovery phrases from random entropy
// Standard used by most cryptocurrency wallets for backup/recovery

import { Hash } from './hash';
import { PBKDF2 } from './pbkdf2';
import { WORDLISTS } from './wordlists';

export type WordlistLanguage = 'english' | 'japanese' | 'korean' | 'spanish' |
  'chinese_simplified' | 'chinese_traditional' | 'french' | 'italian' | 'czech' | 'portuguese';

// Generate random bytes using Web Crypto API
function getRandomBytes(length: number): Uint8Array {
    return crypto.getRandomValues(new Uint8Array(length));
}

// Generate mnemonic from entropy
function entropyToMnemonic(entropy: Uint8Array, language: WordlistLanguage = 'english'): string {
    const wordlist = WORDLISTS[language];
    const entropyBits = bytesToBinary(entropy);
    const checksumBits = bytesToBinary(Hash.sha256(entropy)).slice(0, entropy.length / 4);
    const bits = entropyBits + checksumBits;

    const words: string[] = [];
    for (let i = 0; i < bits.length; i += 11) {
        const index = parseInt(bits.slice(i, i + 11), 2);
        words.push(wordlist[index]);
    }

    return words.join(' ');
}

// Generate new mnemonic (12 or 24 words)
async function generateMnemonic(wordCount: number = 12, language: WordlistLanguage = 'english'): Promise<string> {
    const entropyBytes = wordCount === 24 ? 32 : 16;
    const entropy = getRandomBytes(entropyBytes);
    return entropyToMnemonic(entropy, language);
}

// Detect language from mnemonic phrase
function detectLanguage(phrase: string): WordlistLanguage | null {
    const words = phrase.trim().toLowerCase().split(/\s+/);

    for (const [lang, wordlist] of Object.entries(WORDLISTS)) {
        if (words.every(word => wordlist.includes(word))) {
            return lang as WordlistLanguage;
        }
    }

    return null;
}

// Validate mnemonic
function validateMnemonic(mnemonic: string, language?: WordlistLanguage): boolean {
    // Early sanity checks
    if (!mnemonic || typeof mnemonic !== 'string') return false;

    // Max length check (24 words * ~10 chars + spaces = ~300 chars max)
    if (mnemonic.length > 500) return false;

    const words = mnemonic.trim().toLowerCase().split(/\s+/);

    // Word count must be 12 or 24
    if (words.length !== 12 && words.length !== 24) return false;

    // Individual word length sanity (BIP39 words are max ~8 chars)
    if (words.some(w => w.length > 10)) return false;

    const detectedLanguage = language || detectLanguage(mnemonic);
    if (!detectedLanguage) return false;

    const wordlist = WORDLISTS[detectedLanguage];

    for (const word of words) {
        if (!wordlist.includes(word)) return false;
    }

    // Verify checksum
    const bits = words.map(w => {
        const index = wordlist.indexOf(w);
        return index.toString(2).padStart(11, '0');
    }).join('');

    const entropyBits = bits.slice(0, bits.length - bits.length / 33);
    const checksumBits = bits.slice(-bits.length / 33);

    const entropy = binaryToBytes(entropyBits);
    const expectedChecksum = bytesToBinary(Hash.sha256(entropy)).slice(0, checksumBits.length);

    return checksumBits === expectedChecksum;
}

// Convert mnemonic to seed
async function toSeed(phrase: string, passphrase: string = ''): Promise<Uint8Array> {
    return await PBKDF2.mnemonicToSeed(phrase, passphrase);
}

// Helper: bytes to binary string
function bytesToBinary(bytes: Uint8Array): string {
    return Array.from(bytes).map(b => b.toString(2).padStart(8, '0')).join('');
}

// Helper: binary string to bytes
function binaryToBytes(binary: string): Uint8Array {
    const bytes = new Uint8Array(binary.length / 8);
    for (let i = 0; i < bytes.length; i++) {
        bytes[i] = parseInt(binary.slice(i * 8, (i + 1) * 8), 2);
    }
    return bytes;
}

export const Mnemonic = {
    generate: generateMnemonic,
    validate: validateMnemonic,
    toSeed,
    detectLanguage
};
