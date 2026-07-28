import { describe, expect, test } from "vitest";
import { wilsonInterval } from "./wilson.js";

describe("wilsonInterval", () => {
  test("scorable=0 returns the degenerate zero interval, never NaN", () => {
    expect(wilsonInterval(0, 0)).toEqual({ p: 0, lo: 0, hi: 0 });
  });

  test("passed=3, scorable=4 matches the closed-form values (fixture ground truth)", () => {
    const interval = wilsonInterval(3, 4);
    expect(interval.p).toBeCloseTo(0.75, 10);
    expect(interval.lo).toBeCloseTo(0.30063605244263664, 10);
    expect(interval.hi).toBeCloseTo(0.9544139373553638, 10);
  });

  test("passed=1, scorable=3 matches the closed-form values", () => {
    const interval = wilsonInterval(1, 3);
    expect(interval.p).toBeCloseTo(1 / 3, 10);
    expect(interval.lo).toBeCloseTo(0.061490315276160515, 10);
    expect(interval.hi).toBeCloseTo(0.7923450448735121, 10);
  });

  test("p=1 (passed=scorable) clamps the upper bound to exactly 1", () => {
    const interval = wilsonInterval(5, 5);
    expect(interval.p).toBe(1);
    expect(interval.hi).toBe(1);
    expect(interval.lo).toBeGreaterThan(0);
    expect(interval.lo).toBeLessThan(1);
  });

  test("p=0 (passed=0) clamps the lower bound to exactly 0", () => {
    const interval = wilsonInterval(0, 5);
    expect(interval.p).toBe(0);
    expect(interval.lo).toBe(0);
    expect(interval.hi).toBeGreaterThan(0);
  });

  test("bounds always contain the point estimate and stay within [0,1]", () => {
    for (const [passed, scorable] of [[1, 10], [9, 10], [50, 100], [1, 1]] as const) {
      const { p, lo, hi } = wilsonInterval(passed, scorable);
      expect(lo).toBeLessThanOrEqual(p);
      expect(hi).toBeGreaterThanOrEqual(p);
      expect(lo).toBeGreaterThanOrEqual(0);
      expect(hi).toBeLessThanOrEqual(1);
    }
  });
});
