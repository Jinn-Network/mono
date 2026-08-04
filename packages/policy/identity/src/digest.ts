// SPDX-License-Identifier: MIT

/**
 * sha256 and the two digest spellings this package reads and writes.
 *
 * FINDING F9 (README): `learner-public.v1` emits **bare** hex; the `loadout.digest` pinning value
 * and every digest inside a candidate manifest carry the `sha256:` prefix. Both spellings are
 * named here so the conversion point is a constant rather than a `slice(7)` somewhere.
 */

import { sha256 } from "@noble/hashes/sha2.js";

const HEX = "0123456789abcdef";

const encoder = new TextEncoder();

function toHex(bytes: Uint8Array): string {
  let out = "";
  for (const byte of bytes) out += HEX[byte >> 4] + HEX[byte & 0x0f];
  return out;
}

/** sha256 over exact bytes, as 64 lowercase hex digits with no prefix. */
export function sha256Hex(bytes: Uint8Array): string {
  return toHex(sha256(bytes));
}

/** sha256 over the UTF-8 encoding of `text`, bare hex. */
export function sha256HexOfText(text: string): string {
  return sha256Hex(encoder.encode(text));
}

/** sha256 over exact bytes in the stack's `sha256:<hex>` spelling. */
export function prefixedDigest(bytes: Uint8Array): string {
  return `sha256:${sha256Hex(bytes)}`;
}

/** The stack-wide prefixed spelling: lowercase hex only, so one digest has one string form. */
export const SHA256_PREFIXED_PATTERN = /^sha256:[0-9a-f]{64}$/;

/** The `learner-public.v1` output spelling (F9). */
export const SHA256_BARE_HEX_PATTERN = /^[0-9a-f]{64}$/;
