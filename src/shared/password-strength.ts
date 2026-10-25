/**
 * How hard a wallet password is to guess. The wrong-password lockout is short
 * on purpose (EXT-23) and does nothing against a copied vault, so the
 * password is what protects the phrase. Rough on purpose: it rewards length
 * and variety, and marks the passwords people reach for first as too easy.
 */

export const MIN_PASSWORD_LENGTH = 12;

export type StrengthLevel = 0 | 1 | 2 | 3;

export interface PasswordStrength {
  level: StrengthLevel;
  // 'Too easy to guess' | 'Weak' | 'Fair' | 'Strong'
  label: string;
  // Why a password is too easy to guess or weak, if it is
  hint: string;
}

const LABELS = ['Too easy to guess', 'Weak', 'Fair', 'Strong'];

// Passwords and parts that guessing programs try first
const COMMON = [
  'password', 'passw0rd', 'qwerty', 'asdfgh', 'zxcvbn', 'letmein', 'welcome', 'iloveyou',
  'admin', 'divi', 'wallet', 'bitcoin', 'crypto', 'monkey', 'dragon', 'abc123', 'secret',
];

// Runs of the keyboard or the alphabet, forwards or backwards. The digits
// wrap, so "1234567890" is a run too.
const RUNS = ['abcdefghijklmnopqrstuvwxyz', '01234567890', 'qwertyuiop', 'asdfghjkl', 'zxcvbnm'];
const SEQUENCES = RUNS.flatMap(run => [run, [...run].reverse().join('')]);
const MIN_RUN = 5;

/** The text with every run of five or more sequence characters taken out */
function stripRuns(lower: string): string {
  let out = '';
  let i = 0;
  while (i < lower.length) {
    let n = 0;
    for (const seq of SEQUENCES) {
      let k = 1;
      while (i + k < lower.length && seq.includes(lower.slice(i, i + k + 1))) k++;
      if (seq.includes(lower[i])) n = Math.max(n, k);
    }
    if (n >= MIN_RUN) {
      i += n;
    } else {
      out += lower[i];
      i++;
    }
  }
  return out;
}

export function passwordStrength(password: string): PasswordStrength {
  const result = (level: StrengthLevel, hint = ''): PasswordStrength => ({ level, label: LABELS[level], hint });
  const chars = [...password];
  if (chars.length < MIN_PASSWORD_LENGTH) {
    return result(0, `Use at least ${MIN_PASSWORD_LENGTH} characters`);
  }
  const lower = password.toLowerCase();
  const distinct = new Set(chars).size;
  if (distinct < 5) return result(0, 'Use more different characters');
  // Strip the common words and runs; what is left is what a guesser must find
  const runless = stripRuns(lower);
  if (runless.length < 6) return result(0, 'Avoid runs like "123456" or "qwerty"');
  let rest = runless;
  for (const w of COMMON) rest = rest.split(w).join('');
  if (rest.length < 6) return result(0, 'Avoid common words like "password"');

  const classes = [/[a-z]/, /[A-Z]/, /[0-9]/, /[^a-zA-Z0-9]/].filter(r => r.test(password)).length;
  const effective = [...rest].length + (chars.length - [...rest].length) / 4;
  // Long passphrases are strong whatever their characters
  if (effective >= 20 || (effective >= 14 && classes >= 3)) return result(3);
  if (effective >= 12 && classes >= 2) return result(2, 'Longer is stronger: try four or more random words');
  return result(1, 'Add length, or mix in capitals, digits and symbols');
}
