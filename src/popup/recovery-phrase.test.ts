import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';

// Regression tests for the security review's L6: the recovery phrase could be
// copied to the clipboard, where other apps and clipboard history keep it

const read = (file: string) => readFileSync(new URL(`./${file}`, import.meta.url), 'utf8')
  .replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '').replace(/<!--[\s\S]*?-->/g, '');

describe('L6 the recovery phrase cannot be copied', () => {
  it('the phrase modal has no copy button', () => {
    const html = read('popup.html');
    const modal = html.slice(html.indexOf('id="mnemonic-modal"'), html.indexOf('id="password-modal"'));
    expect(modal).not.toMatch(/copy/i);
  });

  it('the only text put on the clipboard is the address', () => {
    for (const file of ['modals.ts', 'account-ui.ts', 'settings-ui.ts', 'popup.ts', 'send-ui.ts', 'contacts-ui.ts', 'signing-request-ui.ts']) {
      expect(read(file), file).not.toMatch(/clipboard\s*\.\s*write/);
    }
    expect(read('wallet-ui.ts').match(/clipboard\s*\.\s*write\w*\(([^)]*)\)/g)).toEqual(['clipboard.writeText(primaryAddress)']);
  });
});
