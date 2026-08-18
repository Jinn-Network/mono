// SPDX-License-Identifier: Apache-2.0

import { describe, expect, test } from "vitest";
import {
  DER_TAG,
  decodeDer,
  decodeDerChildren,
  readDerOid,
} from "@jinn-network/trust-core";

import {
  assertDerRoundTrip,
  bytesToHex,
  compareSetOfEncodings,
  concatenateBytes,
  contextConstructed,
  contextPrimitive,
  derBitString,
  derBoolean,
  derExplicit,
  derGeneralizedTime,
  derImplicitPrimitive,
  derIndefiniteLength,
  derInteger,
  derIntegerFromContent,
  derNull,
  derOctetString,
  derOid,
  derSequence,
  derSet,
  derSetOf,
  derUtcTime,
  derUtf8String,
  hexToBytes,
  integerContentOctets,
  retagAsSetOf,
  retagDer,
} from "./der-encoder.js";

// ---------------------------------------------------------------------------
// The encoder's contract is that everything it emits parses back through the
// reader as the structure it intended -- so these tests are all round-trips
// through `trust-core`'s reader, never byte comparisons against a hand-written
// expectation, except where the byte layout is the thing under test.
// ---------------------------------------------------------------------------

describe("primitive builders", () => {
  test("an OID round-trips through the reader's own codec", () => {
    const bytes = derOid("1.2.840.113549.1.9.16.1.4");
    expect(readDerOid(decodeDer(bytes))).toBe("1.2.840.113549.1.9.16.1.4");
  });

  test("NULL carries no content and BOOLEAN carries the DER spellings", () => {
    expect(decodeDer(derNull()).content.length).toBe(0);
    expect(decodeDer(derBoolean(true)).content[0]).toBe(0xff);
    expect(decodeDer(derBoolean(false)).content[0]).toBe(0x00);
  });

  test("INTEGER content is minimal two's complement with a sign octet where needed", () => {
    expect(bytesToHex(integerContentOctets(0n))).toBe("00");
    expect(bytesToHex(integerContentOctets(1n))).toBe("01");
    expect(bytesToHex(integerContentOctets(127n))).toBe("7f");
    // 128 needs a leading zero so it is not read as negative.
    expect(bytesToHex(integerContentOctets(128n))).toBe("0080");
    expect(bytesToHex(integerContentOctets(256n))).toBe("0100");
    // The reader refuses redundant sign octets, so a non-minimal encoding
    // could not survive the builder's own round-trip.
    expect(() => derIntegerFromContent(hexToBytes("0001"))).toThrow();
  });

  test("BIT STRING carries its unused-bits octet and refuses an out-of-range count", () => {
    const bytes = derBitString(Uint8Array.of(0x80), 7);
    expect(decodeDer(bytes).content[0]).toBe(7);
    expect(() => derBitString(Uint8Array.of(0x80), 8)).toThrow();
  });

  test("a GeneralizedTime carries the exact string, including one no rule admits", () => {
    // Deliberate: the malformed-genTime fixtures could not exist if the
    // encoder validated what the reader is supposed to refuse.
    const bytes = derGeneralizedTime("20260817120000");
    expect(decodeDer(bytes).identifier).toBe(DER_TAG.GENERALIZED_TIME);
    expect(String.fromCharCode(...decodeDer(bytes).content)).toBe("20260817120000");
    expect(String.fromCharCode(...decodeDer(derUtcTime("260101000000Z")).content))
      .toBe("260101000000Z");
  });

  test("a UTF8String encodes beyond ASCII", () => {
    expect(new TextDecoder().decode(decodeDer(derUtf8String("Jinn — anchor")).content))
      .toBe("Jinn — anchor");
  });
});

