/**
 * Contacts UI - address book management
 */

import { elements } from './elements';
import { state } from './state';
import { formatAddress, showLoading, hideLoading, showToast, showView, hideView } from './ui-state';
import { sendMessage } from './message-api';
import { showConfirmModal } from './modals';
import { MSG } from '../shared/constants';
import { Contact } from './types';

// ============================================================
// Data Loading
// ============================================================

/**
 * Load contacts from background
 */
export async function loadContacts(): Promise<void> {
  try {
    const response = await sendMessage<{ contacts: Contact[] }>(MSG.GET_CONTACTS);
    state.contacts = response.contacts || [];
    updateContactList();
  } catch (error) {
    console.error('Failed to load contacts');
    showToast('Failed to load contacts. Please try again.', 'error');
  }
}

// ============================================================
// Display Updates
// ============================================================

/**
 * Update the contact list display
 */
export function updateContactList(filter = ''): void {
  const filtered = filter
    ? state.contacts.filter(c =>
        c.name.toLowerCase().includes(filter.toLowerCase()) ||
        c.address.toLowerCase().includes(filter.toLowerCase())
      )
    : state.contacts;

  if (filtered.length === 0) {
    elements.contactList.innerHTML = '';
    const emptyState = document.createElement('div');
    emptyState.className = 'empty-state';
    emptyState.textContent = 'No contacts found';
    elements.contactList.appendChild(emptyState);
    return;
  }

  elements.contactList.innerHTML = '';
  filtered.forEach(contact => {
    const item = document.createElement('div');
    item.className = 'contact-item';

    const avatar = contact.name.charAt(0).toUpperCase();

    // contact-avatar
    const avatarEl = document.createElement('div');
    avatarEl.className = 'contact-avatar';
    avatarEl.textContent = avatar;
    avatarEl.addEventListener('click', () => {
      const sendToInput = document.getElementById('send-to') as HTMLInputElement;
      sendToInput.value = contact.address;
      showView(elements.viewSend);
    });

    // contact-details
    const mainArea = document.createElement('div');
    mainArea.className = 'contact-details';
    const nameEl = document.createElement('div');
    nameEl.className = 'contact-name';
    nameEl.textContent = contact.name;
    const addressEl = document.createElement('div');
    addressEl.className = 'contact-address';
    addressEl.textContent = contact.address;
    mainArea.appendChild(nameEl);
    mainArea.appendChild(addressEl);
    mainArea.addEventListener('click', () => {
      const sendToInput = document.getElementById('send-to') as HTMLInputElement;
      sendToInput.value = contact.address;
      showView(elements.viewSend);
    });

    // contact-actions
    const actionsEl = document.createElement('div');
    actionsEl.className = 'contact-actions';

    const editBtn = document.createElement('button');
    editBtn.className = 'contact-action-btn edit';
    editBtn.title = 'Edit contact';
    editBtn.dataset.id = contact.id;
    editBtn.textContent = '\u270E';
    editBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      openEditContact(contact);
    });

    const deleteBtn = document.createElement('button');
    deleteBtn.className = 'contact-action-btn delete';
    deleteBtn.title = 'Delete contact';
    deleteBtn.dataset.id = contact.id;
    deleteBtn.textContent = '\u2715';
    deleteBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      deleteContact(contact.id, contact.name);
    });

    actionsEl.appendChild(editBtn);
    actionsEl.appendChild(deleteBtn);

    item.appendChild(avatarEl);
    item.appendChild(mainArea);
    item.appendChild(actionsEl);

    elements.contactList.appendChild(item);
  });
}

// ============================================================
// Contact Actions
// ============================================================

/**
 * Add a new contact
 */
export async function addContact(name: string, address: string, notes?: string): Promise<void> {
  try {
    showLoading('Adding contact...');
    await sendMessage(MSG.ADD_CONTACT, { name, address, notes, network: state.settings.network });
    showToast(`Contact added: ${name}`, 'success');
    await loadContacts();
    hideView();
  } catch (error: unknown) {
    const errorMessage = error instanceof Error ? error.message : 'Failed to add contact';
    showToast(errorMessage, 'error');
  } finally {
    hideLoading();
  }
}

/**
 * Update an existing contact
 */
export async function updateContact(id: string, name: string, address: string, notes?: string): Promise<void> {
  try {
    showLoading('Updating contact...');
    await sendMessage(MSG.UPDATE_CONTACT, { id, name, address, notes });
    showToast(`Contact updated: ${name}`, 'success');
    state.editingContactId = null;
    await loadContacts();
    hideView();
  } catch (error: unknown) {
    const errorMessage = error instanceof Error ? error.message : 'Failed to update contact';
    showToast(errorMessage, 'error');
  } finally {
    hideLoading();
  }
}

