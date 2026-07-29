import { describe, expect, test } from "vitest";
import {
  nonInferiorityIut,
  nonInferiorityVerdict,
  pairedCostVerdict,
  pairedRateDiffBca,
  pairedRateDiffLowerBound,
  xorshift32,
  clusteredPairedRateDiffBca,
} from "./noninferiority.js";

describe("xorshift32-v1", () => {
  test("pins the exact first five uint32 draws for seed=1", () => {
    const next = xorshift32(1);
    expect(Array.from({ length: 5 }, () => next())).toEqual([
      270369,
      67634689,
      2647435461,
      307599695,
      2398689233,
    ]);
  });

  test.each([0, -1, 1.5, 4_294_967_296])("rejects invalid seed %s", (seed) => {
    expect(() => xorshift32(seed)).toThrow(/nonzero unsigned 32-bit/);
  });
});

describe("pairedRateDiffLowerBound", () => {
  test("zero-variance input (all deltas identical): the bootstrap lower bound is EXACTLY the observed mean, for any seed", () => {
    // Every resample mean is trivially the same constant, so sorting/quantile selection returns
    // that constant regardless of the bias-correction z0/zAlpha adjustment -- a hand-verifiable
    // property, not merely re-running the implementation.
    const rates = [{ pA: 0.5, pB: 0.6 }, { pA: 0.4, pB: 0.5 }, { pA: 0.3, pB: 0.4 }];
    for (const seed of [1, 2, 42]) {
      const bound = pairedRateDiffLowerBound(rates, { seed, resamples: 500 });
      expect(bound).toBeCloseTo(0.1, 12);
    }
  });

  test("rejects an empty sample", () => {
    expect(() => pairedRateDiffLowerBound([], { seed: 1 })).toThrow();
  });

  test("a lower bound never exceeds the observed mean delta", () => {
    const rates = [{ pA: 0.2, pB: 0.5 }, { pA: 0.3, pB: 0.3 }, { pA: 0.4, pB: 0.6 }, { pA: 0.1, pB: 0.5 }];
    const observedMean = rates.reduce((s, r) => s + (r.pB - r.pA), 0) / rates.length;
    const bound = pairedRateDiffLowerBound(rates, { seed: 7, resamples: 2000 });
    expect(bound).toBeLessThanOrEqual(observedMean + 1e-9);
  });

  test("pins a nonconstant nonzero-acceleration BCa oracle, draw count, and ordered task vector", () => {
    // Independent Python NormalDist oracle over the exact xorshift32-v1 draws and the
    // IEEE-754 deltas produced by these rate pairs.
    // Deltas in code-unit task order: [-.4, -.1, 0, .05, .1, .6].
    const orderedRates = [
      { pA: 0.6, pB: 0.2 },
      { pA: 0.5, pB: 0.4 },
      { pA: 0.5, pB: 0.5 },
      { pA: 0.4, pB: 0.45 },
      { pA: 0.3, pB: 0.4 },
      { pA: 0.2, pB: 0.8 },
    ];
    const result = pairedRateDiffBca(orderedRates, {
      seed: 1,
      resamples: 1_000,
    });
    expect(result.draws).toBe(6_000);
    expect(result.observed).toBeCloseTo(0.04166666666666669, 15);
    expect(result.acceleration).toBeCloseTo(0.036577981383804824, 14);
    expect(result.biasCorrection).toBeCloseTo(0.025068908258711053, 7);
    expect(result.adjustedQuantile).toBeCloseTo(0.06627599770137671, 7);
    expect(result.adjustedIndex).toBe(66);
    expect(result.lowerBound).toBeCloseTo(-0.14166666666666664, 15);

    // A percentile-only implementation and a BCa implementation that forces acceleration=0
    // both select -0.158333... for this exact stream. This vector must discriminate both.
    const percentileOrZeroAcceleration = -0.15833333333333333;
    expect(result.lowerBound).not.toBeCloseTo(percentileOrZeroAcceleration, 15);

    // One draw is consumed per sampled position against the ordered task vector. Reversing that
    // vector while keeping the exact stream changes the finite replay result.
    const reversed = pairedRateDiffBca([...orderedRates].reverse(), {
      seed: 1,
      resamples: 1_000,
    });
    expect(reversed.draws).toBe(6_000);
    expect(reversed.lowerBound).toBeCloseTo(-0.125, 15);
    expect(reversed.lowerBound).not.toBe(result.lowerBound);
  });
});

describe("clusteredPairedRateDiffBca", () => {
  test("samples whole source clusters, reports C draws per resample, and refuses a single cluster", () => {
    const clustered = [
      { taskDigest: "a", cluster: ["source", "family-a"] as const, pA: 0.8, pB: 0.2 },
      { taskDigest: "b", cluster: ["source", "family-a"] as const, pA: 0.8, pB: 0.2 },
      { taskDigest: "c", cluster: ["sourceCommitment", "sha256:" + "c".repeat(64)] as const, pA: 0.2, pB: 0.8 },
    ];
    const result = clusteredPairedRateDiffBca(clustered, { seed: 1, resamples: 10 });
    expect(result.draws).toBe(20);
    expect(result.unit).toBe("source-cluster");
    expect(result.clusters).toEqual([
      { key: ["source", "family-a"], members: ["a", "b"] },
      { key: ["sourceCommitment", "sha256:" + "c".repeat(64)], members: ["c"] },
    ]);
    expect(() => clusteredPairedRateDiffBca(clustered.slice(0, 2), { seed: 1, resamples: 10 }))
      .toThrow(/at least two source clusters/);
  });
});

