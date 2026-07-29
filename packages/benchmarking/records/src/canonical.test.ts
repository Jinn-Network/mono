import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";
import canonicalize from "canonicalize";
import { serializeCanonicalJson } from "./canonical.js";
import { IJsonNumberError, UndefinedArrayElementError, type JsonValue } from "./json.js";

const decode = (b: Uint8Array) => new TextDecoder().decode(b);
const loadUnicodeFixture = (name: string): JsonValue => JSON.parse(readFileSync(
  new URL(`../fixtures/equivalence/${name}`, import.meta.url),
  "utf8",
)) as JsonValue;

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

  test("omits object members whose value is undefined (mirrors JSON.stringify member omission)", () => {
    const withUndefined = { a: 1, b: undefined } as unknown as JsonValue;
    const withoutMember = { a: 1 };
    expect(decode(serializeCanonicalJson(withUndefined))).toBe(decode(serializeCanonicalJson(withoutMember)));
    expect(decode(serializeCanonicalJson(withUndefined))).toBe('{"a":1}');
  });

  test("rejects an undefined array element with a typed invalid-document error instead of emitting a literal token", () => {
    const withUndefinedElement = [1, undefined, 2] as unknown as JsonValue;
    expect(() => serializeCanonicalJson(withUndefinedElement)).toThrow(UndefinedArrayElementError);
    try {
      serializeCanonicalJson(withUndefinedElement);
      expect.unreachable();
    } catch (error: unknown) {
      expect((error as { category?: string }).category).toBe("invalid-document");
    }
  });

  test.each([
    ["string value", loadUnicodeFixture("unicode-invalid-value.json")],
    ["object key", loadUnicodeFixture("unicode-invalid-key.json")],
    ["nested string", { nested: ["ok", "\uDFFF"] }],
  ])("rejects an unpaired surrogate in a %s", (_label, value) => {
    expect(() => serializeCanonicalJson(value)).toThrow(/unpaired UTF-16 surrogate/);
  });

  test("accepts and preserves a valid supplementary-plane scalar", () => {
    const value = loadUnicodeFixture("unicode-valid.json");
    expect(decode(serializeCanonicalJson(value))).toBe('{"emoji-🚀":"astral-🧪"}');
  });
});
