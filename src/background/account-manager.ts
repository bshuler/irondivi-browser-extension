import { generateId } from '../shared/crypto-utils';
import {
  getAccounts, saveAccounts,
  saveSecret, getDecryptedSecret, deleteSecret,
  getSelectedAccountId, setSelectedAccountId,
  type Account, type AccountAddress
} from '../shared/storage';
import { Mnemonic, type WordlistLanguage } from '../lib/mnemonic';
import type { NetworkType } from '../shared/constants';
import { deriveAddresses } from '../lib/derivation';

const GAP_LIMIT = 20;

export class AccountManager {
  /**
   * Create a new account with a generated mnemonic
   */
  async createAccount(
    name: string,
    password: string,
    network: NetworkType = 'testnet',
    wordCount: number = 12,
    language: WordlistLanguage = 'english'
  ): Promise<Account> {
    const mnemonic = await Mnemonic.generate(wordCount, language);
    return this.importAccount(name, mnemonic, password, network);
  }

  /**
   * Import an existing account from a mnemonic phrase
   */
  async importAccount(
    name: string,
    mnemonic: string,
    password: string,
    network: NetworkType = 'testnet'
  ): Promise<Account> {
    // Validate mnemonic
    if (!Mnemonic.validate(mnemonic)) {
      throw new Error('Invalid mnemonic phrase');
    }

    const id = generateId();
    const now = Date.now();

    // Derive initial addresses
    const seed = await Mnemonic.toSeed(mnemonic);
    const addresses = await deriveAddresses(seed, network, 0, 1);

    const account: Account = {
      id,
      name,
      createdAt: now,
      network,
      addresses,
      addressIndex: 1,
    };

    // Save account metadata (unencrypted)
    const accounts = await getAccounts();
    accounts.push(account);
    await saveAccounts(accounts);

    // Save mnemonic (encrypted with password)
    await saveSecret(id, mnemonic, password);

    // Select this account if it's the first one
    if (accounts.length === 1) {
      await setSelectedAccountId(id);
    }

    return account;
  }

  /**
   * Delete an account (requires password verification)
   */
  async deleteAccount(accountId: string, password: string): Promise<void> {
    // Verify password by attempting decryption
    await getDecryptedSecret(accountId, password);

    // Remove from accounts list
    const accounts = await getAccounts();
    const filtered = accounts.filter(a => a.id !== accountId);
    await saveAccounts(filtered);

    // Remove encrypted secret
    await deleteSecret(accountId);

    // If this was selected account, select another
    const selectedId = await getSelectedAccountId();
    if (selectedId === accountId && filtered.length > 0) {
      await setSelectedAccountId(filtered[0].id);
    }
  }

  /**
   * Rename an account (no password needed)
   */
  async renameAccount(accountId: string, newName: string): Promise<void> {
    const accounts = await getAccounts();
    const account = accounts.find(a => a.id === accountId);
    if (!account) throw new Error('Account not found');

    account.name = newName;
    await saveAccounts(accounts);
  }

  /**
   * List all accounts (metadata only, no secrets)
   */
  async listAccounts(): Promise<Account[]> {
    return getAccounts();
  }

  /**
   * Get currently selected account
   */
  async getSelectedAccount(): Promise<Account | null> {
    const selectedId = await getSelectedAccountId();
    if (!selectedId) return null;

    const accounts = await getAccounts();
    return accounts.find(a => a.id === selectedId) || null;
  }

  /**
   * Select an account as active
   */
  async selectAccount(accountId: string): Promise<void> {
    const accounts = await getAccounts();
    if (!accounts.find(a => a.id === accountId)) {
      throw new Error('Account not found');
    }
    await setSelectedAccountId(accountId);
  }

  /**
   * Export mnemonic (requires password)
   */
  async exportMnemonic(accountId: string, password: string): Promise<string> {
    return getDecryptedSecret(accountId, password);
  }

  /**
   * Discover more addresses using gap limit scanning
   */
  async discoverAddresses(
    accountId: string,
    password: string,
    checkHasTransactions: (address: string) => Promise<boolean>
  ): Promise<AccountAddress[]> {
    const accounts = await getAccounts();
    const account = accounts.find(a => a.id === accountId);
    if (!account) throw new Error('Account not found');

    const mnemonic = await getDecryptedSecret(accountId, password);
    const seed = await Mnemonic.toSeed(mnemonic);

    let emptyCount = 0;
    let currentIndex = account.addressIndex;
    const newAddresses: AccountAddress[] = [];

    while (emptyCount < GAP_LIMIT) {
      const [addr] = await deriveAddresses(seed, account.network, currentIndex, 1);
      const hasTransactions = await checkHasTransactions(addr.address);

      newAddresses.push(addr);

      if (hasTransactions) {
        emptyCount = 0;
      } else {
        emptyCount++;
      }
      currentIndex++;
    }

    // Update account with new addresses
    account.addresses = [...account.addresses, ...newAddresses];
    account.addressIndex = currentIndex;
    await saveAccounts(accounts);

    return account.addresses;
  }

  /**
   * Add a new receiving address
   */
  async generateNewAddress(accountId: string, password: string): Promise<AccountAddress> {
    const accounts = await getAccounts();
    const account = accounts.find(a => a.id === accountId);
    if (!account) throw new Error('Account not found');

    const mnemonic = await getDecryptedSecret(accountId, password);
    const seed = await Mnemonic.toSeed(mnemonic);

    const [newAddr] = await deriveAddresses(seed, account.network, account.addressIndex, 1);

    account.addresses.push(newAddr);
    account.addressIndex++;
    await saveAccounts(accounts);

    return newAddr;
  }

}

// Singleton instance
export const accountManager = new AccountManager();
