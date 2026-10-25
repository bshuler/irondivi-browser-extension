/**
 * An account's addresses on each network, and deriving them from its phrase.
 * Shared by the account manager and the records seal (records-seal.ts).
 */
import { secureWipe } from './crypto-utils';
import type { NetworkType } from './constants';
import type { Account, NetworkAddresses } from './storage';
import { Mnemonic } from '../lib/mnemonic';

// Run fn with the seed for a phrase, then wipe the seed
export async function withSeed<T>(mnemonic: string, fn: (seed: Uint8Array) => Promise<T>): Promise<T> {
  const seed = await Mnemonic.toSeed(mnemonic);
  try {
    return await fn(seed);
  } finally {
    secureWipe(seed);
  }
}

/**
 * An account's addresses on a network. A 0.0.1 account only has addresses
 * for the network it was created on; on any other it has none yet.
 */
export function addressesOn(account: Account, network: NetworkType): NetworkAddresses {
  const entry = account.networks?.[network];
  if (entry) return entry;
  if (account.network === network) {
    return { addresses: account.addresses, addressIndex: account.addressIndex };
  }
  return { addresses: [], addressIndex: 0 };
}

export function setAddressesOn(account: Account, network: NetworkType, entry: NetworkAddresses): void {
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
export function viewOn(account: Account, network: NetworkType): Account {
  const { addresses, addressIndex } = addressesOn(account, network);
  return { ...account, network, addresses, addressIndex };
}
