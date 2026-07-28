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
