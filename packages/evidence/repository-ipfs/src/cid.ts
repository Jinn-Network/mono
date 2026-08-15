// SPDX-License-Identifier: Apache-2.0

import {
  EvidenceRepositoryError,
  parseSha256Digest,
  type Sha256Digest,
} from "@jinn-network/evidence-repository";

const BASE58BTC = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
const BASE32 = "abcdefghijklmnopqrstuvwxyz234567";

export const IPFS_RAW_CODEC = 0x55;
export const IPFS_DAG_PB_CODEC = 0x70;
export const MAX_STANDARD_IPFS_BLOCK_BYTES = 2 * 1024 * 1024;

const CID_V1 = 0x01;
const SHA2_256_MULTIHASH = 0x12;
const SHA2_256_LENGTH = 0x20;
const CID_V1_BYTE_LENGTH = 36;

export interface ParsedIpfsCid {
  readonly version: 0 | 1;
  readonly codec: typeof IPFS_RAW_CODEC | typeof IPFS_DAG_PB_CODEC;
  readonly sha256Digest: Uint8Array;
}

export function parseIpfsCid(value: string): ParsedIpfsCid | null {
  if (typeof value !== "string") return null;

  if (value.startsWith("Qm")) {
    const bytes = decodeBase58(value);
    if (
      bytes === null ||
      bytes.byteLength !== 34 ||
      bytes[0] !== SHA2_256_MULTIHASH ||
      bytes[1] !== SHA2_256_LENGTH ||
      encodeBase58(bytes) !== value
    ) {
      return null;
    }
    return {
      version: 0,
      codec: IPFS_DAG_PB_CODEC,
      sha256Digest: bytes.slice(2),
    };
  }

  let bytes: Uint8Array | null = null;
  if (value.startsWith("f")) {
    const body = value.slice(1);
    if (body.length !== CID_V1_BYTE_LENGTH * 2 || !/^[0-9a-f]+$/u.test(body)) {
      return null;
    }
    bytes = decodeBase16(body);
  } else if (value.startsWith("b")) {
    if (value.length !== 59 || !/^b[a-z2-7]+$/u.test(value)) {
      return null;
    }
    bytes = decodeBase32(value.slice(1));
    if (bytes !== null && `b${encodeBase32(bytes)}` !== value) {
      return null;
    }
  } else {
    return null;
  }

  if (
    bytes === null ||
    bytes.byteLength !== CID_V1_BYTE_LENGTH ||
    bytes[0] !== CID_V1 ||
    (bytes[1] !== IPFS_RAW_CODEC && bytes[1] !== IPFS_DAG_PB_CODEC) ||
    bytes[2] !== SHA2_256_MULTIHASH ||
    bytes[3] !== SHA2_256_LENGTH
  ) {
    return null;
  }

  return {
    version: 1,
    codec: bytes[1],
    sha256Digest: bytes.slice(4),
  };
}

export function digestToRawCid(untrustedDigest: Sha256Digest): string {
  const digest = parseSha256Digest(untrustedDigest);
  return `f01551220${digest.slice("sha256:".length)}`;
}

export function rawCidToDigest(cid: string): Sha256Digest {
  const parsed = parseIpfsCid(cid);
  if (
    parsed === null ||
    parsed.version !== 1 ||
    parsed.codec !== IPFS_RAW_CODEC
  ) {
    throw new EvidenceRepositoryError(
      "INVALID_REFERENCE",
      "Expected a canonical CIDv1 raw SHA2-256 CID.",
    );
  }
  return parseSha256Digest(
    `sha256:${Buffer.from(parsed.sha256Digest).toString("hex")}`,
  );
}

export function normalizeRawCid(cid: string): string {
  return digestToRawCid(rawCidToDigest(cid));
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

function decodeBase32(value: string): Uint8Array | null {
  const bytes: number[] = [];
  let accumulator = 0;
  let bits = 0;
  for (const character of value) {
    const digit = BASE32.indexOf(character);
    if (digit < 0) return null;
    accumulator = (accumulator << 5) | digit;
    bits += 5;
    while (bits >= 8) {
      bits -= 8;
      bytes.push((accumulator >>> bits) & 0xff);
    }
  }
  if (bits > 0 && (accumulator & ((1 << bits) - 1)) !== 0) return null;
  return Uint8Array.from(bytes);
}

function encodeBase32(bytes: Uint8Array): string {
  let output = "";
  let accumulator = 0;
  let bits = 0;
  for (const byte of bytes) {
    accumulator = (accumulator << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      bits -= 5;
      output += BASE32[(accumulator >>> bits) & 0x1f];
    }
  }
  if (bits > 0) {
    output += BASE32[(accumulator << (5 - bits)) & 0x1f];
  }
  return output;
}

function decodeBase58(value: string): Uint8Array | null {
  if (value.length === 0) return null;
  const bytes: number[] = [0];
  for (const character of value) {
    const digit = BASE58BTC.indexOf(character);
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
  let leadingZeroes = 0;
  for (const character of value) {
    if (character !== "1") break;
    leadingZeroes += 1;
  }
  return Uint8Array.from([
    ...new Array<number>(leadingZeroes).fill(0),
    ...bytes,
  ]);
}

function encodeBase58(bytes: Uint8Array): string {
  if (bytes.byteLength === 0) return "";
  const digits: number[] = [0];
  for (const byte of bytes) {
    let carry = byte;
    for (let index = digits.length - 1; index >= 0; index -= 1) {
      const next = digits[index]! * 256 + carry;
      digits[index] = next % 58;
      carry = Math.floor(next / 58);
    }
    while (carry > 0) {
      digits.unshift(carry % 58);
      carry = Math.floor(carry / 58);
    }
  }
  let leadingZeroes = 0;
  for (const byte of bytes) {
    if (byte !== 0) break;
    leadingZeroes += 1;
  }
  return `${"1".repeat(leadingZeroes)}${digits
    .map((digit) => BASE58BTC[digit])
    .join("")}`;
}
