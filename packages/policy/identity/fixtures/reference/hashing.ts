// SPDX-License-Identifier: MIT

import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex } from "@noble/hashes/utils.js";

const encoder = new TextEncoder();

export function sha256Hex(bytes: Uint8Array): string {
  return bytesToHex(sha256(bytes));
}

export function sha256HexOfText(text: string): string {
  return sha256Hex(encoder.encode(text));
}

/** The stack's digest spelling: `sha256:<64 lowercase hex>` (TEP §6.1). */
export function prefixedDigest(bytes: Uint8Array): string {
  return `sha256:${sha256Hex(bytes)}`;
}

export const SHA256_PREFIXED_PATTERN = /^sha256:[0-9a-f]{64}$/;
export const SHA256_BARE_HEX_PATTERN = /^[0-9a-f]{64}$/;
