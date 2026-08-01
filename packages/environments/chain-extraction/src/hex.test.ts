// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import { ChainExtractionError } from "./errors.js";
import { normalizeAddress, normalizeQuantity, normalizeSlot } from "./hex.js";

describe("hex normalization", () => {
  it("lowercases addresses and refuses anything that is not 20 bytes", () => {
    expect(normalizeAddress("0xA0B86991C6218B36C1D19D4A2E9EB0CE3606EB48"))
      .toBe("0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48");
    expect(() => normalizeAddress("0xa0b8")).toThrow(ChainExtractionError);
    expect(() => normalizeAddress("a0b86991c6218b36c1d19d4a2e9eb0ce3606eb48"))
      .toThrow(ChainExtractionError);
  });

  it("left-pads storage slots to 32 bytes so 0x1 and 0x01 are one key", () => {
    expect(normalizeSlot("0x1")).toBe(`0x${"0".repeat(63)}1`);
    expect(normalizeSlot(`0x${"0".repeat(63)}1`)).toBe(`0x${"0".repeat(63)}1`);
  });

  it("normalizes quantities to minimal form, so 0x0 and 0x00 are one value", () => {
    expect(normalizeQuantity("0x00")).toBe("0x0");
    expect(normalizeQuantity("0x0de0b6b3a7640000")).toBe("0xde0b6b3a7640000");
    expect(() => normalizeQuantity("0x")).toThrow(ChainExtractionError);
  });
});
