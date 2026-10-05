import { HDKey } from './hdkey';
import { Address } from './address';
import { NETWORKS, type NetworkType } from '../shared/constants';
import type { AccountAddress } from '../shared/storage';

/**
 * Derive addresses from a seed
 * Wipes derived keys after use for security
 */
export async function deriveAddresses(
  seed: Uint8Array,
  network: NetworkType,
  startIndex: number,
  count: number
): Promise<AccountAddress[]> {
  const coinType = NETWORKS[network].coinType;
  const addresses: AccountAddress[] = [];
  const hdkey = await HDKey.fromMasterSeed(seed);

  try {
    for (let i = 0; i < count; i++) {
      const index = startIndex + i;
      const path = `m/44'/${coinType}'/0'/0/${index}`;
      const derived = await hdkey.derive(path);

      try {
        if (!derived.publicKey) {
          throw new Error('Failed to derive public key');
        }
        const address = Address.fromPublicKey(derived.publicKey, network);
        addresses.push({ index, address, path });
      } finally {
        derived.wipe();
      }
    }
  } finally {
    hdkey.wipe();
  }

  return addresses;
}
