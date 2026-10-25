import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { MIN_PASSWORD_LENGTH, passwordStrength } from './password-strength';

describe('EXT-23 password strength', () => {
  it('needs at least 12 characters', () => {
    expect(MIN_PASSWORD_LENGTH).toBe(12);
    expect(passwordStrength('Xk9!vQ2#mZ7').level).toBe(0);
  });

  it.each([
    '123456789012', 'aaaaaaaaaaaa', 'abababababab', 'password1234', 'Password!!!!',
    'qwertyuiop12', 'abcdefghijkl', 'divi-wallet-1', '210987654321',
  ])('refuses %s as too easy to guess', pw => {
    const s = passwordStrength(pw);
    expect(s.level).toBe(0);
    expect(s.hint).not.toBe('');
  });

  it.each(['harness-password-1', 'abcd-efgh-ij'])('accepts %s', pw => {
    expect(passwordStrength(pw).level).toBeGreaterThan(0);
  });

  it('rewards length and variety', () => {
    expect(passwordStrength('Xk9!vQ2#mZ7@pL4$').level).toBe(3);
    expect(passwordStrength('correct horse battery staple').level).toBe(3);
    expect(passwordStrength('gravelmonkeys').level).toBeLessThan(3);
  });
});

describe('EXT-23 the popup shows the strength as the password is typed', () => {
  const html = readFileSync('src/popup/popup.html', 'utf8');
  const ui = readFileSync('src/popup/account-ui.ts', 'utf8');
  it('has a meter under both new-password inputs', () => {
    expect(html).toMatch(/id="create-password-strength"/);
    expect(html).toMatch(/id="import-password-strength"/);
    expect(ui).toMatch(/attachStrengthMeter\('create-password', 'create-password-strength'\)/);
    expect(ui).toMatch(/attachStrengthMeter\('import-password', 'import-password-strength'\)/);
  });
  it('no longer accepts 8 characters', () => {
    expect(ui).not.toMatch(/length < 8/);
  });
});
