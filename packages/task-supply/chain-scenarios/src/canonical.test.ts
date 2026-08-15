// SPDX-License-Identifier: Apache-2.0
import { canonicalJsonBytes as derivationCanonical } from "@jinn-network/task-derivation";
import { describe, expect, it } from "vitest";
import { canonicalJsonBytes } from "./canonical.js";

const CASES: readonly unknown[] = [
  {},
  { b: 1, a: 2 },
  { nested: { z: [1, 2, { y: true, x: null }], a: "" } },
  { "é": "é", "": "empty key" },
  { big: 9007199254740991, small: -9007199254740991, negZero: 0, int: 12345678901234 },
  [1, "two", false, null, { k: "v" }],
];

describe("this package's serializer agrees with the derivation unit's, byte for byte", () => {
  for (const [index, value] of CASES.entries()) {
    it(`case ${index}`, () => {
      expect(canonicalJsonBytes(value as never)).toStrictEqual(derivationCanonical(value as never));
    });
  }
});

describe("canonicalization refuses what JCS cannot represent", () => {
  it("refuses NaN", () => expect(() => canonicalJsonBytes({ n: Number.NaN })).toThrow(/finite/i));
  it("refuses undefined members", () =>
    expect(() => canonicalJsonBytes({ u: undefined } as never)).toThrow(/undefined/i));
  it("refuses bigint", () => expect(() => canonicalJsonBytes({ b: 1n } as never)).toThrow());
});
