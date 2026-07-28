import { describe, expect, test } from "vitest";

import { canonicalJsonBytes } from "./canonical-json.js";

function decode(bytes: Uint8Array): string {
  return new TextDecoder().decode(bytes);
}

describe("canonicalJsonBytes", () => {
  test("is independent of input key order", () => {
    expect(canonicalJsonBytes({ b: 1, a: 2 })).toEqual(
      canonicalJsonBytes({ a: 2, b: 1 }),
    );
  });

  test("orders integer-like string keys by UTF-16 code unit, not numerically (§7.14)", () => {
    // '1' (0x31) < '2' (0x32), so "10" sorts before "2" under code-unit
    // order. A serializer that iterates JS object insertion/numeric-key
    // order instead would emit "2" before "10" and diverge from JCS.
    const bytes = canonicalJsonBytes({ "10": 0, "2": 0 });
    expect(decode(bytes)).toBe('{"10":0,"2":0}');
  });

  test("emits the raw JCS shape: compact separators, no indent, no trailing newline", () => {
    const bytes = canonicalJsonBytes({ b: 1, a: 2 });
    expect(decode(bytes)).toBe('{"a":2,"b":1}');
  });

  test("nests arrays and objects compactly", () => {
    const bytes = canonicalJsonBytes({ list: [3, 1, 2], nested: { z: true, a: null } });
    expect(decode(bytes)).toBe('{"list":[3,1,2],"nested":{"a":null,"z":true}}');
  });

  test("rejects non-finite numbers", () => {
    expect(() => canonicalJsonBytes({ value: Number.POSITIVE_INFINITY })).toThrow();
  });

  test("rejects fractional numbers (§7.14: only exact I-JSON integers seal; fractional quantities are strings)", () => {
    expect(() => canonicalJsonBytes({ weight: 1.5 })).toThrow();
  });

  test("rejects numbers outside the safe-integer range", () => {
    expect(() => canonicalJsonBytes({ value: Number.MAX_SAFE_INTEGER + 1 })).toThrow();
  });

  test("accepts exact safe integers, including negative and zero", () => {
    const bytes = canonicalJsonBytes({ a: 0, b: -1, c: Number.MAX_SAFE_INTEGER });
    expect(decode(bytes)).toBe(`{"a":0,"b":-1,"c":${Number.MAX_SAFE_INTEGER}}`);
  });
});
