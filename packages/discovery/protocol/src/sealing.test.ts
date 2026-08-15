import { describe, it, expect } from "vitest";
import { sealJson } from "./sealing.js";

describe("sealJson", () => {
  it("is key-order-insensitive (JCS) and pins the digest", () => {
    const a = sealJson({ b: 1, a: 2 });
    const b = sealJson({ a: 2, b: 1 });
    expect(a.digest).toBe(b.digest);
    expect(new TextDecoder().decode(a.bytes)).toBe('{"a":2,"b":1}');
    expect(a.digest).toMatch(/^sha256:[a-f0-9]{64}$/);
  });

  it("rejects non-canonicalizable values", () => {
    expect(() => sealJson(() => 0)).toThrow();
  });

  // Program ruling §7.14: object keys are sorted by explicit iteration, never
  // by trusting JS's own property-enumeration order -- integer-like string
  // keys ("2", "10") enumerate numerically under native object semantics and
  // would diverge from JCS's UTF-16 code-unit order ("10" < "2").
  it("orders integer-like keys by UTF-16 code unit, not numeric value", () => {
    const sealed = sealJson({ "10": 1, "2": 2 });
    expect(new TextDecoder().decode(sealed.bytes)).toBe('{"10":1,"2":2}');
  });

  // Program ruling §7.14: every sealer rejects numbers that are not exactly
  // representable I-JSON integers -- fractional quantities must be encoded
  // as strings by the caller instead.
  it("rejects fractional numbers", () => {
    expect(() => sealJson({ weight: 1.5 })).toThrow();
  });

  it("rejects non-safe-integer numbers", () => {
    expect(() => sealJson({ n: Number.MAX_SAFE_INTEGER + 2 })).toThrow();
  });

  it("rejects NaN and Infinity", () => {
    expect(() => sealJson({ n: Number.NaN })).toThrow();
    expect(() => sealJson({ n: Number.POSITIVE_INFINITY })).toThrow();
  });

  it("accepts exact safe-integer numbers", () => {
    const sealed = sealJson({ n: 42 });
    expect(new TextDecoder().decode(sealed.bytes)).toBe('{"n":42}');
  });

  it("rejects sparse and nested sparse arrays", () => {
    expect(() => sealJson(Array(2))).toThrow();
    expect(() => sealJson({ nested: [Array(1)] })).toThrow();
  });

  it("rejects undefined at root and in objects or arrays", () => {
    for (const value of [undefined, { value: undefined }, [undefined]]) {
      expect(() => sealJson(value)).toThrow();
    }
  });

  it("rejects unsupported function, symbol, and bigint values", () => {
    for (const value of [
      () => undefined,
      Symbol("unsupported"),
      1n,
      { value: () => undefined },
      { value: Symbol("unsupported") },
    ]) {
      expect(() => sealJson(value)).toThrow();
    }
  });

  it("rejects unpaired UTF-16 surrogates in string values and object keys", () => {
    for (const value of [
      { value: "\ud800" },
      { value: "\udc00" },
      { ["\ud800"]: "value" },
      { ["\udc00"]: "value" },
    ]) {
      expect(() => sealJson(value)).toThrow();
    }
  });

  it("accepts valid supplementary-plane Unicode", () => {
    expect(new TextDecoder().decode(sealJson({ emoji: "😀" }).bytes)).toBe(
      '{"emoji":"😀"}',
    );
    expect(new TextDecoder().decode(sealJson({ ["😀"]: "ok" }).bytes)).toBe(
      '{"😀":"ok"}',
    );
  });
});
