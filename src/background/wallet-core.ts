import { Address } from '../lib/address';
import { MAX_OP_RETURN_BYTES, opReturnScript, Transaction } from '../lib/transaction';
import { bytesToHex } from '../lib/hex';
import { Signer } from '../lib/signer';
import { derivePublicKey } from '../lib/secp256k1';
import { DUST_THRESHOLD, type NetworkType } from '../shared/constants';
import type { AccountAddress } from '../shared/storage';
export { deriveAddresses } from '../lib/derivation';

export interface UTXO {
  txid: string;
  vout: number;
  address: string;
  satoshis: bigint;
  amount: number; // DIVI, for display only
  confirmations: number;
}

export interface TransactionRequest {
  to: string;
  // DIVI, as a decimal string ("1234.5") or a number; see parseDiviAmount
  amount: number | string;
  // Only honoured from the wallet's own popup; a site never sets the fee
  fee?: number;
  fromAddresses?: string[];
  // Text put unchanged into one OP_RETURN output (IronDivi Connect "memo")
  memo?: string;
}

export interface BuiltInput {
  txid: string;
  vout: number;
  address: string;
  addressIndex: number;
  satoshis: bigint;
}

export interface BuiltTransaction {
  tx: Transaction;
  hex: string;
  txid: string;
  fee: number;
  feeSats: bigint;
  amountSats: bigint;
  inputs: BuiltInput[];
  inputIndices: number[]; // Address indices used for signing
}

// What the owner asked for, checked again against the transaction just before
// it is signed: the recipient and amount, and which addresses count as theirs
export interface SendIntent {
  to: string;
  amountSats: bigint;
  ownAddresses: string[];
  network: NetworkType;
  // The memo the owner was shown; the transaction carries exactly it, or none
  memo?: string;
}

// DIVI min relay fee: 10,000 sat/KB, so 10 sat per byte, and never below 5000 sat
const MIN_FEE_SATS = 5000n;
const FEE_SATS_PER_BYTE = 10n;
// No send pays more than this in fees, whoever asks
export const MAX_FEE_SATS = 1_000_000n; // 0.01 DIVI
const MAX_INPUTS = 250; // Reasonable limit to prevent oversized transactions

const SATOSHIS_PER_COIN = 100000000n; // 1e8 as BigInt

/**
 * Convert DIVI to satoshis using integer math
 * Handles negative values correctly
 */
export function diviToSatoshis(divi: number): bigint {
  const isNegative = divi < 0;
  const absValue = Math.abs(divi);
  const str = absValue.toFixed(8);
  const [intPart, fracPart = ''] = str.split('.');
  const intSats = BigInt(intPart) * SATOSHIS_PER_COIN;
  const fracSats = BigInt(fracPart.padEnd(8, '0'));
  const result = intSats + fracSats;
  return isNegative ? -result : result;
}

// Above this a double no longer holds every satoshi (2^53 / 1e8)
const MAX_EXACT_NUMBER_DIVI = 90_000_000;

/**
 * An amount a site or the popup asked to send, in satoshis, exactly. A
 * decimal string is parsed straight to BigInt; a number is accepted only
 * where a double holds it to the satoshi and it has at most 8 decimals, so
 * the amount signed is never a rounded version of the one asked for.
 */
export function parseDiviAmount(amount: unknown): bigint {
  let text: string;
  if (typeof amount === 'string') {
    text = amount;
  } else if (typeof amount === 'number' && Number.isFinite(amount) && amount > 0) {
    if (amount > MAX_EXACT_NUMBER_DIVI) throw new Error('Invalid amount: send amounts this large as a decimal string');
    text = amount.toFixed(8);
    if (Number(text) !== amount) throw new Error('Invalid amount: at most 8 decimal places');
  } else {
    throw new Error('Invalid amount');
  }
  const m = /^(\d{1,12})(?:\.(\d{1,8}))?$/.exec(text);
  if (!m) throw new Error('Invalid amount');
  const sats = BigInt(m[1]) * SATOSHIS_PER_COIN + BigInt((m[2] ?? '').padEnd(8, '0'));
  if (sats <= 0n) throw new Error('Invalid amount');
  return sats;
}

/**
 * Satoshis as exact DIVI text, with no trailing zeros
 */
