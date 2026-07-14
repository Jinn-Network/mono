// SPDX-License-Identifier: Apache-2.0

/**
 * CID validation at configuration boundaries. Decode enough multibase and
 * varint structure to distinguish a CID from a readable label; a prefix match
 * such as `bafy...` is not an IPFS publication reference.
 */
const BASE58BTC = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
const BASE32 = 'abcdefghijklmnopqrstuvwxyz234567';

export function isIpfsCid(value: string): boolean {
  if (value.startsWith('Qm')) {
    const bytes = decodeBase58(value);
    // CIDv0 is specifically a sha2-256 multihash: code 0x12, length 0x20.
    return bytes?.length === 34 && bytes[0] === 0x12 && bytes[1] === 0x20;
  }
  if (!value.startsWith('b')) return false;
  const bytes = decodeBase32(value.slice(1));
  if (!bytes) return false;
  const version = readVarint(bytes, 0);
  if (!version || version.value !== 1) return false;
  const codec = readVarint(bytes, version.next);
  if (!codec) return false;
  const hashCode = readVarint(bytes, codec.next);
  if (!hashCode) return false;
  const hashLength = readVarint(bytes, hashCode.next);
  if (!hashLength || hashLength.value <= 0) return false;
  return hashLength.next + hashLength.value === bytes.length;
}

function decodeBase58(value: string): Uint8Array | null {
  const bytes = [0];
  for (const char of value) {
    const digit = BASE58BTC.indexOf(char);
    if (digit < 0) return null;
    let carry = digit;
    for (let index = bytes.length - 1; index >= 0; index -= 1) {
      const next = bytes[index]! * 58 + carry;
      bytes[index] = next & 0xff;
      carry = next >>> 8;
    }
    while (carry > 0) {
      bytes.unshift(carry & 0xff);
      carry >>>= 8;
    }
  }
  for (const char of value) {
    if (char !== '1') break;
    bytes.unshift(0);
  }
  return Uint8Array.from(bytes);
}

function decodeBase32(value: string): Uint8Array | null {
  const bytes: number[] = [];
  let accumulator = 0;
  let bits = 0;
  for (const char of value) {
    const digit = BASE32.indexOf(char);
    if (digit < 0) return null;
    accumulator = (accumulator << 5) | digit;
    bits += 5;
    while (bits >= 8) {
      bits -= 8;
      bytes.push((accumulator >>> bits) & 0xff);
    }
  }
  if (bits !== 0 && (accumulator & ((1 << bits) - 1)) !== 0) return null;
  return Uint8Array.from(bytes);
}

function readVarint(bytes: Uint8Array, start: number): { value: number; next: number } | null {
  let value = 0;
  let shift = 0;
  for (let index = start; index < bytes.length && shift <= 28; index += 1, shift += 7) {
    const byte = bytes[index]!;
    value |= (byte & 0x7f) << shift;
    if ((byte & 0x80) === 0) return { value, next: index + 1 };
  }
  return null;
}

/**
 * Hermetic tests deliberately use readable non-CID labels. Never admit those
 * labels in an operator process; production must receive an actual CID.
 */
export function isTestOnlyIpfsCidFixture(value: string): boolean {
  return process.env.VITEST !== undefined && /^bafy-test-only-[a-z0-9-]+$/u.test(value);
}

export function isAcceptedIpfsCid(value: string): boolean {
  return isIpfsCid(value) || isTestOnlyIpfsCidFixture(value);
}
