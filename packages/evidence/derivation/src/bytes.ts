// SPDX-License-Identifier: Apache-2.0

import { timingSafeEqual } from "node:crypto";

import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex } from "@noble/hashes/utils.js";
import canonicalize from "canonicalize";

import { EvidenceDerivationError } from "./errors.js";
import type { DerivationSha256Digest } from "./types.js";

const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true });
const typedArrayPrototype = Object.getPrototypeOf(Uint8Array.prototype);
const typedArrayByteLength = Object.getOwnPropertyDescriptor(
  typedArrayPrototype,
  "byteLength",
)!.get!;
const typedArraySet = Uint8Array.prototype.set;

export function canonicalJsonBytes(value: unknown): Uint8Array {
  const encoded = canonicalize(value);
  if (encoded === undefined) {
    throw new EvidenceDerivationError(
      "INVALID_DERIVATION_INPUT",
      "Value cannot be serialized as canonical JSON.",
    );
  }
  return encoder.encode(encoded);
}

export function decodeUtf8(bytes: Uint8Array): string {
  try {
    return decoder.decode(bytes);
  } catch (cause) {
    throw new EvidenceDerivationError(
      "INVALID_DERIVATION_INPUT",
      "Bytes are not valid UTF-8.",
      { cause },
    );
  }
}

export function sha256Digest(bytes: Uint8Array): DerivationSha256Digest {
  return `sha256:${bytesToHex(sha256(bytes))}`;
}

export function bytesEqual(left: Uint8Array, right: Uint8Array): boolean {
  return left.byteLength === right.byteLength && timingSafeEqual(left, right);
}

export function copyBytes(bytes: Uint8Array): Uint8Array {
  const copy = new Uint8Array(
    Reflect.apply(typedArrayByteLength, bytes, []) as number,
  );
  Reflect.apply(typedArraySet, copy, [bytes]);
  return copy;
}

export function freezeBytes(bytes: Uint8Array): Uint8Array {
  return copyBytes(bytes);
}
