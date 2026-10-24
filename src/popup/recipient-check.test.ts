import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { checkRecipient, chunkAddress, recipientNote } from './recipient-check';

// Regression tests for the security review's M7: the send confirmation showed
// only the first and last 8 characters of the recipient, which a look-alike
// address swapped in by clipboard malware can match

const MINE = 'yMineAddressAAAAAAAAAAAAAAAAAAAAAA';
const ALICE = 'y9Kx2QwErTyUiOpAsDfGhJkLzXcVbNmQ7r';
// Same first and last 8 characters as ALICE, different middle
const FAKE = 'y9Kx2QwEzzzzzzzzzzzzzzzzzzbNmQ7r';
const contacts = [{ name: 'Alice', address: ALICE }];

describe('M7 the confirm screen shows the whole recipient', () => {
  it('the groups join back to exactly the address, four characters each', () => {
    const chunks = chunkAddress(ALICE);
    expect(chunks.join('')).toBe(ALICE);
    expect(chunks.slice(0, -1).every(c => c.length === 4)).toBe(true);
    expect(chunks[chunks.length - 1].length).toBeGreaterThan(0);
    expect(chunkAddress('')).toEqual([]);
  });

  it('the send flow no longer shortens the recipient', () => {
    const src = readFileSync(new URL('./send-ui.ts', import.meta.url), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
    expect(src).not.toMatch(/formatAddress\(to\)/);
    expect(src).toMatch(/showRecipient\(to, await loadRecipientContacts\(\)\);[\s\S]*showView\(elements\.viewSendConfirm\)/);
    // Text only, never markup built from the address or a contact name
    const show = src.slice(src.indexOf('function showRecipient'), src.indexOf('export async function handleSendSubmit'));
    expect(show).not.toMatch(/innerHTML/);
    const html = readFileSync(new URL('./popup.html', import.meta.url), 'utf8');
    expect(html).toMatch(/id="confirm-to" class="address-chunks"/);
    expect(html).toMatch(/id="confirm-recipient-note"/);
  });
});

describe('M7 the confirm screen says what it knows about the recipient', () => {
  it('a saved contact is named', () => {
    expect(checkRecipient(ALICE, contacts, [MINE])).toEqual({ kind: 'contact', name: 'Alice' });
    expect(recipientNote({ kind: 'contact', name: 'Alice' }).level).toBe('ok');
  });

  it('an address that starts and ends like a contact is called out as not that contact', () => {
    const check = checkRecipient(FAKE, contacts, [MINE]);
    expect(check).toEqual({ kind: 'lookalike', name: 'Alice' });
    const note = recipientNote(check);
    expect(note.level).toBe('danger');
    expect(note.text).toMatch(/NOT your contact Alice/);
  });

  it('an address that is not a contact is flagged as new', () => {
    const check = checkRecipient('yTotallyDifferentAddress000000000', contacts, [MINE]);
    expect(check).toEqual({ kind: 'new' });
    expect(recipientNote(check).level).toBe('warn');
  });

  it('the wallet\'s own address is recognised', () => {
    expect(checkRecipient(MINE, contacts, [MINE])).toEqual({ kind: 'own' });
  });

  it('with no contacts loaded every other address is new, never known', () => {
    expect(checkRecipient(ALICE, [], [MINE])).toEqual({ kind: 'new' });
  });
});
