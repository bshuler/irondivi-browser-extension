// Transaction Building and Parsing
// Creates and parses Bitcoin-style transactions

import { Hash } from './hash';
import { hexToBytes, bytesToHex, reverseHex } from './hex';

interface TxInput {
    txid: string;
    vout: number;
    script: Uint8Array | string;
    sequence: number;
}

interface TxOutput {
    value: number;
    script: Uint8Array | string;
}

class Transaction {
    version: number = 1;
    inputs: TxInput[] = [];
    outputs: TxOutput[] = [];
    locktime: number = 0;

    // Parse transaction from hex
    static fromHex(hex: string): Transaction {
        // Validate hex format
        if (!hex || typeof hex !== 'string') {
            throw new Error('Invalid transaction: input must be a string');
        }
        if (hex.length % 2 !== 0) {
            throw new Error('Invalid transaction: hex string must have even length');
        }
        if (!/^[0-9a-fA-F]*$/.test(hex)) {
            throw new Error('Invalid transaction: contains non-hex characters');
        }

        const tx = new Transaction();
        const buf = hexToBytes(hex);
        let offset = 0;

        function ensureBytes(needed: number, context: string): void {
            if (offset + needed > buf.length) {
                throw new Error(
                    `Malformed transaction: insufficient bytes for ${context} at offset ${offset} ` +
                    `(need ${needed}, have ${buf.length - offset})`
                );
            }
        }

        // Version (4 bytes)
        ensureBytes(4, 'version');
        tx.version = readInt32LE(buf, offset);
        offset += 4;

        // Input count varint (at least 1 byte)
        ensureBytes(1, 'input count');
        const inputCount = readVarInt(buf, offset);
        ensureBytes(inputCount.size, 'input count varint');
        offset += inputCount.size;

        // Sanity limit
        if (inputCount.value > 10000) {
            throw new Error(`Malformed transaction: too many inputs (${inputCount.value})`);
        }

        for (let i = 0; i < inputCount.value; i++) {
            // txid (32 bytes) + vout (4 bytes)
            ensureBytes(36, `input ${i} txid+vout`);
            const input: TxInput = {
                txid: bytesToHex(buf.slice(offset, offset + 32).reverse()),
                vout: readUInt32LE(buf, offset + 32),
                script: new Uint8Array(),
                sequence: 0xffffffff
            };
            offset += 36;

            // Script length varint
            ensureBytes(1, `input ${i} script length`);
            const scriptLen = readVarInt(buf, offset);
            ensureBytes(scriptLen.size, `input ${i} script length varint`);
            offset += scriptLen.size;

            // Script bytes
            ensureBytes(scriptLen.value, `input ${i} script`);
            input.script = buf.slice(offset, offset + scriptLen.value);
            offset += scriptLen.value;

            // Sequence (4 bytes)
            ensureBytes(4, `input ${i} sequence`);
            input.sequence = readUInt32LE(buf, offset);
            offset += 4;

            tx.inputs.push(input);
        }

        // Output count varint (at least 1 byte)
        ensureBytes(1, 'output count');
        const outputCount = readVarInt(buf, offset);
        ensureBytes(outputCount.size, 'output count varint');
        offset += outputCount.size;

        // Sanity limit
        if (outputCount.value > 10000) {
            throw new Error(`Malformed transaction: too many outputs (${outputCount.value})`);
        }

        for (let i = 0; i < outputCount.value; i++) {
            // Value (8 bytes)
            ensureBytes(8, `output ${i} value`);
            const value = readInt64LE(buf, offset);
            offset += 8;

            // Script length varint
            ensureBytes(1, `output ${i} script length`);
            const scriptLen = readVarInt(buf, offset);
            ensureBytes(scriptLen.size, `output ${i} script length varint`);
            offset += scriptLen.size;

            // Script bytes
            ensureBytes(scriptLen.value, `output ${i} script`);
            const script = buf.slice(offset, offset + scriptLen.value);
            offset += scriptLen.value;

            tx.outputs.push({ value, script });
        }

        // Locktime (4 bytes)
        ensureBytes(4, 'locktime');
        tx.locktime = readUInt32LE(buf, offset);

        return tx;
    }

