import { Address } from '../lib/address';
import { Transaction } from '../lib/transaction';
import { hexToBytes, bytesToHex } from '../lib/hex';
import { Signer } from '../lib/signer';
import { Hash } from '../lib/hash';
import { derivePublicKey } from '../lib/secp256k1';
import { NETWORKS, type NetworkType } from '../shared/constants';
import type { AccountAddress } from '../shared/storage';
export { deriveAddresses } from '../lib/derivation';

export interface UTXO {
  txid: string;
  vout: number;
  address: string;
  amount: number;
  scriptPubKey: string;
  confirmations: number;
}

export interface TransactionRequest {
  to: string;
  amount: number;
  fee?: number;
  fromAddresses?: string[];
}

export interface BuiltTransaction {
  hex: string;
  txid: string;
  fee: number;
  inputIndices: number[]; // Address indices used for signing
}

// DIVI min relay fee: 10,000 sat/KB. Typical tx ~300 bytes = ~3000 sat. Using 5000 sat as safe default.
const DEFAULT_FEE = 0.00005;
const DUST_THRESHOLD = 0.0000546; // 3 * fee(182 bytes) per DIVI spec
const MAX_INPUTS = 250; // Reasonable limit to prevent oversized transactions

const SATOSHIS_PER_COIN = 100000000n; // 1e8 as BigInt

/**
 * Convert DIVI to satoshis using integer math
 * Handles negative values correctly
 */
function diviToSatoshis(divi: number): bigint {
  const isNegative = divi < 0;
  const absValue = Math.abs(divi);
  const str = absValue.toFixed(8);
  const [intPart, fracPart = ''] = str.split('.');
  const intSats = BigInt(intPart) * SATOSHIS_PER_COIN;
  const fracSats = BigInt(fracPart.padEnd(8, '0'));
  const result = intSats + fracSats;
  return isNegative ? -result : result;
}

/**
 * Convert satoshis to DIVI for display
 */
function satoshisToDivi(satoshis: bigint): number {
  return Number(satoshis) / 100000000;
}

export class WalletCore {
  /**
   * Calculate total balance from UTXOs
   */
  calculateBalance(utxos: UTXO[]): number {
    const totalSatoshis = utxos.reduce((sum, utxo) => sum + diviToSatoshis(utxo.amount), 0n);
    return satoshisToDivi(totalSatoshis);
  }

  /**
   * Build an unsigned transaction
   */
  buildTransaction(
    utxos: UTXO[],
    addresses: AccountAddress[],
    request: TransactionRequest,
    network: NetworkType
  ): BuiltTransaction {
    const { to, amount, fee = DEFAULT_FEE, fromAddresses } = request;

    // Validate destination address matches network
    const expectedPrefix = NETWORKS[network].addressFirstChar;
    if (!to.startsWith(expectedPrefix)) {
      throw new Error(`Invalid ${network} address. Expected address starting with '${expectedPrefix}'.`);
    }
    // Full address validation including checksum verification
    if (!Address.validate(to, network)) {
      throw new Error('Invalid address: checksum verification failed');
    }

    // Filter UTXOs by fromAddresses if specified
    let availableUtxos = utxos;
    if (fromAddresses && fromAddresses.length > 0) {
      availableUtxos = utxos.filter(u => fromAddresses.includes(u.address));
    }

    // Sort UTXOs by amount (largest first for efficiency) using satoshi BigInt comparison
    availableUtxos.sort((a, b) => {
      const aSats = diviToSatoshis(a.amount);
      const bSats = diviToSatoshis(b.amount);
      if (bSats > aSats) return 1;
      if (bSats < aSats) return -1;
      return 0;
    });

    // Select UTXOs to cover amount + fee using BigInt satoshi arithmetic
    const selectedUtxos: UTXO[] = [];
    let selectedAmountSats = 0n;
    const targetAmountSats = diviToSatoshis(amount) + diviToSatoshis(fee);

    for (const utxo of availableUtxos) {
      if (selectedUtxos.length >= MAX_INPUTS) {
        throw new Error(`Transaction too complex: would require more than ${MAX_INPUTS} inputs. Please consolidate UTXOs first.`);
      }
      selectedUtxos.push(utxo);
      selectedAmountSats += diviToSatoshis(utxo.amount);
      if (selectedAmountSats >= targetAmountSats) break;
    }

    if (selectedAmountSats < targetAmountSats) {
      throw new Error(`Insufficient funds. Need ${satoshisToDivi(targetAmountSats)}, have ${satoshisToDivi(selectedAmountSats)}`);
    }

    // Calculate change in satoshis
    const changeSats = selectedAmountSats - targetAmountSats;

    // Find change address (first address from selected UTXOs)
    const changeAddress = selectedUtxos[0].address;

    // Build outputs
    const outputs: Array<{ address: string; amount: number }> = [
      { address: to, amount }
    ];

    // Add change output if above dust threshold (compare in satoshis)
    const dustThresholdSats = diviToSatoshis(DUST_THRESHOLD);
    if (changeSats > dustThresholdSats) {
      outputs.push({ address: changeAddress, amount: satoshisToDivi(changeSats) });
    }

    // Map UTXOs to address indices for signing
    const addressIndexMap = new Map(addresses.map(a => [a.address, a.index]));
    const inputIndices = selectedUtxos.map(utxo => {
      const index = addressIndexMap.get(utxo.address);
      if (index === undefined) {
        throw new Error(`Address index not found for ${utxo.address}`);
      }
      return index;
    });

    // Build transaction using Transaction class
    const tx = new Transaction();

    // Add inputs
    for (const utxo of selectedUtxos) {
      tx.inputs.push({
        txid: utxo.txid,
        vout: utxo.vout,
        script: utxo.scriptPubKey,
        sequence: 0xffffffff,
      });
    }

    // Add outputs (convert DIVI to satoshis)
    for (const output of outputs) {
      // Decode the recipient address to get the pubKeyHash for the output script
      const decoded = Address.decode(output.address);
      const pubKeyHash = decoded.hash;

      // Create P2PKH output script: OP_DUP OP_HASH160 <pubKeyHash> OP_EQUALVERIFY OP_CHECKSIG
      const scriptBytes = new Uint8Array(25);
      scriptBytes[0] = 0x76; // OP_DUP
      scriptBytes[1] = 0xa9; // OP_HASH160
      scriptBytes[2] = 0x14; // Push 20 bytes
      scriptBytes.set(pubKeyHash, 3);
      scriptBytes[23] = 0x88; // OP_EQUALVERIFY
      scriptBytes[24] = 0xac; // OP_CHECKSIG

      tx.outputs.push({
        value: Number(diviToSatoshis(output.amount)), // Convert to satoshis
        script: scriptBytes,
      });
    }

    const hex = tx.toHex();

    // Calculate transaction ID (double SHA256 of tx, reversed)
    const txBytes = hexToBytes(hex);
    const hash1 = this.sha256(txBytes);
    const hash2 = this.sha256(hash1);
    const txid = bytesToHex(hash2.reverse());

    return {
      hex,
      txid,
      fee,
      inputIndices,
    };
  }

