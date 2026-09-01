// SPDX-License-Identifier: Apache-2.0
/**
 * Ed25519 and `did:key` primitives for the process composition roots (C7 host
 * adapter layer, alongside `session-host-signer.ts`).
 *
 * The runtime library implements no cryptography and resolves no keys — that
 * is why `DsseChainVerifier`, `VerifyDriver` and the rest arrive as injected
 * ports. Something still has to be the thing they are injected FROM, and this
 * is it: the host adapter, outside the library, where a real curve and a real
 * key encoding may be named.
 *
 * Everything here handles PUBLIC keys only. Private key material stays in
 * `session-host-signer.ts`, which is the sole file the plugin-tree custody
 * guard exempts from its key-material canary.
 */

import { createPublicKey, verify, type KeyObject } from "node:crypto";

import { dssePreAuthEncoding, parseDsseEnvelope, type DsseChainVerifier } from "@jinn-network/trust-core";

const BASE58_ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

/** multicodec `ed25519-pub`, varint-encoded: the two bytes a did:key's payload starts with. */
const ED25519_MULTICODEC = Object.freeze([0xed, 0x01]);

const ED25519_RAW_LENGTH = 32;

/**
 * The fixed SPKI DER preamble for an Ed25519 public key (RFC 8410
 * `AlgorithmIdentifier` + BIT STRING header). Node's `createPublicKey` has no
 * raw-Ed25519 import, so the 32 raw bytes are wrapped into the one DER shape
 * it does accept. Constant because the encoding is: a fixed-length key under a
 * fixed OID has no variable-length fields left to encode.
 */
const ED25519_SPKI_PREFIX = Uint8Array.from([
  0x30, 0x2a, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x03, 0x21, 0x00,
]);

function base58Encode(bytes: Uint8Array): string {
  let leadingZeros = 0;
  while (leadingZeros < bytes.length && bytes[leadingZeros] === 0) leadingZeros += 1;
  let value = 0n;
  for (const byte of bytes) value = (value << 8n) | BigInt(byte);
  let encoded = "";
  while (value > 0n) {
    encoded = BASE58_ALPHABET[Number(value % 58n)] + encoded;
    value /= 58n;
  }
  return "1".repeat(leadingZeros) + encoded;
}

/**
 * The longest base58 spelling a 34-byte payload (multicodec + raw key) can
 * have. Checked BEFORE decoding because the decode is BigInt work quadratic in
 * the input length, and every caller here only ever wants that one length —
 * so a longer string is not a key that might still decode, it is a key that
 * cannot, and spending the quadratic to learn so is pure waste.
 */
const MAX_ED25519_DID_KEY_BASE58_LENGTH = 64;

/** Returns `undefined` for anything outside the alphabet rather than guessing at intent. */
function base58Decode(text: string): Uint8Array | undefined {
  if (text.length === 0) return undefined;
  if (text.length > MAX_ED25519_DID_KEY_BASE58_LENGTH) return undefined;
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

/** The encode direction, for hosts and tests that hold a key and need its published spelling. */
export function didKeyFromEd25519PublicKey(publicKey: KeyObject): string {
  const jwk = publicKey.export({ format: "jwk" }) as { readonly x?: string };
  if (typeof jwk.x !== "string") {
    throw new Error("Ed25519 public key JWK export is missing its x coordinate");
  }
  const raw = new Uint8Array(Buffer.from(jwk.x, "base64url"));
  if (raw.length !== ED25519_RAW_LENGTH) {
    throw new Error(`Ed25519 public key must be ${String(ED25519_RAW_LENGTH)} raw bytes`);
  }
  return `did:key:z${base58Encode(Uint8Array.from([...ED25519_MULTICODEC, ...raw]))}`;
}

/**
 * The decode direction: a `did:key` carries its own key, so a runtime that
 * knows WHICH did:key may sign for an agent needs no separate key table.
 *
 * Never throws. A malformed spelling, a non-Ed25519 multicodec, or a wrong
 * length is an absent key, not an exception — every caller here is on a
 * fail-closed verification path where "no key" is already the safe answer, and
 * a throw would only turn a refusal into an outage.
 */
export function decodeEd25519DidKey(didKey: string): KeyObject | undefined {
  if (!didKey.startsWith("did:key:z")) return undefined;
  const decoded = base58Decode(didKey.slice("did:key:z".length));
  if (decoded === undefined) return undefined;
  if (decoded.length !== ED25519_MULTICODEC.length + ED25519_RAW_LENGTH) return undefined;
  if (!ED25519_MULTICODEC.every((byte, index) => decoded[index] === byte)) return undefined;

  const spki = new Uint8Array(ED25519_SPKI_PREFIX.length + ED25519_RAW_LENGTH);
  spki.set(ED25519_SPKI_PREFIX, 0);
  spki.set(decoded.subarray(ED25519_MULTICODEC.length), ED25519_SPKI_PREFIX.length);
  try {
    return createPublicKey({ key: Buffer.from(spki), format: "der", type: "spki" });
  } catch {
    return undefined;
  }
}

/** Fail-closed Ed25519 verification against a key the `did:key` itself carries. */
export function verifyEd25519(
  signedBytes: Uint8Array,
  signature: Uint8Array,
  didKey: string,
): boolean {
  const publicKey = decodeEd25519DidKey(didKey);
  if (publicKey === undefined) return false;
  try {
    return verify(null, Buffer.from(signedBytes), publicKey, Buffer.from(signature));
  } catch {
    return false;
  }
}

/**
 * The real `DsseChainVerifier` the trust-policy chain is read through.
 *
 * Reports a keyid only when that signature verifies against the key its own
 * `did:key` encodes — so an envelope cannot name a signer it has not actually
 * produced a signature for. A signature with no keyid resolves to no key and
 * is therefore ignored, which is the same fail-closed answer as a bad one.
 */
export function createDidKeyDsseVerifier(): DsseChainVerifier {
  return (envelopeBytes) => {
    let parsed;
    try {
      parsed = parseDsseEnvelope(envelopeBytes);
    } catch {
      return { validSignerKeyids: [] };
    }
    const preAuthEncoding = dssePreAuthEncoding(parsed.payloadType, parsed.payloadBytes);
    return {
      validSignerKeyids: parsed.signatures.flatMap((signature) => {
        const keyid = signature.keyid;
        if (keyid === undefined) return [];
        const bytes = Buffer.from(signature.sig, "base64");
        return verifyEd25519(preAuthEncoding, new Uint8Array(bytes), keyid) ? [keyid] : [];
      }),
    };
  };
}
