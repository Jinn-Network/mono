// SPDX-License-Identifier: Apache-2.0

/**
 * A test-only DER encoder, sharing the reader's byte vocabulary.
 *
 * The anchor-evidence design §11 requires the conformance kit's proofs to be
 * minted by a kit-only fixture authority rather than captured from a real one,
 * so the kit needs an encoder. `trust-core` ships the reader (`decodeDer`,
 * `decodeDerChildren`, `encodeDerElement`, `retagDerElement`, `encodeOid`) and
 * this module builds on exactly those primitives -- there is no second length
 * codec and no second OID codec anywhere in the tree.
 *
 * **Self-validation discipline.** Every constructed builder here parses what it
 * just assembled through the reader and asserts the structure it intended:
 * the identifier octet is the one asked for, and the children tile the content
 * exactly, one per part. A silent encoding mistake therefore becomes a loud
 * failure at the assembly site rather than an opaque `invalid` three call sites
 * later, in a fixture whose whole job is to be trusted. The single deliberate
 * exception is `derIndefiniteLength`, which exists to produce the BER encoding
 * §6.1's parsing discipline refuses -- round-tripping it through a reader that
 * (correctly) refuses it is not possible, and that is the point.
 *
 * Because the encoder shares the reader's primitives, a kit-minted token cannot
 * be treated as independent evidence that the reader is right; §11 closes that
 * with a one-time cross-validation against an independent RFC 3161 verifier,
 * recorded in `fixtures/anchor-kit-v1/cross-validation.md`.
 *
 * Test-only: nothing in this module is a production encoder, and no production
 * package imports it.
 */

import {
  DER_TAG,
  decodeDer,
  decodeDerChildren,
  encodeDerElement,
  encodeOid,
  retagDerElement,
} from "@jinn-network/trust-core";
import type { DerElement } from "@jinn-network/trust-core";

/** Context-class, constructed identifier octet for `[n]`. */
export function contextConstructed(tagNumber: number): number {
  assertTagNumber(tagNumber);
  return 0xa0 | tagNumber;
}

/** Context-class, primitive identifier octet for `[n]`. */
export function contextPrimitive(tagNumber: number): number {
  assertTagNumber(tagNumber);
  return 0x80 | tagNumber;
}

function assertTagNumber(tagNumber: number): void {
  if (!Number.isInteger(tagNumber) || tagNumber < 0 || tagNumber > 30) {
    throw new Error(`Context tag number ${tagNumber} is outside the low-tag-number form (0..30).`);
  }
}

export function concatenateBytes(parts: readonly Uint8Array[]): Uint8Array {
  const total = parts.reduce((sum, part) => sum + part.length, 0);
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    bytes.set(part, offset);
    offset += part.length;
  }
  return bytes;
}

/**
 * Parses assembled bytes back through the reader and asserts the structure the
 * builder intended. Returns the decoded element so callers can assert further.
 */
export function assertDerRoundTrip(
  bytes: Uint8Array,
  expected?: { readonly identifier?: number; readonly childCount?: number },
): DerElement {
  let element: DerElement;
  try {
    element = decodeDer(bytes);
  } catch (cause) {
    throw new Error(
      `Assembled DER does not parse: ${cause instanceof Error ? cause.message : String(cause)}`,
      { cause },
    );
  }
  if (expected?.identifier !== undefined && element.identifier !== expected.identifier) {
    throw new Error(
      `Assembled DER has identifier 0x${element.identifier.toString(16)}, expected 0x${expected.identifier.toString(16)}.`,
    );
  }
  if (expected?.childCount !== undefined) {
    const children = decodeDerChildren(element);
    if (children.length !== expected.childCount) {
      throw new Error(
        `Assembled DER has ${children.length} child element(s), expected ${expected.childCount}.`,
      );
    }
  }
  return element;
}

/** One DER element from an identifier octet and content octets, round-tripped. */
export function derElement(identifier: number, content: Uint8Array): Uint8Array {
  const bytes = encodeDerElement(identifier, content);
  assertDerRoundTrip(bytes, { identifier });
  return bytes;
}

/** One constructed DER element whose content is the concatenation of complete
 * TLV parts; the round-trip asserts the parts tile the content exactly. */
