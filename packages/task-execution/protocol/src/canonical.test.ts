import { describe, expect, test } from "vitest";
import canonicalize from "canonicalize";
import { serializeCanonicalJson } from "./canonical.js";
import { IJsonNumberError, UndefinedArrayElementError, type JsonValue } from "./json.js";

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
    expect(() => serializeCanonicalJson({ q: Number.MAX_SAFE_INTEGER + 1 })).toThrow(
      IJsonNumberError,
    );
  });
  test("matches the RFC 8785 reference for the integer-only subset", () => {
    const value = { z: [3, 2, 1], a: { d: 1, c: 2 } };
    expect(decode(serializeCanonicalJson(value))).toBe(canonicalize(value));
  });

  test("rejects sparse and nested sparse arrays before emission", () => {
    const sparse = Array(2) as unknown as JsonValue;
    const nestedSparse = { nested: [Array(1)] } as unknown as JsonValue;
    expect(() => serializeCanonicalJson(sparse)).toThrow();
    expect(() => serializeCanonicalJson(nestedSparse)).toThrow();
  });

  test("rejects undefined at root and in objects or arrays", () => {
    const cases = [
      undefined,
      { value: undefined },
      [undefined],
    ] as unknown as JsonValue[];
    for (const value of cases) {
      expect(() => serializeCanonicalJson(value)).toThrow();
    }
    expect(
      () => serializeCanonicalJson([undefined] as unknown as JsonValue),
    ).toThrow(UndefinedArrayElementError);
  });

  test("rejects unsupported function, symbol, and bigint values", () => {
    const cases = [
      () => undefined,
      Symbol("unsupported"),
      1n,
      { value: () => undefined },
      { value: Symbol("unsupported") },
    ] as unknown as JsonValue[];
    for (const value of cases) {
      expect(() => serializeCanonicalJson(value)).toThrow();
    }
  });

  test("rejects unpaired UTF-16 surrogates in string values and object keys", () => {
    const cases = [
      { value: "\ud800" },
      { value: "\udc00" },
      { ["\ud800"]: "value" },
      { ["\udc00"]: "value" },
    ] as JsonValue[];
    for (const value of cases) {
      expect(() => serializeCanonicalJson(value)).toThrow();
    }
  });

  test("accepts valid supplementary-plane Unicode", () => {
    expect(decode(serializeCanonicalJson({ emoji: "😀" }))).toBe('{"emoji":"😀"}');
    expect(decode(serializeCanonicalJson({ ["😀"]: "ok" }))).toBe('{"😀":"ok"}');
  });
});
