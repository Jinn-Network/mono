// SPDX-License-Identifier: Apache-2.0

import { timingSafeEqual } from "node:crypto";

import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex } from "@noble/hashes/utils.js";
import canonicalize from "canonicalize";

import { ProfilesError } from "./errors.js";

const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true });

// Program §7.14 / TEP §6.1: every sealer REJECTS numbers not exactly representable as I-JSON
// integers. `canonicalize` (JCS) would otherwise happily serialize a fractional number into sealed
// bytes; evidence enforces this at its schema layer, so profiles enforces it here at the seal path.
// Fractional quantities are string decimals in the zod schemas (e.g. composite-grader `weight`).
function assertIJsonNumbers(value: unknown): void {
  if (typeof value === "number") {
    if (!Number.isFinite(value) || !Number.isInteger(value)) {
      throw new ProfilesError(
        "invalid-document",
        `Sealed numbers must be I-JSON integers; got ${value}. Encode fractional values as strings.`,
      );
    }
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) assertIJsonNumbers(item);
    return;
  }
  if (value && typeof value === "object") {
    for (const nested of Object.values(value)) assertIJsonNumbers(nested);
  }
}

export function canonicalJsonBytes(value: unknown): Uint8Array {
  assertIJsonNumbers(value);
  const encoded = canonicalize(value);
  if (encoded === undefined) {
    throw new ProfilesError("invalid-document", "Value cannot be serialized as canonical JSON.");
  }
  return encoder.encode(encoded);
}

export function decodeUtf8(bytes: Uint8Array): string {
  try {
    return decoder.decode(bytes);
  } catch (cause) {
    throw new ProfilesError("invalid-document", "Bytes are not valid UTF-8.", { cause });
  }
}

export function sha256Hex(bytes: Uint8Array): string {
  return bytesToHex(sha256(bytes));
}

export function recordDigest(bytes: Uint8Array): `sha256:${string}` {
  return `sha256:${sha256Hex(bytes)}`;
}

export function sealDocument(value: unknown): { bytes: Uint8Array; digest: `sha256:${string}` } {
  const bytes = canonicalJsonBytes(value);
  return { bytes, digest: recordDigest(bytes) };
}

export function bytesEqual(left: Uint8Array, right: Uint8Array): boolean {
  return left.byteLength === right.byteLength && timingSafeEqual(left, right);
}