function derConstructed(identifier: number, parts: readonly Uint8Array[]): Uint8Array {
  const bytes = encodeDerElement(identifier, concatenateBytes(parts));
  assertDerRoundTrip(bytes, { identifier, childCount: parts.length });
  return bytes;
}

export function derSequence(...parts: readonly Uint8Array[]): Uint8Array {
  return derConstructed(DER_TAG.SEQUENCE, parts);
}

/**
 * A SET whose components are given in the order the caller wants them. Use this
 * for an ASN.1 `SET` (whose DER order is by tag, decided by the type) and for
 * negative fixtures that deliberately mis-order a `SET OF`; use `derSetOf` for
 * a conformant `SET OF`.
 */
export function derSet(...parts: readonly Uint8Array[]): Uint8Array {
  return derConstructed(DER_TAG.SET, parts);
}

/**
 * A `SET OF` in DER order. X.690 §11.6: the component encodings appear in
 * ascending order, compared as octet strings with the shorter padded at its
 * trailing end with zero octets. CMS `SignedAttributes` is a `SET OF`, and an
 * unsorted one would not survive re-encoding by any conformant verifier -- the
 * signature covers the sorted form or it covers nothing.
 */
export function derSetOf(...parts: readonly Uint8Array[]): Uint8Array {
  return derConstructed(DER_TAG.SET, [...parts].sort(compareSetOfEncodings));
}

export function compareSetOfEncodings(left: Uint8Array, right: Uint8Array): number {
  const length = Math.max(left.length, right.length);
  for (let index = 0; index < length; index += 1) {
    const leftOctet = index < left.length ? left[index]! : 0;
    const rightOctet = index < right.length ? right[index]! : 0;
    if (leftOctet !== rightOctet) return leftOctet < rightOctet ? -1 : 1;
  }
  return 0;
}

export function derOid(dotted: string): Uint8Array {
  return derElement(DER_TAG.OBJECT_IDENTIFIER, encodeOid(dotted));
}

export function derNull(): Uint8Array {
  return derElement(DER_TAG.NULL, new Uint8Array(0));
}

export function derBoolean(value: boolean): Uint8Array {
  return derElement(DER_TAG.BOOLEAN, Uint8Array.of(value ? 0xff : 0x00));
}

export function derOctetString(content: Uint8Array): Uint8Array {
  return derElement(DER_TAG.OCTET_STRING, content);
}

export function derBitString(content: Uint8Array, unusedBits = 0): Uint8Array {
  if (!Number.isInteger(unusedBits) || unusedBits < 0 || unusedBits > 7) {
    throw new Error(`A BIT STRING declares 0..7 unused bits, not ${unusedBits}.`);
  }
  return derElement(DER_TAG.BIT_STRING, concatenateBytes([Uint8Array.of(unusedBits), content]));
}

/** Minimal two's-complement INTEGER content octets for a non-negative value. */
export function integerContentOctets(value: bigint): Uint8Array {
  if (value < 0n) throw new Error("The kit encodes only non-negative INTEGERs.");
  if (value === 0n) return Uint8Array.of(0x00);
  const octets: number[] = [];
  for (let rest = value; rest > 0n; rest >>= 8n) octets.unshift(Number(rest & 0xffn));
  if ((octets[0]! & 0x80) !== 0) octets.unshift(0x00);
  return Uint8Array.from(octets);
}

export function derInteger(value: bigint | number): Uint8Array {
  return derElement(DER_TAG.INTEGER, integerContentOctets(BigInt(value)));
}

/** An INTEGER from exact content octets -- what a fixed serial number needs,
 * since a serial is a byte string in every comparison that matters. */
export function derIntegerFromContent(content: Uint8Array): Uint8Array {
  return derElement(DER_TAG.INTEGER, content);
}

function derAsciiString(identifier: number, value: string): Uint8Array {
  const content = new Uint8Array(value.length);
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code > 0x7e || code < 0x20) {
      throw new Error(`"${value}" carries a non-printable-ASCII character at ${index}.`);
    }
    content[index] = code;
  }
  return derElement(identifier, content);
}

export const DER_TAG_UTF8_STRING = 0x0c;
export const DER_TAG_PRINTABLE_STRING = 0x13;
export const DER_TAG_IA5_STRING = 0x16;

