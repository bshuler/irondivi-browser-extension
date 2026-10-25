// BIP39 Mnemonic implementation
// Generates human-readable recovery phrases from random entropy
// Standard used by most cryptocurrency wallets for backup/recovery
//
// Phrases and checksums are @scure/bip39's, with its wordlists (NFKD form,
// the form a phrase is compared and hashed in). The seed is PBKDF2 from the
// browser's Web Crypto.

import { entropyToMnemonic, validateMnemonic as scureValidate } from '@scure/bip39';
import { wordlist as czech } from '@scure/bip39/wordlists/czech.js';
import { wordlist as english } from '@scure/bip39/wordlists/english.js';
import { wordlist as french } from '@scure/bip39/wordlists/french.js';
import { wordlist as italian } from '@scure/bip39/wordlists/italian.js';
import { wordlist as japanese } from '@scure/bip39/wordlists/japanese.js';
import { wordlist as korean } from '@scure/bip39/wordlists/korean.js';
import { wordlist as portuguese } from '@scure/bip39/wordlists/portuguese.js';
import { wordlist as chineseSimplified } from '@scure/bip39/wordlists/simplified-chinese.js';
import { wordlist as spanish } from '@scure/bip39/wordlists/spanish.js';
import { wordlist as chineseTraditional } from '@scure/bip39/wordlists/traditional-chinese.js';
import { secureWipe } from '../shared/crypto-utils';
import { PBKDF2 } from './pbkdf2';

export type WordlistLanguage = 'english' | 'japanese' | 'korean' | 'spanish' |
  'chinese_simplified' | 'chinese_traditional' | 'french' | 'italian' | 'czech' | 'portuguese';

// In the order languages were checked before, so a phrase that is valid in
// two lists is still reported as the same language
const WORDLISTS: Record<WordlistLanguage, string[]> = {
    english,
    japanese,
    korean,
    spanish,
    chinese_simplified: chineseSimplified,
    chinese_traditional: chineseTraditional,
    french,
    italian,
    czech,
    portuguese,
};

// Generate new mnemonic (12 or 24 words)
async function generateMnemonic(wordCount: number = 12, language: WordlistLanguage = 'english'): Promise<string> {
    const entropy = crypto.getRandomValues(new Uint8Array(wordCount === 24 ? 32 : 16));
    try {
        // Japanese is joined with an ideographic space; the wallet uses one form
        return normalizePhrase(entropyToMnemonic(entropy, WORDLISTS[language]));
    } finally {
        secureWipe(entropy);
    }
}

// The languages whose list holds every word of the phrase
function candidates(words: string[]): WordlistLanguage[] {
    return (Object.keys(WORDLISTS) as WordlistLanguage[])
        .filter(lang => words.every(word => WORDLISTS[lang].includes(word)));
}

// Detect language from mnemonic phrase. Lists share words (the two Chinese
// lists share most of theirs), so the language is the one whose checksum
// holds; a phrase no checksum fits gets the first list that has its words.
function detectLanguage(phrase: string): WordlistLanguage | null {
    const normalized = normalizePhrase(phrase);
    const found = candidates(normalized.split(' '));
    return found.find(lang => scureValidate(normalized, WORDLISTS[lang])) ?? found[0] ?? null;
}

// Validate mnemonic
function validateMnemonic(mnemonic: string, language?: WordlistLanguage): boolean {
    // Early sanity checks
    if (!mnemonic || typeof mnemonic !== 'string') return false;

    // Max length check: 24 words, in the NFKD form Korean words take up to 12
    // characters, plus spaces
    if (mnemonic.length > 1000) return false;

    const normalized = normalizePhrase(mnemonic);
    const words = normalized.split(' ');

    // Word count must be 12 or 24
    if (words.length !== 12 && words.length !== 24) return false;

    // Individual word length sanity (no NFKD BIP39 word is longer than 12)
    if (words.some(w => w.length > 16)) return false;

    const languages = language ? [language] : candidates(words);
    return languages.some(lang => scureValidate(normalized, WORDLISTS[lang]));
}

/**
 * The canonical form of a phrase as typed or pasted: capitals, extra spaces
 * and line breaks change the seed, so import must derive from this form
 */
function normalizePhrase(phrase: string): string {
    return phrase.normalize('NFKD').trim().toLowerCase().split(/\s+/).join(' ');
}

// Convert mnemonic to seed
async function toSeed(phrase: string, passphrase: string = ''): Promise<Uint8Array> {
    return await PBKDF2.mnemonicToSeed(phrase, passphrase);
}

export const Mnemonic = {
    generate: generateMnemonic,
    validate: validateMnemonic,
    toSeed,
    normalize: normalizePhrase,
    detectLanguage
};
