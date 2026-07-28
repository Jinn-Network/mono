import { describe, expect, test } from "vitest";
import canonicalize from "canonicalize";
import { serializeCanonicalJson } from "./canonical.js";
import { IJsonNumberError } from "./json.js";

const decode = (b: Uint8Array) => new TextDecoder().decode(b);

describe("serializeCanonicalJson", () => {
  test("is insensitive to source key order", () => {
    const a = serializeCanonicalJson({ b: 1, a: 2 });
    const b = serializeCanonicalJson({ a: 2, b: 1 });
    expect(decode(a)).toBe(decode(b));
  });
  test("sorts keys by UTF-16 code unit", () => {
    expect(decode(serializeCanonicalJson({ a: 1, Z: 2 }))).toBe('{"Z":2,"a":1}');
  });
  test("orders integer-like keys by code unit, not numerically (§7.14)", () => {
    // '1' (0x31) precedes '2' (0x32) → "10" sorts before "2" by code unit.
    // A naive JSON.stringify over a rebuilt object would emit numeric order ("2","10") — wrong per JCS.
    expect(decode(serializeCanonicalJson({ "10": 1, "2": 2 }))).toBe('{"10":1,"2":2}');
    expect(decode(serializeCanonicalJson({ "10": 1, "2": 2 }))).toBe(canonicalize({ "10": 1, "2": 2 }));
  });
  test("rejects non-I-JSON-integer numbers at sealing", () => {
    expect(() => serializeCanonicalJson({ q: 1.5 })).toThrow(IJsonNumberError);
  });
  test("matches the RFC 8785 reference for the integer-only subset", () => {
    const value = { z: [3, 2, 1], a: { d: 1, c: 2 } };
    expect(decode(serializeCanonicalJson(value))).toBe(canonicalize(value));
  });
});
