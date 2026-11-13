// SPDX-License-Identifier: Apache-2.0

/**
 * The Ed25519 public key inside a `did:key:z…` identifier.
 *
 * A `did:key` for Ed25519 is not a name that points at a key; it *is* the key: multicodec prefix
 * `0xed 0x01` followed by the raw 32 public-key bytes, base58btc-encoded. A reader who has the
 * identifier has the key material, with nothing to look up and nothing to trust. `trust-core`'s
 * `DidKeySchema` validates the spelling only, never the multicodec payload, so the encoder and
 * decoder live here.
 *
 * A malformed identifier returns `undefined` rather than throwing. Every decoding caller is asking
 * a question about a value some other party wrote, and "this is not an Ed25519 did:key" is an
 * answer, not an exception. Encoding is the opposite: a caller holds the key, so a key of the wrong
 * type is the caller's error and throws.
 */

import { createPublicKey, type KeyObject } from "node:crypto";

/** Bitcoin base58 alphabet, matching `trust-core`'s `DidKeySchema` character class exactly. */
const BASE58_ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

const ED25519_MULTICODEC_PREFIX = Uint8Array.of(0xed, 0x01);

/**
 * The longest base58btc spelling the 34 payload bytes can have: 34 bytes is 272 bits, and each
 * base58 digit carries log2(58) of them, so 47 digits is the ceiling (the prefix byte is 0xed, so
 * there are never leading zero bytes to add `1` characters for).
 *
 * Checked BEFORE decoding rather than after, because base58 decoding is quadratic in its input and
 * a record is something a publisher hands a reader. A megabyte-long identifier would otherwise
 * spend minutes of the reader's CPU on its way to the same `undefined`.
 */
const MAX_BASE58_PAYLOAD_LENGTH = 47;

function base58btcEncode(bytes: Uint8Array): string {
  let value = 0n;
  for (const byte of bytes) value = (value << 8n) | BigInt(byte);
  let text = "";
  while (value > 0n) {
    text = BASE58_ALPHABET[Number(value % 58n)] + text;
    value /= 58n;
  }
  return text;
}

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

/**
 * The `did:key` of an Ed25519 public key.
 *
 * The key type is checked rather than inferred from the JWK: a P-256 key's `x` coordinate is also
 * 32 bytes, so without the check it would come back spelled as an Ed25519 identifier it does not
 * control.
 */
export function didKeyFromEd25519PublicKey(publicKey: KeyObject): string {
  if (publicKey.asymmetricKeyType !== "ed25519") {
    throw new Error(`did:key derivation needs an Ed25519 public key, got ${publicKey.asymmetricKeyType ?? publicKey.type}`);
  }
  const { x } = publicKey.export({ format: "jwk" });
  const raw = Buffer.from(x!, "base64url");
  return `did:key:z${base58btcEncode(new Uint8Array([...ED25519_MULTICODEC_PREFIX, ...raw]))}`;
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
