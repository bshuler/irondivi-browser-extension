/**
 * Convert hex string to Uint8Array
 */
export function hexToBytes(hex: string): Uint8Array {
  // parseInt would read 'zz' as NaN (stored as 0) and '1g' as 1
  if (typeof hex !== 'string' || !/^([0-9a-fA-F]{2})*$/.test(hex)) {
    throw new Error('Invalid hex');
  }
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < hex.length; i += 2) {
    bytes[i / 2] = parseInt(hex.substr(i, 2), 16);
  }
  return bytes;
}

/**
 * Convert Uint8Array to hex string
 */
export function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Reverse a hex string (byte order)
 */
export function reverseHex(hex: string): string {
  const match = hex.match(/../g);
  return match ? match.reverse().join('') : '';
}
