import { describe, expect, test } from "vitest";
import { compareCodeUnitStrings } from "./order.js";

describe("compareCodeUnitStrings", () => {
  test("orders by UTF-16 code unit, not host collation", () => {
    // 'Z' (U+005A) precedes 'a' (U+0061) by code unit; many locales invert this.
    expect(compareCodeUnitStrings("Z", "a")).toBe(-1);
    expect(compareCodeUnitStrings("a", "a")).toBe(0);
    expect(compareCodeUnitStrings("b", "a")).toBe(1);
  });
});