export function satoshisText(satoshis: bigint): string {
  const negative = satoshis < 0n;
  const abs = negative ? -satoshis : satoshis;
  const frac = (abs % SATOSHIS_PER_COIN).toString().padStart(8, '0').replace(/0+$/, '');
  return `${negative ? '-' : ''}${abs / SATOSHIS_PER_COIN}${frac ? '.' + frac : ''}`;
}

/**
 * Convert satoshis to DIVI for display
 */
export function satoshisToDivi(satoshis: bigint): number {
  return Number(satoshis) / 100000000;
}

/**
 * The P2PKH output script that pays one of the wallet's own key addresses:
 * OP_DUP OP_HASH160 <pubKeyHash> OP_EQUALVERIFY OP_CHECKSIG. A payment to
 * another address uses Address.outputScript, which also pays script addresses.
 */
export function p2pkhScript(address: string): string {
  return '76a914' + bytesToHex(Address.decode(address).hash) + '88ac';
}

// Smallest fee the network relays for a P2PKH transaction of this shape,
// plus extraBytes (an OP_RETURN output)
function minimumFeeSats(inputCount: number, outputCount: number, extraBytes = 0): bigint {
  const estimatedSize = BigInt(inputCount * 148 + outputCount * 34 + 10 + extraBytes);
  const fee = estimatedSize * FEE_SATS_PER_BYTE;
  return fee > MIN_FEE_SATS ? fee : MIN_FEE_SATS;
}

function scriptToHex(script: Uint8Array | string): string {
  return (script instanceof Uint8Array ? bytesToHex(script) : script).toLowerCase();
}

// Size of an output with this script: value, script length, script
function outputBytes(scriptHex: string): number {
  const len = scriptHex.length / 2;
  return 8 + (len < 0xfd ? 1 : 3) + len;
}

export class WalletCore {
  /**
   * Calculate total balance from UTXOs
   */
  calculateBalance(utxos: UTXO[]): number {
    return satoshisToDivi(utxos.reduce((sum, utxo) => sum + utxo.satoshis, 0n));
  }

  /**
   * Check what a send asks for, before looking at the wallet's coins. Its
   * errors are about the request alone, so they may be shown to the site
   * that made it.
   */
  checkRequest(
    request: TransactionRequest,
    network: NetworkType
  ): { amountSats: bigint; requestedFeeSats: bigint | undefined } {
    const { to, amount, fee: requestedFee, memo } = request;

    const amountSats = parseDiviAmount(amount);
    if (requestedFee !== undefined &&
        (typeof requestedFee !== 'number' || !Number.isFinite(requestedFee) || requestedFee < 0)) {
      throw new Error('Invalid fee');
    }
    // Compare in satoshis: an output below dust is never relayed
    if (amountSats < diviToSatoshis(DUST_THRESHOLD)) {
      throw new Error(`Amount is below the dust threshold of ${DUST_THRESHOLD} DIVI`);
    }
    const requestedFeeSats = requestedFee === undefined ? undefined : diviToSatoshis(requestedFee);
    if (requestedFeeSats !== undefined && requestedFeeSats > MAX_FEE_SATS) {
      throw new Error(`Fee is above the most this wallet pays, ${satoshisToDivi(MAX_FEE_SATS)} DIVI`);
    }

    // The destination is a key or script address on this network, checksum
    // included; testnet key addresses start with 'x' or 'y'
    if (typeof to !== 'string' || !Address.validate(to, network)) {
      throw new Error(`Invalid ${network} address`);
    }

    if (memo !== undefined) {
      try {
        opReturnScript(memo);
      } catch {
        throw new Error(`Invalid memo: it must be text of 1 to ${MAX_OP_RETURN_BYTES} bytes (UTF-8)`);
      }
    }

    return { amountSats, requestedFeeSats };
  }

