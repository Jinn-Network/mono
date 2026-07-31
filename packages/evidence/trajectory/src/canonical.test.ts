import { describe, expect, test } from "vitest";

import { compareCodeUnitStrings } from "./order.js";
import {
  NonIJsonNumberError,
  NonIJsonStringError,
  UndefinedArrayElementError,
  UnsupportedCanonicalValueError,
  serializeCanonicalJson,
  type JsonValue,
} from "./canonical.js";

const text = (bytes: Uint8Array): string => new TextDecoder().decode(bytes);

describe("canonical JSON", () => {
  test("orders object keys by UTF-16 code unit, not by locale", () => {
    const bytes = serializeCanonicalJson({ b: 1, a: 2, "ä": 3, Z: 4 });
    expect(text(bytes)).toBe('{"Z":4,"a":2,"b":1,"ä":3}');
  });

  test("key-permuted twins serialize to identical bytes", () => {
    const one = serializeCanonicalJson({ alpha: [1, 2], beta: { x: true, y: null } });
    const two = serializeCanonicalJson({ beta: { y: null, x: true }, alpha: [1, 2] });
    expect(text(one)).toBe(text(two));
  });

  test("skips undefined members but rejects undefined array elements", () => {
    expect(text(serializeCanonicalJson({ a: 1, b: undefined }))).toBe('{"a":1}');
    const invalid = { a: [1, undefined] } as unknown as JsonValue;
    expect(() => serializeCanonicalJson(invalid)).toThrow(UndefinedArrayElementError);
  });

  test("rejects non-I-JSON numbers", () => {
    expect(() => serializeCanonicalJson({ a: Number.NaN })).toThrow(NonIJsonNumberError);
    expect(() => serializeCanonicalJson({ a: 1.5 })).toThrow(NonIJsonNumberError);
    expect(() => serializeCanonicalJson({ a: Number.MAX_SAFE_INTEGER + 2 })).toThrow(
      NonIJsonNumberError,
    );
  });

  test("rejects lone surrogates", () => {
    expect(() => serializeCanonicalJson({ a: "\ud800" })).toThrow(NonIJsonStringError);
  });

  test("rejects unsupported runtime-hostile values", () => {
    const cases: unknown[] = [
      undefined,
      1n,
      () => {},
      Symbol("x"),
      new Date(),
      new Map(),
      new Set(),
      new (class Example {})(),
    ];
    for (const value of cases) {
      expect(() => serializeCanonicalJson(value as JsonValue)).toThrow(
        UnsupportedCanonicalValueError,
      );
    }
  });

  test("rejects non-namespaced keys inside namespaced extension objects", () => {
    expect(() =>
      serializeCanonicalJson({
        "network.jinn.note": { bad: 1 },
      }),
    ).toThrow(UnsupportedCanonicalValueError);
  });

  test("compareCodeUnitStrings is a total order without locale sensitivity", () => {
    expect(compareCodeUnitStrings("Z", "a")).toBe(-1);
    expect(compareCodeUnitStrings("a", "a")).toBe(0);
    expect(compareCodeUnitStrings("b", "a")).toBe(1);
  });
});
