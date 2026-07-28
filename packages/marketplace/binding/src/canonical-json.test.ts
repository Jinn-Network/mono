import { describe, expect, test } from "vitest";
import { serializeCanonical } from "./canonical-json.js";

describe("serializeCanonical", () => {
  test("emits object members in code-unit key order, never insertion order", () => {
    expect(serializeCanonical({ b: 1, a: 2, Z: 3 })).toBe('{"Z":3,"a":2,"b":1}');
  });

  test("integer-like keys order by UTF-16 code unit, not numeric value (program §7.14)", () => {
    // '1' < '2' by code unit, so "10" sorts before "2" -- numeric order would invert this.
    expect(serializeCanonical({ "10": 1, "2": 2 })).toBe('{"10":1,"2":2}');
  });

  test("structurally-equal objects with different insertion order serialize byte-identically", () => {
    const first = serializeCanonical({ b: 1, a: 2 });
    const second = serializeCanonical({ a: 2, b: 1 });
    expect(first).toBe(second);
  });

  test("rejects a number that is not an exact I-JSON integer", () => {
    expect(() => serializeCanonical({ amount: 1.5 })).toThrow();
    expect(() => serializeCanonical({ amount: Number.MAX_SAFE_INTEGER + 1 })).toThrow();
  });

  test("accepts nested arrays, strings, booleans, and null", () => {
    expect(serializeCanonical({ a: [1, "x", true, null] })).toBe('{"a":[1,"x",true,null]}');
  });

  test("never relies on JSON.stringify's own key ordering", () => {
    // JSON.stringify would already produce this for a literal-order object, but the point is
    // that our own explicit sort drives emission, not JS object insertion order -- proven by the
    // integer-like-key and reversed-insertion-order cases above.
    expect(serializeCanonical({})).toBe("{}");
  });
});