describe("constructed builders", () => {
  test("a SEQUENCE's children tile its content exactly", () => {
    const bytes = derSequence(derInteger(1), derOid("2.999.1"), derOctetString(Uint8Array.of(9)));
    const children = decodeDerChildren(decodeDer(bytes));
    expect(children.map((child) => child.identifier))
      .toEqual([DER_TAG.INTEGER, DER_TAG.OBJECT_IDENTIFIER, DER_TAG.OCTET_STRING]);
  });

  test("long-form lengths encode above 127 content octets and parse back", () => {
    const long = derOctetString(new Uint8Array(300).fill(0xab));
    const element = decodeDer(long);
    expect(element.content.length).toBe(300);
    // 0x82 announces two length octets: 0x01 0x2c = 300.
    expect(bytesToHex(long.subarray(0, 4))).toBe("0482012c");
  });

  test("SET OF orders components per X.690 11.6, shorter padded with zeros", () => {
    const first = derInteger(1);
    const second = derInteger(2);
    const ordered = derSetOf(second, first);
    const children = decodeDerChildren(decodeDer(ordered));
    expect(children.map((child) => bytesToHex(child.bytes))).toEqual([
      bytesToHex(first),
      bytesToHex(second),
    ]);
    // The padding rule, stated directly: a prefix sorts before its extension.
    expect(compareSetOfEncodings(Uint8Array.of(1), Uint8Array.of(1, 0, 1))).toBe(-1);
    expect(compareSetOfEncodings(Uint8Array.of(1, 0), Uint8Array.of(1))).toBe(0);
  });

  test("a plain SET preserves the caller's order, which SET OF does not", () => {
    const unordered = derSet(derInteger(2), derInteger(1));
    const children = decodeDerChildren(decodeDer(unordered));
    expect(children.map((child) => Number(child.content[0]))).toEqual([2, 1]);
  });

  test("explicit and implicit context tags carry the identifier octets CMS uses", () => {
    const explicitTag = derExplicit(0, derInteger(1));
    expect(decodeDer(explicitTag).identifier).toBe(0xa0);
    expect(decodeDerChildren(decodeDer(explicitTag)).length).toBe(1);

    const implicitPrimitive = derImplicitPrimitive(1, Uint8Array.of(1, 2, 3));
    expect(decodeDer(implicitPrimitive).identifier).toBe(0x81);
    expect(decodeDer(implicitPrimitive).constructed).toBe(false);

    expect(contextConstructed(3)).toBe(0xa3);
    expect(contextPrimitive(2)).toBe(0x82);
    expect(() => contextConstructed(31)).toThrow();
  });
});

describe("re-tagging", () => {
  test("re-tagging preserves content octets exactly, which is what rule 8 needs", () => {
    const attributes = derSetOf(derInteger(1), derInteger(2));
    const implicit = retagDer(attributes, contextConstructed(0));
    expect(decodeDer(implicit).identifier).toBe(0xa0);
    // Round-tripping back to the SET OF tag reproduces the original bytes: the
    // signature covers this form while the token carries the [0] form.
    expect(bytesToHex(retagAsSetOf(implicit))).toBe(bytesToHex(attributes));
    expect(bytesToHex(decodeDer(implicit).content)).toBe(bytesToHex(decodeDer(attributes).content));
  });
});

describe("the deliberate BER escape hatch", () => {
  test("an indefinite-length element is emitted and the reader refuses it", () => {
    const content = concatenateBytes([derInteger(1)]);
    const ber = derIndefiniteLength(DER_TAG.SEQUENCE, content);
    expect(bytesToHex(ber.subarray(0, 2))).toBe("3080");
    expect(bytesToHex(ber.subarray(ber.length - 2))).toBe("0000");
    expect(() => decodeDer(ber)).toThrow(/[Ii]ndefinite/);
    expect(() => derIndefiniteLength(DER_TAG.OCTET_STRING, content)).toThrow();
  });
});

describe("assertDerRoundTrip", () => {
  test("it names the mismatch rather than letting a bad assembly through", () => {
    const bytes = derSequence(derInteger(1));
    expect(assertDerRoundTrip(bytes, { identifier: DER_TAG.SEQUENCE, childCount: 1 }).depth).toBe(0);
    expect(() => assertDerRoundTrip(bytes, { identifier: DER_TAG.SET })).toThrow(/identifier/);
    expect(() => assertDerRoundTrip(bytes, { childCount: 2 })).toThrow(/child element/);
    expect(() => assertDerRoundTrip(Uint8Array.of(0x30, 0x05, 0x02))).toThrow(/does not parse/);
  });

  test("hex helpers are exact in both directions", () => {
    expect(bytesToHex(hexToBytes("00ff10"))).toBe("00ff10");
    expect(() => hexToBytes("0F")).toThrow();
    expect(() => hexToBytes("abc")).toThrow();
  });
});
