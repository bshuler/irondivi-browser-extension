import { generateId, secureWipe } from '../shared/crypto-utils';
import {
  getAccounts, saveAccounts,
  saveSecret, deleteSecret,
  getSelectedAccountId, setSelectedAccountId, getSettings,
  type Account, type AccountAddress, type NetworkAddresses
} from '../shared/storage';
import { Mnemonic, type WordlistLanguage } from '../lib/mnemonic';
import { NETWORKS, type NetworkType } from '../shared/constants';
import { deriveAddresses } from '../lib/derivation';
import { unlockSecret } from './unlock-limit';

// Run fn with the seed for a phrase, then wipe the seed
async function withSeed<T>(mnemonic: string, fn: (seed: Uint8Array) => Promise<T>): Promise<T> {
  const seed = await Mnemonic.toSeed(mnemonic);
  try {
    return await fn(seed);
  } finally {
    secureWipe(seed);
  }
}

const GAP_LIMIT = 20;

/**
 * An account's addresses on a network. A 0.0.1 account only has addresses
 * for the network it was created on; on any other it has none yet.
 */
function addressesOn(account: Account, network: NetworkType): NetworkAddresses {
  const entry = account.networks?.[network];
  if (entry) return entry;
  if (account.network === network) {
    return { addresses: account.addresses, addressIndex: account.addressIndex };
  }
  return { addresses: [], addressIndex: 0 };
}

function setAddressesOn(account: Account, network: NetworkType, entry: NetworkAddresses): void {
  account.networks = { ...account.networks, [network]: entry };
  if (account.network === network) {
    account.addresses = entry.addresses;
    account.addressIndex = entry.addressIndex;
  }
}

/**
 * The account as seen on one network: `network`, `addresses` and
 * `addressIndex` are that network's. Never save a view back to storage.
 */
function viewOn(account: Account, network: NetworkType): Account {
  const { addresses, addressIndex } = addressesOn(account, network);
  return { ...account, network, addresses, addressIndex };
}

async function currentNetwork(): Promise<NetworkType> {
  return (await getSettings()).network;
}

// The popup asks for at least this many characters too, but the worker is the
// one that encrypts the phrase, so it checks for itself
export const MIN_PASSWORD_LENGTH = 8;

export class AccountManager {
  /**
   * Create a new account with a generated mnemonic
   */
  async createAccount(
    name: string,
    password: string,
    network?: NetworkType,
    wordCount: number = 12,
    language: WordlistLanguage = 'english'
  ): Promise<Account> {
    const mnemonic = await Mnemonic.generate(wordCount, language);
    return this.importAccount(name, mnemonic, password, network);
  }

