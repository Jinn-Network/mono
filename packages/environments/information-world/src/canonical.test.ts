import { describe, expect, test } from "vitest";
import canonicalize from "canonicalize";

import { compareCodeUnitStrings } from "./order.js";
import { IJsonNumberError, IJsonStringError, UndefinedArrayElementError } from "./json.js";
import { serializeCanonicalJson } from "./canonical.js";

const decode = (bytes: Uint8Array): string => new TextDecoder().decode(bytes);

describe("canonical JSON", () => {
  test("orders object keys by UTF-16 code unit, not by locale", () => {
    expect(decode(serializeCanonicalJson({ b: 1, a: 2, "ä": 3, Z: 4 }))).toBe(
      '{"Z":4,"a":2,"b":1,"ä":3}',
    );
  });

  test("key-permuted twins serialize to identical bytes", () => {
    const one = serializeCanonicalJson({ alpha: [1, 2], beta: { x: true, y: null } });
    const two = serializeCanonicalJson({ beta: { y: null, x: true }, alpha: [1, 2] });
    expect(decode(one)).toBe(decode(two));
  });

  test("integer-like keys sort by code unit, not numerically", () => {
    expect(decode(serializeCanonicalJson({ "10": 1, "2": 2 }))).toBe('{"10":1,"2":2}');
  });

  test("agrees byte-for-byte with the RFC 8785 reference implementation", () => {
    const value = {
      kind: "https://spec.jinn.network/records/information-world/v1",
      corpus: { origins: ["https://api.example.test"], entries: [] },
      requestKeyPolicy: { version: "irk1", headerSubset: ["accept"] },
    };
    expect(decode(serializeCanonicalJson(value))).toBe(canonicalize(value));
  });

  test("skips undefined object members but rejects undefined array elements", () => {
    expect(decode(serializeCanonicalJson({ a: 1, b: undefined } as never))).toBe('{"a":1}');
    expect(() => serializeCanonicalJson({ a: [1, undefined] } as never)).toThrow(
      UndefinedArrayElementError,
    );
  });

  test("rejects non-I-JSON numbers", () => {
    expect(() => serializeCanonicalJson({ a: Number.NaN })).toThrow(IJsonNumberError);
    expect(() => serializeCanonicalJson({ a: 1.5 })).toThrow(IJsonNumberError);
    expect(() => serializeCanonicalJson({ a: Number.MAX_SAFE_INTEGER + 2 })).toThrow(
      IJsonNumberError,
    );
  });

  test("rejects lone surrogates in values and in keys", () => {
    expect(() => serializeCanonicalJson({ a: "\ud800" })).toThrow(IJsonStringError);
    expect(() => serializeCanonicalJson({ "\udc00": 1 })).toThrow(IJsonStringError);
  });

  test("compareCodeUnitStrings is a total order without locale sensitivity", () => {
    expect(compareCodeUnitStrings("Z", "a")).toBe(-1);
    expect(compareCodeUnitStrings("a", "a")).toBe(0);
    expect(compareCodeUnitStrings("b", "a")).toBe(1);
  });
});
