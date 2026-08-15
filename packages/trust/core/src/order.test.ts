import { describe, expect, test } from "vitest";
import { compareCodeUnitStrings } from "./order.js";
describe("compareCodeUnitStrings", () => {
  test("orders by UTF-16 code unit, not host collation", () => {
    // 'Z' (0x5A) precedes 'a' (0x61) by code unit; many locales sort 'a' first.
    expect(compareCodeUnitStrings("Z", "a")).toBe(-1);
    expect(compareCodeUnitStrings("a", "a")).toBe(0);
    expect(["b", "A", "Z", "a"].sort(compareCodeUnitStrings)).toEqual(["A", "Z", "a", "b"]);
  });
});