  /**
   * Import an existing account from a mnemonic phrase. It gets its first
   * address on every network; `network` (default: the current one) is the
   * network it is recorded as created on.
   */
  async importAccount(
    name: string,
    mnemonic: string,
    password: string,
    network?: NetworkType
  ): Promise<Account> {
    if (typeof password !== 'string' || password.length < MIN_PASSWORD_LENGTH) {
      throw new Error(`Password must be at least ${MIN_PASSWORD_LENGTH} characters`);
    }
    network ??= await currentNetwork();
    if (typeof mnemonic !== 'string') {
      throw new Error('Invalid mnemonic phrase');
    }
    mnemonic = Mnemonic.normalize(mnemonic);
    if (!Mnemonic.validate(mnemonic)) {
      throw new Error('Invalid mnemonic phrase');
    }

    const id = generateId();
    const now = Date.now();

    // Derive the first address on each network
    const networks: Partial<Record<NetworkType, NetworkAddresses>> = {};
    await withSeed(mnemonic, async seed => {
      for (const net of Object.keys(NETWORKS) as NetworkType[]) {
        networks[net] = { addresses: await deriveAddresses(seed, net, 0, 1), addressIndex: 1 };
      }
    });

    const account: Account = {
      id,
      name,
      createdAt: now,
      network,
      addresses: networks[network]!.addresses,
      addressIndex: 1,
      networks,
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

    return viewOn(account, await currentNetwork());
  }

  /**
   * Delete an account (requires password verification)
   */
  async deleteAccount(accountId: string, password: string): Promise<void> {
    // Verify password by attempting decryption
    await unlockSecret(accountId, password);

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
   * List all accounts (metadata only, no secrets), as seen on the current network
   */
  async listAccounts(): Promise<Account[]> {
    const network = await currentNetwork();
    return (await getAccounts()).map(a => viewOn(a, network));
  }

  /**
   * An account as seen on a network (default: the current one)
   */
  async getAccount(accountId: string, network?: NetworkType): Promise<Account | null> {
    const account = (await getAccounts()).find(a => a.id === accountId);
    if (!account) return null;
    return viewOn(account, network ?? await currentNetwork());
  }

  /**
   * Get currently selected account, as seen on the current network
   */
  async getSelectedAccount(): Promise<Account | null> {
    const selectedId = await getSelectedAccountId();
    if (!selectedId) return null;
    return this.getAccount(selectedId);
  }

  /**
   * Give an account its first address on the current network, if it has
   * none there yet (an account made by 0.0.1 only has its own network's).
   */
  async setUpNetwork(accountId: string, password: string): Promise<Account> {
    const network = await currentNetwork();
    const accounts = await getAccounts();
    const account = accounts.find(a => a.id === accountId);
    if (!account) throw new Error('Account not found');

    if (addressesOn(account, network).addresses.length === 0) {
      const mnemonic = await unlockSecret(accountId, password);
      setAddressesOn(account, network, {
        addresses: await withSeed(mnemonic, seed => deriveAddresses(seed, network, 0, 1)),
        addressIndex: 1,
      });
      await saveAccounts(accounts);
    }
    return viewOn(account, network);
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
    return unlockSecret(accountId, password);
  }

  /**
   * Discover more addresses on the current network using gap limit scanning
   */
  async discoverAddresses(
    accountId: string,
    password: string,
    checkHasTransactions: (address: string) => Promise<boolean>
  ): Promise<AccountAddress[]> {
    const accounts = await getAccounts();
    const account = accounts.find(a => a.id === accountId);
    if (!account) throw new Error('Account not found');

    const network = await currentNetwork();
    const entry = addressesOn(account, network);
    const mnemonic = await unlockSecret(accountId, password);
    let emptyCount = 0;
    let currentIndex = entry.addressIndex;
    const newAddresses: AccountAddress[] = [];

    await withSeed(mnemonic, async seed => {
      while (emptyCount < GAP_LIMIT) {
        const [addr] = await deriveAddresses(seed, network, currentIndex, 1);
        const hasTransactions = await checkHasTransactions(addr.address);

        newAddresses.push(addr);

        if (hasTransactions) {
          emptyCount = 0;
        } else {
          emptyCount++;
        }
        currentIndex++;
      }
    });

    // Update account with new addresses
    const addresses = [...entry.addresses, ...newAddresses];
    setAddressesOn(account, network, { addresses, addressIndex: currentIndex });
    await saveAccounts(accounts);

    return addresses;
  }

  /**
   * Add a new receiving address on the current network
   */
  async generateNewAddress(accountId: string, password: string): Promise<AccountAddress> {
    const accounts = await getAccounts();
    const account = accounts.find(a => a.id === accountId);
    if (!account) throw new Error('Account not found');

    const network = await currentNetwork();
    const entry = addressesOn(account, network);
    const mnemonic = await unlockSecret(accountId, password);
    const [newAddr] = await withSeed(mnemonic, seed => deriveAddresses(seed, network, entry.addressIndex, 1));

    setAddressesOn(account, network, {
      addresses: [...entry.addresses, newAddr],
      addressIndex: entry.addressIndex + 1,
    });
    await saveAccounts(accounts);

    return newAddr;
  }

}

// Singleton instance
export const accountManager = new AccountManager();
