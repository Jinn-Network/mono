import { describe, expect, test } from "vitest";

import { TrustCoreError } from "../errors.js";
import {
  DER_MAX_DEPTH,
  DER_TAG,
  decodeDer,
  decodeDerChildren,
  encodeDerElement,
  retagDerElement,
} from "./der.js";

function bytes(...values: readonly number[]): Uint8Array {
  return Uint8Array.from(values);
}

function filler(length: number, value = 0x41): Uint8Array {
  return Uint8Array.from({ length }, () => value);
}

/** `depth` nested SEQUENCEs wrapping a NULL, built through the encoder. */
function nest(depth: number): Uint8Array {
  let inner = bytes(DER_TAG.NULL, 0x00);
  for (let level = 0; level < depth; level += 1) {
    inner = encodeDerElement(DER_TAG.SEQUENCE, inner);
  }
  return inner;
}

function code(run: () => unknown): string {
  try {
    run();
  } catch (cause) {
    return cause instanceof TrustCoreError ? cause.code : `not-a-TrustCoreError:${String(cause)}`;
  }
  return "no-throw";
}

describe("definite-length DER reader", () => {
  test("decodes a short-form SEQUENCE and its children", () => {
    const element = decodeDer(bytes(0x30, 0x05, 0x02, 0x01, 0x05, 0x05, 0x00));
    expect(element.tagClass).toBe("universal");
    expect(element.tagNumber).toBe(16);
    expect(element.constructed).toBe(true);
    expect(element.depth).toBe(0);

    const children = decodeDerChildren(element);
    expect(children.map((child) => child.tagNumber)).toEqual([2, 5]);
    expect(children.map((child) => child.depth)).toEqual([1, 1]);
    expect(children[0]!.content).toEqual(bytes(0x05));
    expect(children[1]!.content).toEqual(new Uint8Array(0));
  });

  test("decodes a one-octet long-form length", () => {
    const content = filler(200);
    const element = decodeDer(bytes(DER_TAG.OCTET_STRING, 0x81, 0xc8, ...content));
    expect(element.content).toEqual(content);
    expect(element.bytes.length).toBe(203);
  });

  test("decodes a two-octet long-form length", () => {
    const content = filler(300);
    const element = decodeDer(bytes(DER_TAG.OCTET_STRING, 0x82, 0x01, 0x2c, ...content));
    expect(element.content.length).toBe(300);
    expect(element.bytes.length).toBe(304);
  });

  test("refuses indefinite-length (0x80) encoding loudly", () => {
    expect(() => decodeDer(bytes(0x30, 0x80, 0x05, 0x00, 0x00, 0x00)))
      .toThrow(/indefinite/i);
    expect(code(() => decodeDer(bytes(0x30, 0x80, 0x05, 0x00, 0x00, 0x00))))
      .toBe("CONFORMANCE_FAILURE");
  });

  test("refuses the reserved 0xff length octet", () => {
    expect(() => decodeDer(bytes(DER_TAG.OCTET_STRING, 0xff, 0x01))).toThrow(/0xff/i);
  });

  test("refuses a long form used for a length below 128", () => {
    expect(() => decodeDer(bytes(DER_TAG.OCTET_STRING, 0x81, 0x05, 1, 2, 3, 4, 5)))
      .toThrow(/minimal/i);
  });

  test("refuses a leading zero length octet", () => {
    expect(() => decodeDer(bytes(DER_TAG.OCTET_STRING, 0x82, 0x00, 0x05, 1, 2, 3, 4, 5)))
      .toThrow(/minimal/i);
  });

  test("refuses a truncated identifier/length header", () => {
    expect(() => decodeDer(bytes(0x30))).toThrow(/truncat/i);
    expect(() => decodeDer(new Uint8Array(0))).toThrow(/truncat/i);
    expect(() => decodeDer(bytes(DER_TAG.OCTET_STRING, 0x82, 0x01))).toThrow(/truncat/i);
  });

  test("refuses content truncated against the declared length", () => {
    expect(() => decodeDer(bytes(0x30, 0x05, 0x02, 0x01))).toThrow(/truncat/i);
  });

  test("refuses trailing bytes after the document element", () => {
    expect(() => decodeDer(bytes(0x02, 0x01, 0x05, 0x00))).toThrow(/trailing/i);
  });

  test("refuses trailing bytes inside a constructed element", () => {
    const element = decodeDer(bytes(0x30, 0x04, 0x02, 0x01, 0x05, 0x05));
    expect(() => decodeDerChildren(element)).toThrow(/truncat/i);
  });

  test("refuses high-tag-number identifiers", () => {
    expect(() => decodeDer(bytes(0x1f, 0x81, 0x00, 0x00))).toThrow(/high-tag-number/i);
  });

  test("decodes primitive and constructed context-specific tags", () => {
    const primitive = decodeDer(bytes(0x80, 0x01, 0x2a));
    expect(primitive.tagClass).toBe("context");
    expect(primitive.tagNumber).toBe(0);
    expect(primitive.constructed).toBe(false);
    expect(primitive.content).toEqual(bytes(0x2a));

    const constructed = decodeDer(bytes(0xa1, 0x03, 0x02, 0x01, 0x05));
    expect(constructed.tagClass).toBe("context");
    expect(constructed.tagNumber).toBe(1);
    expect(constructed.constructed).toBe(true);
    expect(decodeDerChildren(constructed).map((child) => child.tagNumber)).toEqual([2]);
  });

  test("exposes the exact TLV byte slice of a nested element", () => {
    const document = bytes(0x30, 0x05, 0x02, 0x01, 0x05, 0x05, 0x00);
    const [integer, nullElement] = decodeDerChildren(decodeDer(document));
    expect(integer!.bytes).toEqual(bytes(0x02, 0x01, 0x05));
    expect(nullElement!.bytes).toEqual(bytes(0x05, 0x00));
    // The slice is a view over the caller's exact bytes, at the right offset.
    expect(integer!.bytes.buffer).toBe(document.buffer);
    expect(integer!.bytes.byteOffset).toBe(2);
  });

  test("re-tags an implicit [0] constructed element as a universal SET", () => {
    const element = decodeDer(bytes(0xa0, 0x03, 0x02, 0x01, 0x05));
    expect(retagDerElement(element, DER_TAG.SET)).toEqual(bytes(0x31, 0x03, 0x02, 0x01, 0x05));
  });

  test("re-encodes long-form lengths when re-tagging", () => {
    const content = filler(200);
    const element = decodeDer(encodeDerElement(0xa0, content));
    const retagged = retagDerElement(element, DER_TAG.SET);
    expect(retagged.subarray(0, 3)).toEqual(bytes(DER_TAG.SET, 0x81, 0xc8));
    expect(decodeDer(retagged).content).toEqual(content);
  });

  test("refuses encoding a high-tag-number or out-of-range identifier", () => {
    expect(() => encodeDerElement(0x1f, new Uint8Array(0))).toThrow(/high-tag-number/i);
    expect(code(() => encodeDerElement(0x1f, new Uint8Array(0)))).toBe("INVALID_INPUT");
    expect(() => encodeDerElement(256, new Uint8Array(0))).toThrow(/identifier/i);
  });

  test("bounds nesting depth", () => {
    expect(DER_MAX_DEPTH).toBeGreaterThanOrEqual(8);

    let element = decodeDer(nest(6));
    for (let depth = 1; depth <= 3; depth += 1) {
      element = decodeDerChildren(element, { maxDepth: 3 })[0]!;
      expect(element.depth).toBe(depth);
    }
    expect(() => decodeDerChildren(element, { maxDepth: 3 })).toThrow(/depth/i);
    expect(code(() => decodeDerChildren(element, { maxDepth: 3 }))).toBe("CONFORMANCE_FAILURE");
  });

  test("refuses a non-positive depth bound as caller error", () => {
    const element = decodeDer(nest(1));
    expect(code(() => decodeDerChildren(element, { maxDepth: 0 }))).toBe("INVALID_INPUT");
  });

  test("refuses children of a primitive element", () => {
    expect(() => decodeDerChildren(decodeDer(bytes(0x02, 0x01, 0x05)))).toThrow(/constructed/i);
  });

  test("enforces the primitive/constructed shape of universal tags", () => {
    // Constructed OCTET STRING (0x24) is BER, not DER.
    expect(() => decodeDer(bytes(0x24, 0x02, 0x04, 0x00))).toThrow(/primitive/i);
    // Primitive SEQUENCE (0x10) is never valid.
    expect(() => decodeDer(bytes(0x10, 0x00))).toThrow(/constructed/i);
    // NULL carries no content; BOOLEAN carries exactly one octet.
    expect(() => decodeDer(bytes(DER_TAG.NULL, 0x01, 0x00))).toThrow(/NULL/);
    expect(() => decodeDer(bytes(DER_TAG.BOOLEAN, 0x02, 0x00, 0xff))).toThrow(/BOOLEAN/);
    // Universal tag 0 is reserved (end-of-contents only, which is BER).
    expect(() => decodeDer(bytes(0x00, 0x00))).toThrow(/reserved/i);
  });

  test("enforces the DER BOOLEAN value form", () => {
    expect(decodeDer(bytes(DER_TAG.BOOLEAN, 0x01, 0x00)).content).toEqual(bytes(0x00));
    expect(decodeDer(bytes(DER_TAG.BOOLEAN, 0x01, 0xff)).content).toEqual(bytes(0xff));
    // 0x01 is a truthy BER encoding; DER admits only 0x00 and 0xFF.
    expect(() => decodeDer(bytes(DER_TAG.BOOLEAN, 0x01, 0x01))).toThrow(/BOOLEAN/);
    expect(() => decodeDer(bytes(DER_TAG.BOOLEAN, 0x01, 0x7f))).toThrow(/BOOLEAN/);
    expect(code(() => decodeDer(bytes(DER_TAG.BOOLEAN, 0x01, 0x01)))).toBe("CONFORMANCE_FAILURE");
  });

  test("enforces INTEGER minimality and refuses an empty INTEGER", () => {
    // A redundant 0x00 before a byte whose high bit is already clear.
    expect(() => decodeDer(bytes(0x02, 0x02, 0x00, 0x7f))).toThrow(/minimal/i);
    // A redundant 0xFF before a byte whose high bit is already set.
    expect(() => decodeDer(bytes(0x02, 0x02, 0xff, 0x80))).toThrow(/minimal/i);
    // An INTEGER always carries at least one content octet.
    expect(() => decodeDer(bytes(0x02, 0x00))).toThrow(/INTEGER/);
    // 0x00 before a high-bit-set byte is required, not redundant: this is 128.
    expect(decodeDer(bytes(0x02, 0x02, 0x00, 0x80)).content).toEqual(bytes(0x00, 0x80));
    // 0xFF before a high-bit-clear byte is likewise required: this is -129.
    expect(decodeDer(bytes(0x02, 0x02, 0xff, 0x7f)).content).toEqual(bytes(0xff, 0x7f));
  });

  test("enforces BIT STRING shape", () => {
    // The unused-bits octet is mandatory.
    expect(() => decodeDer(bytes(0x03, 0x00))).toThrow(/BIT STRING/);
    // Only 0..7 bits can go unused.
    expect(() => decodeDer(bytes(0x03, 0x02, 0x08, 0xff))).toThrow(/BIT STRING/);
    expect(decodeDer(bytes(0x03, 0x02, 0x00, 0xff)).content).toEqual(bytes(0x00, 0xff));
    expect(decodeDer(bytes(0x03, 0x02, 0x07, 0x80)).content).toEqual(bytes(0x07, 0x80));
  });

  test("refuses non-byte input as caller error", () => {
    expect(code(() => decodeDer([0x05, 0x00] as unknown as Uint8Array))).toBe("INVALID_INPUT");
  });
});