  /**
   * Build an unsigned transaction. The fee is worked out here from the
   * transaction's size; a fee in the request is used only if it is between
   * that minimum and MAX_FEE_SATS.
   */
  buildTransaction(
    utxos: UTXO[],
    addresses: AccountAddress[],
    request: TransactionRequest,
    network: NetworkType
  ): BuiltTransaction {
    const { to, fromAddresses, memo } = request;
    const { amountSats, requestedFeeSats } = this.checkRequest(request, network);
    const memoHex = memo === undefined ? undefined : opReturnScript(memo);
    const extraBytes = memoHex ? outputBytes(memoHex) : 0;

    // Only coins at this account's own addresses can be spent
    const addressIndexMap = new Map(addresses.map(a => [a.address, a.index]));
    let availableUtxos = utxos.filter(u => addressIndexMap.has(u.address));
    if (fromAddresses && fromAddresses.length > 0) {
      availableUtxos = availableUtxos.filter(u => fromAddresses.includes(u.address));
    }

    // Coins of the first from-address first, so input 0 (whose address names
    // the payer, as a name registry reads it) is that address; then largest
    // first, so the fewest inputs are needed
    const payer = fromAddresses && fromAddresses.length > 0 ? fromAddresses[0] : undefined;
    availableUtxos = [...availableUtxos].sort((a, b) =>
      (payer !== undefined && (a.address === payer) !== (b.address === payer)) ? (a.address === payer ? -1 : 1)
        : b.satoshis > a.satoshis ? 1 : b.satoshis < a.satoshis ? -1 : 0);
    if (payer !== undefined && availableUtxos.length > 0 && availableUtxos[0].address !== payer) {
      throw new Error(`No spendable coins at ${payer}, the address this payment must come from`);
    }

    // Select UTXOs to cover amount + fee; the fee grows with each input
    const selectedUtxos: UTXO[] = [];
    let selectedAmountSats = 0n;
    let feeSats = 0n;
    for (const utxo of availableUtxos) {
      if (selectedUtxos.length >= MAX_INPUTS) {
        throw new Error(`Transaction too complex: would require more than ${MAX_INPUTS} inputs. Please consolidate UTXOs first.`);
      }
      selectedUtxos.push(utxo);
      selectedAmountSats += utxo.satoshis;
      feeSats = this.feeFor(selectedUtxos.length, requestedFeeSats, extraBytes);
      if (selectedAmountSats >= amountSats + feeSats) break;
    }
    if (selectedUtxos.length === 0) feeSats = this.feeFor(1, requestedFeeSats, extraBytes);

    if (selectedAmountSats < amountSats + feeSats) {
      throw new Error(`Insufficient funds. Need ${satoshisToDivi(amountSats + feeSats)}, have ${satoshisToDivi(selectedAmountSats)}`);
    }

    // Change below dust is not worth an output; it goes to the fee instead
    let changeSats = selectedAmountSats - amountSats - feeSats;
    if (changeSats <= diviToSatoshis(DUST_THRESHOLD)) {
      feeSats += changeSats;
      changeSats = 0n;
    }
    if (feeSats > MAX_FEE_SATS) {
      throw new Error(`Fee would be above the most this wallet pays, ${satoshisToDivi(MAX_FEE_SATS)} DIVI`);
    }

    // Change goes back to the first input's address, which is this account's
    const changeAddress = selectedUtxos[0].address;

    const inputs: BuiltInput[] = selectedUtxos.map(utxo => ({
      txid: utxo.txid.toLowerCase(),
      vout: utxo.vout,
      address: utxo.address,
      addressIndex: addressIndexMap.get(utxo.address)!,
      satoshis: utxo.satoshis,
    }));

    const tx = new Transaction();
    for (const input of inputs) {
      tx.inputs.push({
        txid: input.txid,
        vout: input.vout,
        // The script being spent is rebuilt from our own address, never taken
        // from the node
        script: p2pkhScript(input.address),
        sequence: 0xffffffff,
      });
    }
    tx.outputs.push({ value: amountSats, script: Address.outputScript(to, network) });
    if (changeSats > 0n) {
      tx.outputs.push({ value: changeSats, script: p2pkhScript(changeAddress) });
    }
    // The memo goes last, worth nothing
    if (memoHex) tx.outputs.push({ value: 0n, script: memoHex });

    return {
      tx,
      hex: tx.toHex(),
      txid: tx.txid(),
      fee: satoshisToDivi(feeSats),
      feeSats,
      amountSats,
      inputs,
      inputIndices: inputs.map(input => input.addressIndex),
    };
  }

  private feeFor(inputCount: number, requestedFeeSats: bigint | undefined, extraBytes: number): bigint {
    // One output to the recipient and one for change, and any memo
    const minimum = minimumFeeSats(inputCount, 2, extraBytes);
    if (requestedFeeSats === undefined) return minimum;
    if (requestedFeeSats < minimum) {
      throw new Error(`Fee is below the network minimum of ${satoshisToDivi(minimum)} DIVI for this send`);
    }
    return requestedFeeSats;
  }

