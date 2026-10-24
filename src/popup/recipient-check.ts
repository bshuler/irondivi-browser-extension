/**
 * What the send confirmation says about the recipient.
 *
 * Clipboard malware swaps in an address that starts and ends like the one
 * the user meant, so the confirm screen shows the whole address, and says
 * whether it is one of the user's saved contacts. Contacts are kept on this
 * device; transaction history comes from the network's server, so it is not
 * used to vouch for an address.
 */

export interface KnownContact {
  name: string;
  address: string;
}

export type RecipientCheck =
  | { kind: 'own' }
  | { kind: 'contact'; name: string }
  | { kind: 'lookalike'; name: string } // starts and ends like a contact, but is not it
  | { kind: 'new' };

// How many characters at each end make two addresses look alike at a glance
const LOOKALIKE_ENDS = 4;

/**
 * The address in groups of four, so it can be read and compared in pieces
 */
export function chunkAddress(address: string, size = 4): string[] {
  const chunks: string[] = [];
  for (let i = 0; i < address.length; i += size) chunks.push(address.slice(i, i + size));
  return chunks;
}

export function checkRecipient(to: string, contacts: KnownContact[], ownAddresses: string[]): RecipientCheck {
  if (ownAddresses.includes(to)) return { kind: 'own' };
  const contact = contacts.find(c => c.address === to);
  if (contact) return { kind: 'contact', name: contact.name };
  const similar = contacts.find(c =>
    c.address.slice(0, LOOKALIKE_ENDS) === to.slice(0, LOOKALIKE_ENDS) &&
    c.address.slice(-LOOKALIKE_ENDS) === to.slice(-LOOKALIKE_ENDS));
  if (similar) return { kind: 'lookalike', name: similar.name };
  return { kind: 'new' };
}

export function recipientNote(check: RecipientCheck): { text: string; level: 'ok' | 'warn' | 'danger' } {
  switch (check.kind) {
    case 'own':
      return { text: 'This is one of your own addresses.', level: 'ok' };
    case 'contact':
      return { text: `Saved contact: ${check.name}`, level: 'ok' };
    case 'lookalike':
      return {
        text: `This is NOT your contact ${check.name}. It starts and ends the same way but the middle is different. If you pasted it, your clipboard may have been changed.`,
        level: 'danger',
      };
    case 'new':
      return { text: 'This address is not in your contacts. Check every group against where you copied it from.', level: 'warn' };
  }
}
