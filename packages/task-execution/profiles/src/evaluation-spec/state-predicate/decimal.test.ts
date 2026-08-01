import { describe, expect, it } from "vitest";
import { evaluateVerdictRule } from "../verdict-rule.js";
import {
  compareDecimalExact,
  decodeInt256,
  decodeUint256,
  withinAbsolute,
  withinRelative,
} from "./decimal.js";

describe("exact decimal arithmetic for state predicates", () => {
  it("compares decimal strings exactly via scaled BigInt", () => {
    expect(compareDecimalExact("0.50", "0.5")).toBe(0);
    expect(compareDecimalExact("-1", "0")).toBe(-1);
    expect(
      compareDecimalExact(
        "115792089237316195423570985008687907853269984665640564039457584007913129639935",
        "0",
      ),
    ).toBe(1);
    expect(compareDecimalExact("1e3", "1000")).toBeUndefined();
  });

  it("checks absolute tolerance exactly", () => {
    expect(withinAbsolute("100", "101", "1")).toBe(true);
    expect(withinAbsolute("100", "102", "1")).toBe(false);
  });

  it("checks relative tolerance exactly", () => {
    expect(withinRelative("100", "101", "0.01")).toBe(true);
    expect(withinRelative("100", "102", "0.01")).toBe(false);
  });

  it("decodes 32-byte hex words to decimal strings", () => {
    expect(decodeUint256("0x" + "0".repeat(63) + "a")).toBe("10");
    expect(decodeInt256("0x" + "f".repeat(64))).toBe("-1");
    expect(decodeUint256("0x1234")).toBeUndefined();
  });

  it("agrees with evaluateVerdictRule threshold comparisons", () => {
    const pairs: [string, string][] = [
      ["0.50", "0.5"],
      ["1", "2"],
      ["-3", "-3"],
      ["10", "9.999"],
    ];
    for (const [a, b] of pairs) {
      const cmp = compareDecimalExact(a, b);
      const measurements = { m: a };
      const lt = evaluateVerdictRule(
        { threshold: { measurement: "m", op: "lt", value: b } },
        measurements,
      );
      const gt = evaluateVerdictRule(
        { threshold: { measurement: "m", op: "gt", value: b } },
        measurements,
      );
      const eq = evaluateVerdictRule(
        { threshold: { measurement: "m", op: "eq", value: b } },
        measurements,
      );
      expect(lt.verdict).toBe(cmp !== undefined && cmp < 0 ? "pass" : "fail");
      expect(gt.verdict).toBe(cmp !== undefined && cmp > 0 ? "pass" : "fail");
      expect(eq.verdict).toBe(cmp === 0 ? "pass" : "fail");
    }
  });
});