  /**
   * Check a built transaction against what the owner asked for. Throws if it
   * pays anyone else, spends anything else, or pays more than MAX_FEE_SATS.
   */
  checkIntent(built: BuiltTransaction, intent: SendIntent): void {
    const { tx, inputs } = built;
    const own = new Set(intent.ownAddresses);

    if (tx.inputs.length === 0 || tx.inputs.length !== inputs.length) {
      throw new Error('Transaction inputs do not match the coins selected');
    }
    let inSats = 0n;
    for (let i = 0; i < inputs.length; i++) {
      const input = inputs[i];
      if (tx.inputs[i].txid !== input.txid || tx.inputs[i].vout !== input.vout ||
          !own.has(input.address) || input.satoshis <= 0n) {
        throw new Error('Transaction inputs do not match the coins selected');
      }
      inSats += input.satoshis;
    }

    if (!Address.validate(intent.to, intent.network)) {
      throw new Error('Invalid address');
    }
    let outputs = tx.outputs;
    // A memo is the last output, worth nothing, holding exactly the memo
    if (intent.memo !== undefined) {
      const last = outputs[outputs.length - 1];
      if (!last || last.value !== 0n || scriptToHex(last.script) !== opReturnScript(intent.memo)) {
        throw new Error('Transaction does not carry the memo that was shown');
      }
      outputs = outputs.slice(0, -1);
    }
    if (outputs.length < 1 || outputs.length > 2 ||
        outputs[0].value !== intent.amountSats ||
        scriptToHex(outputs[0].script) !== Address.outputScript(intent.to, intent.network)) {
      throw new Error('Transaction does not pay what was asked');
    }
    let outSats = outputs[0].value;
    if (outputs.length === 2) {
      const changeOk = [...own].some(a => scriptToHex(outputs[1].script) === p2pkhScript(a));
      if (!changeOk || outputs[1].value <= 0n) {
        throw new Error('Transaction change does not go back to this wallet');
      }
      outSats += outputs[1].value;
    }

    const feeSats = inSats - outSats;
    if (feeSats < 0n || feeSats !== built.feeSats || feeSats > MAX_FEE_SATS) {
      throw new Error('Transaction fee is not what was shown');
    }
  }

  /**
   * Sign a built transaction, after checking it against the owner's intent.
   * privateKeys[i] signs inputs[i]; each must be the key of that input's address.
   */
  async signTransaction(
    built: BuiltTransaction,
    privateKeys: Uint8Array[],
    intent: SendIntent
  ): Promise<string> {
    this.checkIntent(built, intent);
    if (privateKeys.length !== built.inputs.length) {
      throw new Error('Private key missing for an input');
    }

    // Sign a copy so a failure part way leaves the built transaction unsigned
    const tx = new Transaction();
    tx.version = built.tx.version;
    tx.locktime = built.tx.locktime;
    tx.outputs = built.tx.outputs.map(output => ({ ...output }));
    tx.inputs = built.tx.inputs.map(input => ({ ...input }));

    const scriptSigs: string[] = [];
    for (let i = 0; i < tx.inputs.length; i++) {
      const privateKey = privateKeys[i];
      if (!privateKey || privateKey.length !== 32 || privateKey.every(b => b === 0)) {
        throw new Error(`Private key missing for input ${i}`);
      }

      const publicKey = this.derivePublicKeyFromPrivate(privateKey);
      // The key must be the one for the address being spent; the hash signed
      // over comes from that address, not from any script a node supplied
      if (Address.fromPublicKey(publicKey, intent.network) !== built.inputs[i].address) {
        throw new Error(`Key does not match the address of input ${i}`);
      }
      const pubKeyHash = Address.decode(built.inputs[i].address).hash;

      const sigHash = tx.sigHashForInput(i, pubKeyHash);
      const signature = await Signer.signHash(sigHash, privateKey);
      scriptSigs.push(Signer.createScriptSig(signature, publicKey));
    }

    scriptSigs.forEach((scriptSig, i) => { tx.inputs[i].script = scriptSig; });
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
    return satoshisToDivi(minimumFeeSats(inputCount, outputCount));
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

  // Use consolidated secp256k1 module for public key derivation
  private derivePublicKeyFromPrivate(privateKey: Uint8Array): Uint8Array {
    return derivePublicKey(privateKey);
  }
}

// Singleton instance
export const walletCore = new WalletCore();
