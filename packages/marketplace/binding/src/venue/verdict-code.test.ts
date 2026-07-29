import { describe, expect, test } from "vitest";
import { VerdictCode, verdictCodeFromValue } from "./verdict-code.js";

describe("VerdictCode", () => {
  test("carries the four on-chain codes plus None (TaskCoordinator.sol VerdictCode enum)", () => {
    expect(VerdictCode).toEqual({ None: 0, Pass: 1, Fail: 2, Invalid: 3, Unresolved: 4 });
  });
});

describe("verdictCodeFromValue", () => {
  test.each([
    ["PASS", VerdictCode.Pass],
    ["FAIL", VerdictCode.Fail],
    ["INVALID", VerdictCode.Invalid],
    ["UNRESOLVED", VerdictCode.Unresolved],
    ["INDETERMINATE", VerdictCode.Unresolved],
  ])("maps %s -> %i", (raw, expected) => {
    expect(verdictCodeFromValue(raw)).toBe(expected);
  });

  test("refuses to guess Invalid(3) for a missing or unrecognized verdict (envelope-authoritative, no defaulting)", () => {
    expect(() => verdictCodeFromValue(undefined)).toThrow(/missing or unrecognized verdict/);
    expect(() => verdictCodeFromValue("nonsense")).toThrow(/missing or unrecognized verdict/);
  });
});