export function derUtf8String(value: string): Uint8Array {
  return derElement(DER_TAG_UTF8_STRING, new TextEncoder().encode(value));
}

export function derPrintableString(value: string): Uint8Array {
  return derAsciiString(DER_TAG_PRINTABLE_STRING, value);
}

export function derIa5String(value: string): Uint8Array {
  return derAsciiString(DER_TAG_IA5_STRING, value);
}

/**
 * A GeneralizedTime carrying exactly the string given. The string is **not**
 * checked against §6.1 rule 11 -- the kit's malformed-`genTime` fixtures
 * (trailing fractional zeros, missing Zulu, missing seconds) exist precisely to
 * be refused downstream, so validating here would make them unbuildable.
 */
export function derGeneralizedTime(value: string): Uint8Array {
  return derAsciiString(DER_TAG.GENERALIZED_TIME, value);
}

/** A UTCTime carrying exactly the string given (`YYMMDDHHMMSSZ`). RFC 5280
 * requires UTCTime for certificate validity dates through 2049. */
export function derUtcTime(value: string): Uint8Array {
  return derAsciiString(DER_TAG.UTC_TIME, value);
}

/** `[n] EXPLICIT` -- a constructed context element wrapping complete TLVs. */
export function derExplicit(tagNumber: number, ...parts: readonly Uint8Array[]): Uint8Array {
  return derConstructed(contextConstructed(tagNumber), parts);
}

/** `[n] IMPLICIT` over a constructed type: the type's own tag is replaced. */
export function derImplicitConstructed(
  tagNumber: number,
  ...parts: readonly Uint8Array[]
): Uint8Array {
  return derConstructed(contextConstructed(tagNumber), parts);
}

/** `[n] IMPLICIT` over a primitive type: the content octets travel unchanged. */
export function derImplicitPrimitive(tagNumber: number, content: Uint8Array): Uint8Array {
  return derElement(contextPrimitive(tagNumber), content);
}

/**
 * Re-tags a complete element under a new identifier octet, through the reader's
 * own `retagDerElement`.
 *
 * This is the encoder's half of §6.1 rule 8: the token carries `signedAttrs`
 * under an IMPLICIT `[0]` tag, and the signature covers the same content octets
 * re-encoded with an explicit `SET OF` tag. Producing both from one element,
 * through the function the rule engine will use, is what keeps the fixture and
 * the rule from disagreeing about which bytes were signed.
 */
export function retagAsSetOf(elementBytes: Uint8Array): Uint8Array {
  return retagDer(elementBytes, DER_TAG.SET);
}

/** Re-tags a complete element under any identifier octet -- the same mechanical
 * operation `retagAsSetOf` performs, used wherever an IMPLICIT tag replaces a
 * type's own (CMS carries `signedAttrs` as `[0] IMPLICIT`). */
export function retagDer(elementBytes: Uint8Array, identifier: number): Uint8Array {
  const bytes = retagDerElement(decodeDer(elementBytes), identifier);
  assertDerRoundTrip(bytes, { identifier });
  return bytes;
}

/**
 * An indefinite-length (BER) constructed element: identifier, `0x80`, content,
 * end-of-contents. §6.1's parsing discipline refuses this encoding, so the kit
 * needs to be able to produce it and the reader must never be able to parse it
 * -- hence no round-trip here.
 */
export function derIndefiniteLength(identifier: number, content: Uint8Array): Uint8Array {
  if ((identifier & 0x20) === 0) {
    throw new Error("Indefinite length is admissible only for constructed encodings.");
  }
  return concatenateBytes([
    Uint8Array.of(identifier, 0x80),
    content,
    Uint8Array.of(0x00, 0x00),
  ]);
}

export function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export function hexToBytes(hex: string): Uint8Array {
  if (hex.length % 2 !== 0 || !/^[0-9a-f]*$/.test(hex)) {
    throw new Error(`"${hex}" is not an even-length lowercase hex string.`);
  }
  const bytes = new Uint8Array(hex.length / 2);
  for (let index = 0; index < bytes.length; index += 1) {
    bytes[index] = Number.parseInt(hex.slice(index * 2, index * 2 + 2), 16);
  }
  return bytes;
}
