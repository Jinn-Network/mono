// SPDX-License-Identifier: MIT

import { sha256Hex } from "@jinn-network/task-execution-protocol";

/**
 * CIDv1 raw-codec convention (design §3 audit): one on-chain `bytes32`, fixed-prefix
 * reconstruction, raw codec (0x55) so the CID digest EQUALS sha256 of the exact bytes --
 * Autonolas's own dag-pb hashing is the cautionary counterexample this binding deliberately
 * avoids. The CID is therefore computed LOCALLY from the bytes, never trusted from whatever a
 * gateway happens to echo back.
 *
 * Multihash layout: `[version(0x01), codec(0x55 raw), hashFn(0x12 sha2-256), length(0x20), ...32
 * digest bytes]` = 36 bytes, base32 (RFC 4648, lowercase, no padding) with the `b` multibase
 * prefix.
 */
const BASE32_ALPHABET = "abcdefghijklmnopqrstuvwxyz234567";

function base32Encode(bytes: Uint8Array): string {
  let bits = 0;
  let value = 0;
  let output = "";
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      output += BASE32_ALPHABET[(value >>> (bits - 5)) & 0x1f];
      bits -= 5;
    }
  }
  if (bits > 0) {
    output += BASE32_ALPHABET[(value << (5 - bits)) & 0x1f];
  }
  return output;
}

function base32Decode(text: string): Uint8Array {
  let bits = 0;
  let value = 0;
  const output: number[] = [];
  for (const char of text) {
    const index = BASE32_ALPHABET.indexOf(char);
    if (index < 0) throw new Error(`invalid base32 character: "${char}"`);
    value = (value << 5) | index;
    bits += 5;
    if (bits >= 8) {
      output.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return new Uint8Array(output);
}

function hexToBytes(hex: string): Uint8Array {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return bytes;
}

/** Computes the deterministic raw-codec CIDv1 for the exact bytes -- pure, no I/O. */
export function computeRawCodecCid(
  bytes: Uint8Array,
): { cid: string; sha256Digest: `sha256:${string}` } {
  const digestHex = sha256Hex(bytes);
  const sha256Digest = `sha256:${digestHex}` as const;
  return { cid: rawCodecCidFromSha256Digest(sha256Digest), sha256Digest };
}

/**
 * Reconstructs the canonical raw-codec CIDv1 from a validated exact-byte sha256 digest.
 * Consumers that learn a Delivery digest from a canonical chain observation use this instead of
 * implementing a second CID encoder locally.
 */
export function rawCodecCidFromSha256Digest(digest: `sha256:${string}`): string {
  if (!/^sha256:[0-9a-f]{64}$/u.test(digest)) {
    throw new Error("rawCodecCidFromSha256Digest requires a lowercase sha256 digest");
  }
  const digestHex = digest.slice("sha256:".length);
  const multihash = new Uint8Array(4 + 32);
  multihash[0] = 0x01; // CID version 1
  multihash[1] = 0x55; // codec: raw
  multihash[2] = 0x12; // multihash function: sha2-256
  multihash[3] = 0x20; // digest length: 32
  multihash.set(hexToBytes(digestHex), 4);
  return `b${base32Encode(multihash)}`;
}

/**
 * Decodes a canonical `computeRawCodecCid` output back to its sha256 digest hex (no `0x`/`sha256:`
 * prefix). Rejects anything not in the canonical base32 raw-codec-sha2-256 CIDv1 form this
 * package produces.
 */
export function decodeRawCodecCidDigestHex(cid: string): string {
  if (!cid.startsWith("b")) throw new Error("CID must use the 'b' (base32) multibase prefix");
  const bytes = base32Decode(cid.slice(1));
  if (bytes.length !== 36 || bytes[0] !== 0x01 || bytes[1] !== 0x55 || bytes[2] !== 0x12 || bytes[3] !== 0x20) {
    throw new Error("CID must be a raw-codec (0x55), sha2-256 (0x12), 32-byte-digest CIDv1");
  }
  return Buffer.from(bytes.slice(4)).toString("hex");
}

/** Injected persistence port -- pins/uploads the exact bytes. The CID itself is never derived from it (computed locally). */
export interface IpfsPinPort {
  pin(bytes: Uint8Array): Promise<void>;
}

/**
 * Uploads bytes as a raw-codec CID (design §6.1 "posting"): the CID is computed locally
 * (`computeRawCodecCid`), then the exact bytes are persisted via the injected `IpfsPinPort`. A
 * pin-port failure propagates -- this never returns a CID for content that was not actually
 * pinned.
 */
export async function uploadRawCodecCid(
  bytes: Uint8Array,
  port: IpfsPinPort,
): Promise<{ cid: string; sha256Digest: `sha256:${string}` }> {
  const result = computeRawCodecCid(bytes);
  await port.pin(bytes);
  return result;
}