/**
 * Delete a contact (with confirmation)
 */
export async function deleteContact(id: string, name: string): Promise<void> {
  const confirmed = await showConfirmModal(
    'Delete Contact',
    `Are you sure you want to delete "${name}"? This cannot be undone.`
  );
  if (!confirmed) return;

  try {
    showLoading('Deleting contact...');
    await sendMessage(MSG.DELETE_CONTACT, { contactId: id });
    showToast(`Contact deleted: ${name}`, 'success');
    await loadContacts();
  } catch (error: unknown) {
    const errorMessage = error instanceof Error ? error.message : 'Failed to delete contact';
    showToast(errorMessage, 'error');
  } finally {
    hideLoading();
  }
}

/**
 * Open contact form in edit mode
 */
export function openEditContact(contact: Contact): void {
  state.editingContactId = contact.id;

  const titleEl = document.getElementById('add-contact-title') as HTMLHeadingElement;
  const nameInput = document.getElementById('contact-name') as HTMLInputElement;
  const addressInput = document.getElementById('contact-address') as HTMLInputElement;
  const notesInput = document.getElementById('contact-notes') as HTMLTextAreaElement;
  const saveBtn = document.getElementById('save-contact-btn') as HTMLButtonElement;
  const cancelBtn = document.getElementById('cancel-edit-contact-btn') as HTMLButtonElement;

  titleEl.textContent = 'Edit Contact';
  nameInput.value = contact.name;
  addressInput.value = contact.address;
  notesInput.value = contact.notes || '';
  saveBtn.textContent = 'Update Contact';
  cancelBtn.classList.remove('hidden');

  showView(elements.viewAddContact);
}

/**
 * Reset contact form to add mode
 */
export function resetContactForm(): void {
  state.editingContactId = null;

  const titleEl = document.getElementById('add-contact-title') as HTMLHeadingElement;
  const nameInput = document.getElementById('contact-name') as HTMLInputElement;
  const addressInput = document.getElementById('contact-address') as HTMLInputElement;
  const notesInput = document.getElementById('contact-notes') as HTMLTextAreaElement;
  const saveBtn = document.getElementById('save-contact-btn') as HTMLButtonElement;
  const cancelBtn = document.getElementById('cancel-edit-contact-btn') as HTMLButtonElement;

  titleEl.textContent = 'Add Contact';
  nameInput.value = '';
  addressInput.value = '';
  notesInput.value = '';
  saveBtn.textContent = 'Save Contact';
  cancelBtn.classList.add('hidden');
}

// ============================================================
// Form Handlers
// ============================================================

/**
 * Handle save contact form submission
 */
async function handleSaveContact(): Promise<void> {
  const nameInput = document.getElementById('contact-name') as HTMLInputElement;
  const addressInput = document.getElementById('contact-address') as HTMLInputElement;
  const notesInput = document.getElementById('contact-notes') as HTMLTextAreaElement;

  const name = nameInput.value.trim();
  const address = addressInput.value.trim();
  const notes = notesInput.value.trim();

  if (!name || !address) {
    showToast('Please enter name and address', 'error');
    return;
  }

  // Validate address before saving
  try {
    const validationResult = await sendMessage<{ isValid: boolean }>(MSG.VALIDATE_ADDRESS, { address });
    if (!validationResult.isValid) {
      showToast('Invalid address', 'error');
      return;
    }
  } catch (error) {
    showToast('Failed to validate address', 'error');
    return;
  }

  if (state.editingContactId) {
    updateContact(state.editingContactId, name, address, notes || undefined);
  } else {
    addContact(name, address, notes || undefined);
  }

  // Clear inputs
  nameInput.value = '';
  addressInput.value = '';
  notesInput.value = '';
}

/**
 * Setup contacts UI event listeners
 */
export function setupContactsUIHandlers(): void {
  // Contact search
  elements.contactSearch.addEventListener('input', (e) => {
    const filter = (e.target as HTMLInputElement).value;
    updateContactList(filter);
  });

  // Add contact button
  elements.addContactBtn.addEventListener('click', () => {
    resetContactForm();
    showView(elements.viewAddContact);
  });

  // Add/edit contact view back button
  document.getElementById('add-contact-back-btn')?.addEventListener('click', () => {
    resetContactForm();
    hideView();
  });

  // Cancel edit button
  document.getElementById('cancel-edit-contact-btn')?.addEventListener('click', () => {
    resetContactForm();
    hideView();
  });

  // Save contact
  document.getElementById('save-contact-btn')?.addEventListener('click', handleSaveContact);
}
