// SPDX-License-Identifier: Apache-2.0

/**
 * The Ed25519 public key inside a `did:key:z…` identifier (issue #2983).
 *
 * A `did:key` for Ed25519 is not a name that points at a key; it *is* the key — multicodec prefix
 * `0xed 0x01` followed by the raw 32 public-key bytes, base58btc-encoded. That is the whole reason
 * the domain binding keys on it: a reader who has the identifier has the key material, in every
 * bundle format, with nothing to fetch and nothing to trust. `@colophon-claims/core`'s
 * `report/signing.ts` owns the encoder for the same reason this owns the decoder — neither
 * `@jinn-network/trust-core` nor this package's dependency allow-list carries a base58 library, and
 * `DidKeySchema` there validates the spelling only, never the multicodec payload.
 *
 * A malformed identifier returns `undefined` rather than throwing. Every caller here is asking a
 * question about a value some other party wrote, and "this is not an Ed25519 did:key" is an answer,
 * not an exception.
 */

import { createHash, createPublicKey, type KeyObject } from "node:crypto";

/** Bitcoin base58 alphabet, matching `trust-core`'s `DidKeySchema` character class exactly. */
const BASE58_ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

const ED25519_MULTICODEC_PREFIX = Uint8Array.of(0xed, 0x01);

/**
 * The longest base58btc spelling the 34 payload bytes can have: 34 bytes is 272 bits, and each
 * base58 digit carries log2(58) of them, so 47 digits is the ceiling (the prefix byte is 0xed, so
 * there are never leading zero bytes to add `1` characters for).
 *
 * Checked BEFORE decoding rather than after, because base58 decoding is quadratic in its input and
 * a binding document is something a publisher hands a reader. A megabyte-long identifier would
 * otherwise spend minutes of the reader's CPU on its way to the same `undefined`.
 */
const MAX_BASE58_PAYLOAD_LENGTH = 47;

function base58btcDecode(text: string): Uint8Array | undefined {
  let value = 0n;
  for (const character of text) {
    const digit = BASE58_ALPHABET.indexOf(character);
    if (digit < 0) return undefined;
    value = value * 58n + BigInt(digit);
  }
  const digits: number[] = [];
  while (value > 0n) {
    digits.unshift(Number(value % 256n));
    value /= 256n;
  }
  let leadingZeros = 0;
  while (leadingZeros < text.length && text[leadingZeros] === "1") leadingZeros += 1;
  return Uint8Array.from([...new Array<number>(leadingZeros).fill(0), ...digits]);
}

/** The raw 32 Ed25519 public-key bytes a `did:key:z…` carries, or `undefined` for anything else. */
export function ed25519PublicKeyBytesFromDidKey(keyId: string): Uint8Array | undefined {
  if (!keyId.startsWith("did:key:z")) return undefined;
  const payload = keyId.slice("did:key:z".length);
  if (payload.length > MAX_BASE58_PAYLOAD_LENGTH) return undefined;
  const decoded = base58btcDecode(payload);
  if (decoded === undefined || decoded.length !== ED25519_MULTICODEC_PREFIX.length + 32) return undefined;
  if (!ED25519_MULTICODEC_PREFIX.every((byte, index) => decoded[index] === byte)) return undefined;
  return decoded.slice(ED25519_MULTICODEC_PREFIX.length);
}

/**
 * A `node:crypto` public key for that identifier. The 32 raw bytes are wrapped in the fixed 12-byte
 * Ed25519 SPKI prefix rather than hand-built ASN.1: the prefix is constant for the algorithm, so
 * there is nothing to encode per key.
 */
export function ed25519PublicKeyFromDidKey(keyId: string): KeyObject | undefined {
  const raw = ed25519PublicKeyBytesFromDidKey(keyId);
  if (raw === undefined) return undefined;
  const spki = Buffer.concat([
    Buffer.from("302a300506032b6570032100", "hex"),
    Buffer.from(raw),
  ]);
  try {
    return createPublicKey({ key: spki, format: "der", type: "spki" });
  } catch {
    return undefined;
  }
}

/**
 * `sha256:<64 hex>` over the raw public-key bytes — the bare fingerprint a reader falls back to
 * when no domain is bound. It digests the KEY, not the identifier that spells it, so it is the same
 * value for the same key in every bundle format this reader understands.
 */
export function keyFingerprintFromDidKey(keyId: string): string | undefined {
  const raw = ed25519PublicKeyBytesFromDidKey(keyId);
  if (raw === undefined) return undefined;
  return `sha256:${createHash("sha256").update(raw).digest("hex")}`;
}
