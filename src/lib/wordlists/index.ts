// BIP-39 Wordlists
// Exports all supported language wordlists

import { WORDLIST_ENGLISH } from './english';
import { WORDLIST_JAPANESE } from './japanese';
import { WORDLIST_KOREAN } from './korean';
import { WORDLIST_SPANISH } from './spanish';
import { WORDLIST_CHINESE_SIMPLIFIED } from './chinese_simplified';
import { WORDLIST_CHINESE_TRADITIONAL } from './chinese_traditional';
import { WORDLIST_FRENCH } from './french';
import { WORDLIST_ITALIAN } from './italian';
import { WORDLIST_CZECH } from './czech';
import { WORDLIST_PORTUGUESE } from './portuguese';

export {
  WORDLIST_ENGLISH,
  WORDLIST_JAPANESE,
  WORDLIST_KOREAN,
  WORDLIST_SPANISH,
  WORDLIST_CHINESE_SIMPLIFIED,
  WORDLIST_CHINESE_TRADITIONAL,
  WORDLIST_FRENCH,
  WORDLIST_ITALIAN,
  WORDLIST_CZECH,
  WORDLIST_PORTUGUESE
};

export const WORDLISTS: Record<string, string[]> = {
  english: WORDLIST_ENGLISH,
  japanese: WORDLIST_JAPANESE,
  korean: WORDLIST_KOREAN,
  spanish: WORDLIST_SPANISH,
  chinese_simplified: WORDLIST_CHINESE_SIMPLIFIED,
  chinese_traditional: WORDLIST_CHINESE_TRADITIONAL,
  french: WORDLIST_FRENCH,
  italian: WORDLIST_ITALIAN,
  czech: WORDLIST_CZECH,
  portuguese: WORDLIST_PORTUGUESE
};
