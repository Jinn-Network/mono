import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { canonicalJsonBytes, sealDocument, compareCodeUnitStrings } from "./index.js";

it("orders by UTF-16 code unit, not locale", () => {
  expect(compareCodeUnitStrings("Z", "a")).toBe(-1); // 'Z'(0x5A) < 'a'(0x61)
});

describe("cross-package sealing equivalence", () => {
  it("reproduces the pinned digest for the key-order-sensitive record", async () => {
    const value = JSON.parse(
      await readFile(new URL("../fixtures/equivalence/key-order-sensitive.json", import.meta.url), "utf8"),
    );
    const expected = JSON.parse(
      await readFile(new URL("../fixtures/equivalence/expected-digests.json", import.meta.url), "utf8"),
    );
    expect(sealDocument(value).digest).toBe(expected["key-order-sensitive.json"]);
    // canonical bytes must be independent of authored key order.
    const shuffled = { alpha: value.alpha, mu: value.mu, zeta: value.zeta };
    expect(canonicalJsonBytes(shuffled)).toEqual(canonicalJsonBytes(value));
  });
});

describe("fail-closed I-JSON sealing", () => {
  it("rejects sparse and nested sparse arrays", () => {
    expect(() => sealDocument(Array(2))).toThrow();
    expect(() => sealDocument({ nested: [Array(1)] })).toThrow();
  });

  it("rejects unsafe integers", () => {
    expect(() => sealDocument({ value: Number.MAX_SAFE_INTEGER + 1 })).toThrow();
  });

  it("rejects undefined at root and in objects or arrays", () => {
    for (const value of [undefined, { value: undefined }, [undefined]]) {
      expect(() => sealDocument(value)).toThrow();
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
      expect(() => sealDocument(value)).toThrow();
    }
  });

  it("rejects unpaired UTF-16 surrogates in string values and object keys", () => {
    for (const value of [
      { value: "\ud800" },
      { value: "\udc00" },
      { ["\ud800"]: "value" },
      { ["\udc00"]: "value" },
    ]) {
      expect(() => sealDocument(value)).toThrow();
    }
  });

  it("accepts valid supplementary-plane Unicode", () => {
    expect(new TextDecoder().decode(sealDocument({ emoji: "😀" }).bytes)).toBe(
      '{"emoji":"😀"}',
    );
    expect(new TextDecoder().decode(sealDocument({ ["😀"]: "ok" }).bytes)).toBe(
      '{"😀":"ok"}',
    );
  });
});
