import { describe, expect, it } from "vitest";
import { compareCodeUnitStrings } from "../../order.js";
import { compareCodePointStrings } from "./code-point-order.js";

describe("compareCodePointStrings", () => {
  it("orders ASCII strings as code-unit order does", () => {
    const names = ["tests/test_outputs.py", "task.toml", "tests/test.sh", "tests", "tests/"];
    expect([...names].sort(compareCodePointStrings)).toEqual([...names].sort(compareCodeUnitStrings));
    expect([...names].sort(compareCodePointStrings)).toEqual([
      "task.toml",
      "tests",
      "tests/",
      "tests/test.sh",
      "tests/test_outputs.py",
    ]);
  });

  it("returns 0 for equal strings and orders a prefix before the longer string", () => {
    expect(compareCodePointStrings("a", "a")).toBe(0);
    expect(compareCodePointStrings("", "")).toBe(0);
    expect(compareCodePointStrings("a", "ab")).toBe(-1);
    expect(compareCodePointStrings("ab", "a")).toBe(1);
  });

  it("puts a supplementary-plane character after every basic-plane character", () => {
    // By code unit the surrogate d801 sorts before ff21. By code point U+10400 sorts after U+FF21.
    expect(compareCodeUnitStrings("\u{10400}", "Ａ")).toBe(-1);
    expect(compareCodePointStrings("\u{10400}", "Ａ")).toBe(1);
    expect(compareCodePointStrings("Ａ", "\u{10400}")).toBe(-1);
    expect(compareCodePointStrings("a\u{10400}b", "a\u{10400}c")).toBe(-1);
    expect(compareCodePointStrings("\u{10400}", "\u{10400}")).toBe(0);
  });
});