describe("nonInferiorityVerdict", () => {
  const constantImprovingRates = Array.from({ length: 6 }, () => ({ pA: 0.5, pB: 0.6 }));

  test("below minN, the quality leg is inconclusive rather than a weak pass/fail", () => {
    const result = nonInferiorityVerdict([{ pA: 0.5, pB: 0.6 }], {
      seed: 1,
      stockBaseRate: 0.5,
      minN: 5,
    });
    expect(result.verdict).toBe("inconclusive");
    expect(result.lowerBound).toBeNull();
  });

  test("a clear, constant improvement passes both the absolute and relative checks", () => {
    const result = nonInferiorityVerdict(constantImprovingRates, {
      seed: 3,
      stockBaseRate: 0.5,
      resamples: 500,
    });
    expect(result.verdict).toBe("pass");
    expect(result.lowerBound).toBeCloseTo(0.1, 10); // constant delta -> exact bootstrap bound
  });

  test("a regression beyond deltaAbs fails the absolute check", () => {
    const regressingRates = Array.from({ length: 6 }, () => ({ pA: 0.6, pB: 0.5 })); // delta = -0.1
    const result = nonInferiorityVerdict(regressingRates, {
      seed: 3,
      stockBaseRate: 0.6,
      deltaAbs: 0.05,
      resamples: 500,
    });
    expect(result.verdict).toBe("fail");
    expect(result.reasons.some((r) => r.includes("absolute NI failed"))).toBe(true);
  });
});

describe("pairedCostVerdict", () => {
  test("below minN, inconclusive", () => {
    expect(pairedCostVerdict([-1, -2, -3])).toEqual({ verdict: "inconclusive", pValue: null, n: 3 });
  });

  test("all-negative diffs (candidate strictly cheaper): matches the independently computed Wilcoxon values", () => {
    const result = pairedCostVerdict([-10, -9, -8, -7, -6, -5, -4, -3, -2, -1]);
    expect(result.verdict).toBe("lower");
    expect(result.pValue).toBeCloseTo(0.0029608242202975865, 12);
    expect(result.n).toBe(10);
  });

  test("all-positive diffs (candidate strictly costlier): not-lower, matches the independently computed value", () => {
    const result = pairedCostVerdict([10, 9, 8, 7, 6, 5, 4, 3, 2, 1]);
    expect(result.verdict).toBe("not-lower");
    expect(result.pValue).toBeCloseTo(0.9978414738731554, 10);
  });

  test("zero diffs are dropped before the minN check", () => {
    expect(pairedCostVerdict([0, 0, 0, -1, -2]).n).toBe(2);
  });
});

describe("nonInferiorityIut (intersection-union composition)", () => {
  const pass = { verdict: "pass" as const, lowerBound: 0, deltaAbs: 0.05, relativeRegression: 0, reasons: [] };
  const fail = { verdict: "fail" as const, lowerBound: -1, deltaAbs: 0.05, relativeRegression: 1, reasons: ["x"] };
  const inconclusiveQuality = { verdict: "inconclusive" as const, lowerBound: null, deltaAbs: 0.05, relativeRegression: null, reasons: ["x"] };
  const lower = { verdict: "lower" as const, pValue: 0.01, n: 10 };
  const notLower = { verdict: "not-lower" as const, pValue: 0.9, n: 10 };
  const inconclusiveCost = { verdict: "inconclusive" as const, pValue: null, n: 3 };

  test("PASS: both legs pass", () => {
    expect(nonInferiorityIut(pass, lower)).toBe("PASS");
  });

  test("FAIL: quality fails even if cost is inconclusive (a decisive FAIL dominates)", () => {
    expect(nonInferiorityIut(fail, inconclusiveCost)).toBe("FAIL");
  });

  test("FAIL: cost fails even if quality passes", () => {
    expect(nonInferiorityIut(pass, notLower)).toBe("FAIL");
  });

  test("FAIL: both legs fail", () => {
    expect(nonInferiorityIut(fail, notLower)).toBe("FAIL");
  });

  test("INCONCLUSIVE: quality inconclusive, cost passes", () => {
    expect(nonInferiorityIut(inconclusiveQuality, lower)).toBe("INCONCLUSIVE");
  });

  test("INCONCLUSIVE: cost inconclusive, quality passes", () => {
    expect(nonInferiorityIut(pass, inconclusiveCost)).toBe("INCONCLUSIVE");
  });

  test("INCONCLUSIVE: both legs inconclusive", () => {
    expect(nonInferiorityIut(inconclusiveQuality, inconclusiveCost)).toBe("INCONCLUSIVE");
  });
});
