import { generateId } from '../shared/crypto-utils';
import { getAddressBook, saveAddressBook, type Contact } from '../shared/storage';
import type { NetworkType } from '../shared/constants';

export class AddressBook {
  /**
   * Add a new contact
   */
  async addContact(
    name: string,
    address: string,
    network: NetworkType,
    notes?: string
  ): Promise<Contact> {
    const contacts = await getAddressBook();

    // Check for duplicate address
    const existing = contacts.find(c => c.address === address && c.network === network);
    if (existing) {
      throw new Error('Contact with this address already exists');
    }

    const contact: Contact = {
      id: generateId(),
      name,
      address,
      network,
      notes,
      createdAt: Date.now(),
    };

    contacts.push(contact);
    await saveAddressBook(contacts);

    return contact;
  }

  /**
   * Update an existing contact
   */
  async updateContact(
    contactId: string,
    updates: Partial<Pick<Contact, 'name' | 'notes'>>
  ): Promise<Contact> {
    const contacts = await getAddressBook();
    const contact = contacts.find(c => c.id === contactId);

    if (!contact) {
      throw new Error('Contact not found');
    }

    if (updates.name !== undefined) contact.name = updates.name;
    if (updates.notes !== undefined) contact.notes = updates.notes;

    await saveAddressBook(contacts);
    return contact;
  }

  /**
   * Delete a contact
   */
  async deleteContact(contactId: string): Promise<void> {
    const contacts = await getAddressBook();
    const filtered = contacts.filter(c => c.id !== contactId);

    if (filtered.length === contacts.length) {
      throw new Error('Contact not found');
    }

    await saveAddressBook(filtered);
  }

  /**
   * List all contacts, optionally filtered by network
   */
  async listContacts(network?: NetworkType): Promise<Contact[]> {
    const contacts = await getAddressBook();

    if (network) {
      return contacts.filter(c => c.network === network);
    }

    return contacts;
  }

  /**
   * Find a contact by address
   */
  async findByAddress(address: string): Promise<Contact | null> {
    const contacts = await getAddressBook();
    return contacts.find(c => c.address === address) || null;
  }

  /**
   * Get recently used contacts
   */
  async getRecentContacts(limit: number = 5): Promise<Contact[]> {
    const contacts = await getAddressBook();

    return contacts
      .filter(c => c.lastUsed)
      .sort((a, b) => (b.lastUsed || 0) - (a.lastUsed || 0))
      .slice(0, limit);
  }

  /**
   * Mark a contact as recently used
   */
  async markAsUsed(contactId: string): Promise<void> {
    const contacts = await getAddressBook();
    const contact = contacts.find(c => c.id === contactId);

    if (contact) {
      contact.lastUsed = Date.now();
      await saveAddressBook(contacts);
    }
  }

  /**
   * Search contacts by name
   */
  async searchContacts(query: string, network?: NetworkType): Promise<Contact[]> {
    const contacts = await this.listContacts(network);
    const lowerQuery = query.toLowerCase();

    return contacts.filter(c =>
      c.name.toLowerCase().includes(lowerQuery) ||
      c.address.toLowerCase().includes(lowerQuery) ||
      (c.notes && c.notes.toLowerCase().includes(lowerQuery))
    );
  }

  /**
   * Get contact name for an address, or return truncated address if not found
   */
  async getDisplayName(address: string): Promise<string> {
    const contact = await this.findByAddress(address);
    if (contact) {
      return contact.name;
    }
    // Return truncated address
    return `${address.slice(0, 8)}...${address.slice(-6)}`;
  }

  /**
   * Import contacts from JSON
   */
  async importContacts(contactsJson: Contact[]): Promise<{ imported: number; skipped: number }> {
    const existing = await getAddressBook();
    const existingAddresses = new Set(existing.map(c => `${c.address}:${c.network}`));

    let imported = 0;
    let skipped = 0;

    for (const contact of contactsJson) {
      const key = `${contact.address}:${contact.network}`;
      if (existingAddresses.has(key)) {
        skipped++;
        continue;
      }

      existing.push({
        ...contact,
        id: generateId(), // Generate new ID
        createdAt: Date.now(),
      });
      imported++;
    }

    await saveAddressBook(existing);
    return { imported, skipped };
  }

  /**
   * Export contacts to JSON
   */
  async exportContacts(network?: NetworkType): Promise<Contact[]> {
    return this.listContacts(network);
  }
}

// Singleton instance
export const addressBook = new AddressBook();