  /**
   * Sign a built transaction
   */
  async signTransaction(
    txHex: string,
    privateKeys: Uint8Array[]
  ): Promise<string> {
    // Parse transaction
    const tx = Transaction.fromHex(txHex);

    // For each input, we need to sign and replace the script
    for (let i = 0; i < tx.inputs.length; i++) {
      const privateKey = privateKeys[i];
      if (!privateKey) {
        throw new Error(`Private key missing for input ${i}`);
      }

      // Derive public key from private key
      const publicKey = this.derivePublicKeyFromPrivate(privateKey);

      // Get pubKeyHash from the input's scriptPubKey
      const scriptPubKey = typeof tx.inputs[i].script === 'string'
        ? hexToBytes(tx.inputs[i].script as string)
        : tx.inputs[i].script as Uint8Array;

      // Extract pubKeyHash from P2PKH script (skip OP_DUP OP_HASH160 <push>)
      const pubKeyHash = scriptPubKey.slice(3, 23);

      // Create signature hash for this input
      const sigHash = tx.sigHashForInput(i, pubKeyHash);

      // Sign the hash
      const signature = await Signer.signHash(sigHash, privateKey);

      // Create scriptSig
      const scriptSig = Signer.createScriptSig(signature, publicKey);

      // Replace input script with scriptSig
      tx.inputs[i].script = scriptSig;
    }

    return tx.toHex();
  }

  /**
   * Validate an address
   */
  validateAddress(address: string, network: NetworkType): boolean {
    return Address.validate(address, network);
  }

  /**
   * Get address info (check if it belongs to known addresses)
   */
  findAddressInfo(
    address: string,
    addresses: AccountAddress[]
  ): AccountAddress | null {
    return addresses.find(a => a.address === address) || null;
  }

  /**
   * Estimate transaction fee based on input/output count
   */
  estimateFee(inputCount: number, outputCount: number): number {
    // Estimate size: ~148 bytes per input + ~34 bytes per output + ~10 bytes overhead
    const estimatedSize = (inputCount * 148) + (outputCount * 34) + 10;
    // Fee rate: ~1 satoshi per byte minimum
    const feeRate = 0.00000001; // 1 satoshi
    return Math.max(DEFAULT_FEE, estimatedSize * feeRate);
  }

  /**
   * Parse address from various formats (BIP21 URI, plain address)
   */
  parseAddress(input: string): { address: string; amount?: number } {
    // Check for BIP21 URI format: divi:ADDRESS?amount=X
    const uriMatch = input.match(/^divi:([a-zA-Z0-9]+)(\?(.*))?$/i);
    if (uriMatch) {
      const address = uriMatch[1];
      const params = new URLSearchParams(uriMatch[3] || '');
      const amount = params.get('amount');
      return {
        address,
        amount: amount ? parseFloat(amount) : undefined,
      };
    }

    // Plain address
    return { address: input.trim() };
  }

  /**
   * Format balance for display
   */
  formatBalance(amount: number, hideBalance: boolean = false): string {
    if (hideBalance) {
      return '••••••';
    }
    // Adaptive precision - show significant digits only
    if (amount === 0) return '0';
    if (amount >= 1) {
      // For amounts >= 1, show up to 4 decimal places
      return amount.toFixed(4).replace(/\.?0+$/, '');
    }
    // For small amounts, show up to 8 decimal places
    return amount.toFixed(8).replace(/\.?0+$/, '');
  }

  // Helper methods
  private sha256(data: Uint8Array): Uint8Array {
    return Hash.sha256(data);
  }

  // Use consolidated secp256k1 module for public key derivation
  private derivePublicKeyFromPrivate(privateKey: Uint8Array): Uint8Array {
    return derivePublicKey(privateKey);
  }
}

// Singleton instance
export const walletCore = new WalletCore();