    // Serialize transaction to hex
    toHex(): string {
        let hex = '';

        hex += toHex32LE(this.version);
        hex += toVarIntHex(this.inputs.length);

        for (const input of this.inputs) {
            hex += reverseHex(input.txid);
            hex += toHex32LE(input.vout);
            const script = input.script instanceof Uint8Array ?
                bytesToHex(input.script) : (input.script || '');
            hex += toVarIntHex(script.length / 2);
            hex += script;
            hex += toHex32LE(input.sequence);
        }

        hex += toVarIntHex(this.outputs.length);

        for (const output of this.outputs) {
            hex += toHex64LE(output.value);
            const script = output.script instanceof Uint8Array ?
                bytesToHex(output.script) : output.script;
            hex += toVarIntHex(script.length / 2);
            hex += script;
        }

        hex += toHex32LE(this.locktime);

        return hex;
    }

    /**
     * Add an OP_RETURN output with the given data string.
     * Used for DNS registration: DNSDIVI:REG:<name>:<owner_address>
     */
    addOpReturn(dataString: string): void {
        const data = new TextEncoder().encode(dataString);
        const dataHex = bytesToHex(data);
        const len = data.length;

        // Build scriptPubKey: OP_RETURN <push> <data>
        let scriptHex = '6a'; // OP_RETURN
        if (len <= 75) {
            // Direct push: length byte is the opcode
            scriptHex += len.toString(16).padStart(2, '0');
        } else if (len <= 255) {
            // OP_PUSHDATA1 + 1-byte length
            scriptHex += '4c' + len.toString(16).padStart(2, '0');
        } else {
            throw new Error('OP_RETURN data too large (max 255 bytes)');
        }
        scriptHex += dataHex;

        this.outputs.push({
            value: 0,
            script: scriptHex
        });
    }

    // Create signature hash for input
    sigHashForInput(inputIndex: number, pubKeyHash: Uint8Array): Uint8Array {
        // Create copy of transaction
        const copy = new Transaction();
        copy.version = this.version;
        copy.locktime = this.locktime;

        // Copy inputs with empty scripts
        for (let i = 0; i < this.inputs.length; i++) {
            const input = this.inputs[i];
            copy.inputs.push({
                txid: input.txid,
                vout: input.vout,
                script: i === inputIndex ?
                    '76a914' + bytesToHex(pubKeyHash) + '88ac' : '',
                sequence: input.sequence
            });
        }

        // Copy outputs
        for (const output of this.outputs) {
            copy.outputs.push({
                value: output.value,
                script: output.script
            });
        }

        // Append SIGHASH_ALL
        const txHex = copy.toHex() + '01000000';

        return Hash.doubleSha256(hexToBytes(txHex));
    }
}

// Utility functions
function readInt32LE(buf: Uint8Array, offset: number): number {
    return buf[offset] | (buf[offset + 1] << 8) |
           (buf[offset + 2] << 16) | (buf[offset + 3] << 24);
}

function readUInt32LE(buf: Uint8Array, offset: number): number {
    return (buf[offset] | (buf[offset + 1] << 8) |
            (buf[offset + 2] << 16) | (buf[offset + 3] << 24)) >>> 0;
}

function readInt64LE(buf: Uint8Array, offset: number): number {
    const lo = readUInt32LE(buf, offset);
    const hi = readUInt32LE(buf, offset + 4);
    return lo + hi * 0x100000000;
}

function readVarInt(buf: Uint8Array, offset: number): { value: number; size: number } {
    const first = buf[offset];
    if (first < 0xfd) return { value: first, size: 1 };
    if (first === 0xfd) return { value: buf[offset + 1] | (buf[offset + 2] << 8), size: 3 };
    if (first === 0xfe) return { value: readUInt32LE(buf, offset + 1), size: 5 };
    return { value: readInt64LE(buf, offset + 1), size: 9 };
}

function toHex32LE(num: number): string {
    const buf = new Uint8Array(4);
    buf[0] = num & 0xff;
    buf[1] = (num >> 8) & 0xff;
    buf[2] = (num >> 16) & 0xff;
    buf[3] = (num >> 24) & 0xff;
    return bytesToHex(buf);
}

function toHex64LE(num: number): string {
    const lo = num & 0xffffffff;
    const hi = Math.floor(num / 0x100000000);
    return toHex32LE(lo) + toHex32LE(hi);
}

function toVarIntHex(num: number): string {
    if (num < 0xfd) return num.toString(16).padStart(2, '0');
    if (num <= 0xffff) return 'fd' + toHex32LE(num).substring(0, 4);
    if (num <= 0xffffffff) return 'fe' + toHex32LE(num);
    return 'ff' + toHex64LE(num);
}

export { Transaction };
export { hexToBytes, bytesToHex, reverseHex };
export const TxUtils = { hexToBytes, bytesToHex, reverseHex };
