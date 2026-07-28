import { describe, expect, test } from "vitest";
import { avgAtOne, passAtK } from "./pass-at-k.js";

describe("passAtK (Chen 2021 unbiased estimator)", () => {
  test("k=n, c=n: certain (the only possible k-subset is everything)", () => {
    expect(passAtK(3, 3, 3)).toBe(1);
  });

  test("k=n, c=0: impossible (the only possible k-subset is all-fail)", () => {
    expect(passAtK(3, 0, 3)).toBe(0);
  });

  test("k=1 reduces to the plain success rate c/n", () => {
    expect(passAtK(3, 2, 1)).toBeCloseTo(2 / 3, 12);
    expect(passAtK(3, 1, 1)).toBeCloseTo(1 / 3, 12);
    expect(passAtK(10, 7, 1)).toBeCloseTo(0.7, 12);
  });

  test("c=0: zero probability of a pass appearing in any k-sized subset", () => {
    expect(passAtK(5, 0, 2)).toBe(0);
  });

  test("c=n: certain (every replicate passed)", () => {
    expect(passAtK(5, 5, 3)).toBe(1);
  });

  test("n-c < k: certain (fewer failures than k, so any k-subset includes a pass)", () => {
    expect(passAtK(3, 2, 2)).toBe(1); // n-c=1 < k=2
  });

  test("hand-computable case: n=3, c=1, k=2 -> 1 - C(2,2)/C(3,2) = 1 - 1/3 = 2/3", () => {
    expect(passAtK(3, 1, 2)).toBeCloseTo(2 / 3, 12);
  });

  test("hand-computable case: n=3, c=2, k=2 -> 1 - C(1,2)/C(3,2) = 1 - 0/3 = 1", () => {
    expect(passAtK(3, 2, 2)).toBe(1);
  });

  test("is monotone non-decreasing in c for fixed n, k", () => {
    const values = [0, 1, 2, 3, 4, 5].map((c) => passAtK(5, c, 2));
    for (let i = 1; i < values.length; i += 1) expect(values[i]).toBeGreaterThanOrEqual(values[i - 1]!);
  });

  test("rejects invalid arguments", () => {
    expect(() => passAtK(3, 4, 1)).toThrow();
    expect(() => passAtK(3, -1, 1)).toThrow();
    expect(() => passAtK(3, 1, 0)).toThrow();
  });
});

describe("avgAtOne", () => {
  test("is the plain success rate", () => {
    expect(avgAtOne(3, 2)).toBeCloseTo(2 / 3, 12);
    expect(avgAtOne(3, 1)).toBeCloseTo(1 / 3, 12);
  });

  test("rejects n<=0", () => {
    expect(() => avgAtOne(0, 0)).toThrow();
  });
});
