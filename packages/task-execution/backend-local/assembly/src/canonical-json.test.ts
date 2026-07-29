import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { NonIntegerNumberError, UndefinedArrayElementError, serializeCanonical, UnpairedSurrogateError } from "./canonical-json.js";

describe("serializeCanonical", () => {
  it("sorts object keys by code unit regardless of insertion order", () => {
    expect(serializeCanonical({ b: 1, a: 2, Z: 3 })).toBe('{"Z":3,"a":2,"b":1}');
  });

  it("is byte-identical across two structurally equal objects", () => {
    expect(serializeCanonical({ a: [3, 2], c: 1 })).toBe(serializeCanonical({ c: 1, a: [3, 2] }));
  });

  // Integer-like string keys iterate numerically in JS object insertion order and would diverge
  // from code-unit order if trusted (program §7.14) — "10" sorts before "2" by code unit.
  it("sorts integer-like keys by code unit, not numeric value", () => {
    expect(serializeCanonical({ 2: "b", 10: "a" })).toBe('{"10":"a","2":"b"}');
  });

  it("omits keys whose value is undefined, mirroring JSON.stringify member omission", () => {
    expect(serializeCanonical({ a: 1, b: undefined })).toBe('{"a":1}');
  });

  it("rejects a non-integer number", () => {
    expect(() => serializeCanonical({ a: 1.5 })).toThrow(NonIntegerNumberError);
  });

  it("rejects an undefined array element", () => {
    expect(() => serializeCanonical([1, undefined, 2])).toThrow(UndefinedArrayElementError);
  });

  it("rejects lone UTF-16 surrogates in recursive keys and values while accepting pairs", () => {
    expect(() => serializeCanonical({ nested: [String.fromCharCode(0xd800)] })).toThrow(UnpairedSurrogateError);
    expect(() => serializeCanonical({ nested: { [String.fromCharCode(0xdc00)]: "ok" } })).toThrow(UnpairedSurrogateError);
    expect(serializeCanonical({ "😀": ["😀"] })).toBe('{"😀":["😀"]}');
  });

  it("serializes nested arrays and objects deterministically", () => {
    expect(serializeCanonical({ list: [{ b: 1, a: 2 }, null, true, false] }))
      .toBe('{"list":[{"a":2,"b":1},null,true,false]}');
  });

  // Cross-package equivalence leg (Global Constraints/plan Finding (b)): every backend-local
  // package independently re-implements this serializer, but must produce byte-identical output
  // for the same record — pinned by sha256 so a drift in any one package's implementation is
  // caught, including an object-key-sort-sensitive record (program §7.14/§16).
  it("matches the cross-package pinned digest for a sort-sensitive record", () => {
    const record = { zebra: 1, apple: [3, 1, 2], "10": "ten", "2": "two", nested: { b: true, a: null } };
    const canonical = serializeCanonical(record);
    expect(canonical).toBe(
      '{"10":"ten","2":"two","apple":[3,1,2],"nested":{"a":null,"b":true},"zebra":1}',
    );
    const digest = createHash("sha256").update(canonical, "utf8").digest("hex");
    expect(digest).toBe("716439609089ec56af65ba7ebf1c66e183a957bdd90cdcf9218fdc3eeafafeed");
  });
});
