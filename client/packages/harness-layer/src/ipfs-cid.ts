// SPDX-License-Identifier: Apache-2.0

/**
 * CID validation for harness-layer network boundaries. Keep this package-local:
 * the harness-layer ↔ client/src architecture seam is shrink-only.
 *
 * The live Autonolas registry emits CIDv1 raw objects, including the historical
 * base16 form `f01551220<sha256>`. We deliberately support only the two codecs
 * used by the Jinn/IPFS paths (raw and dag-pb) and only sha2-256 multihashes.
 */
const BASE58BTC = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
const BASE32 = 'abcdefghijklmnopqrstuvwxyz234567';

export const IPFS_RAW_CODEC = 0x55;
export const IPFS_DAG_PB_CODEC = 0x70;

export interface ParsedIpfsCid {
  version: 0 | 1;
  codec: typeof IPFS_RAW_CODEC | typeof IPFS_DAG_PB_CODEC;
  sha256Digest: Uint8Array;
}

export function parseIpfsCid(value: string): ParsedIpfsCid | null {
  if (value.startsWith('Qm')) {
    const bytes = decodeBase58(value);
    // CIDv0 is specifically a dag-pb sha2-256 multihash.
    if (
      bytes?.length !== 34
      || bytes[0] !== 0x12
      || bytes[1] !== 0x20
    ) {
      return null;
    }
    return {
      version: 0,
      codec: IPFS_DAG_PB_CODEC,
      sha256Digest: bytes.slice(2),
    };
  }

  let bytes: Uint8Array | null;
  if (value.startsWith('b')) {
    // The supported 36-byte CIDv1 shape has one canonical 58-symbol base32
    // encoding. Reject zero-extended textual aliases before decoding so CID
    // strings remain safe cache/deduplication and metadata-key identities.
    if (value.length !== 59) return null;
    bytes = decodeBase32(value.slice(1));
  } else if (value.startsWith('f')) {
    const body = value.slice(1);
    bytes = /^[0-9a-f]+$/u.test(body) ? decodeBase16(body) : null;
  } else if (value.startsWith('F')) {
    const body = value.slice(1);
    bytes = /^[0-9A-F]+$/u.test(body) ? decodeBase16(body) : null;
  } else {
    return null;
  }

  // Supported CIDv1 values are exactly:
  // version(01) + codec(raw=55|dag-pb=70) + sha2-256(12 20 <32 bytes>).
  if (
    bytes?.length !== 36
    || bytes[0] !== 0x01
    || (bytes[1] !== IPFS_RAW_CODEC && bytes[1] !== IPFS_DAG_PB_CODEC)
    || bytes[2] !== 0x12
    || bytes[3] !== 0x20
  ) {
    return null;
  }
  return {
    version: 1,
    codec: bytes[1],
    sha256Digest: bytes.slice(4),
  };
}

export function isIpfsCid(value: string): boolean {
  return parseIpfsCid(value) !== null;
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

function decodeBase16(value: string): Uint8Array | null {
  if (value.length === 0 || value.length % 2 !== 0) return null;
  const bytes = new Uint8Array(value.length / 2);
  for (let index = 0; index < value.length; index += 2) {
    const byte = Number.parseInt(value.slice(index, index + 2), 16);
    if (!Number.isInteger(byte)) return null;
    bytes[index / 2] = byte;
  }
  return bytes;
}
