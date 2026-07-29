import { describe, expect, test } from "vitest";
import {
  nonInferiorityIut,
  nonInferiorityVerdict,
  pairedCostVerdict,
  pairedRateDiffBca,
  pairedRateDiffLowerBound,
  xorshift32,
  clusteredPairedRateDiffBca,
  MAX_NONINFERIORITY_RESAMPLES_V1,
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

test("resampling helpers reject max-plus-one before work and retain the v1 maximum", () => {
  expect(MAX_NONINFERIORITY_RESAMPLES_V1).toBe(100_000);
  expect(() => pairedRateDiffBca([{ pA: 0, pB: 1 }], { seed: 1, resamples: 100_001 })).toThrow(/100000/);
});

test("Wilcoxon ranking preserves bigint magnitudes and exact ties", () => {
  expect(pairedCostVerdict(Array.from({ length: 10 }, () => -9_007_199_254_740_993n))).toEqual({ verdict: "lower", pValue: expect.any(Number), n: 10 });
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

  test("pins the non-vacuous whole-source-cluster BCa oracle and grouping discriminator", () => {
    const commitment = `sha256:${"9".repeat(64)}`;
    const rates = [
      { taskDigest: "a".repeat(64), cluster: ["source", "family-b"] as const, pA: 4 / 5, pB: 2 / 5 },
      { taskDigest: "b".repeat(64), cluster: ["source", "family-a"] as const, pA: 3 / 5, pB: 1 / 2 },
      { taskDigest: "c".repeat(64), cluster: ["source", "family-a"] as const, pA: 2 / 5, pB: 2 / 5 },
      { taskDigest: "d".repeat(64), cluster: ["sourceCommitment", commitment] as const, pA: 2 / 5, pB: 9 / 20 },
      { taskDigest: "e".repeat(64), cluster: ["sourceCommitment", commitment] as const, pA: 1 / 2, pB: 3 / 5 },
      { taskDigest: "f".repeat(64), cluster: ["sourceCommitment", commitment] as const, pA: 1 / 5, pB: 4 / 5 },
    ];

    const result = clusteredPairedRateDiffBca(rates, { seed: 1, resamples: 1_000 });
    expect({
      observed: result.observed,
      lowerBound: result.lowerBound,
      biasCorrection: result.biasCorrection,
      adjustedQuantile: result.adjustedQuantile,
      adjustedIndex: result.adjustedIndex,
      draws: result.draws,
      unit: result.unit,
    }).toEqual({
      observed: 0.04166666666666668,
      lowerBound: -0.225,
      biasCorrection: -0.0828132919872456,
      adjustedQuantile: 0.05033626184818413,
      adjustedIndex: 50,
      draws: 3_000,
      unit: "source-cluster",
    });
    expect(result.acceleration).toBeCloseTo(0.0627085632050839, 15);
    const expectedClusters = [
      { key: ["source", "family-a"], members: ["b".repeat(64), "c".repeat(64)] },
      { key: ["source", "family-b"], members: ["a".repeat(64)] },
      {
        key: ["sourceCommitment", commitment],
        members: ["d".repeat(64), "e".repeat(64), "f".repeat(64)],
      },
    ] as const;
    expect(result.clusters).toEqual(expectedClusters);

    const rateByDigest = new Map(rates.map((rate) => [rate.taskDigest, rate]));
    const jackknifeEstimates = expectedClusters.map((_cluster, omitted) => {
      const remaining = expectedClusters
        .filter((_candidate, index) => index !== omitted)
        .flatMap((cluster) => cluster.members)
        .map((taskDigest) => rateByDigest.get(taskDigest)!);
      return remaining.reduce((sum, rate) => sum + (rate.pB - rate.pA), 0) / remaining.length;
    });
    expect(jackknifeEstimates).toHaveLength(3);
    expect(jackknifeEstimates[0]).toBeCloseTo(0.0875, 15);
    expect(jackknifeEstimates[1]).toBeCloseTo(0.13, 15);
    expect(jackknifeEstimates[2]).toBeCloseTo(-0.16666666666666666, 15);

    const next = xorshift32(1);
    // These are the exact IEEE-754 subtraction results of the six rational rate pairs above.
    // Keeping them literal makes the strict-below oracle independent of the production delta
    // helper while preserving the finite-stream equality boundary.
    const clusterDeltas = [
      [-0.09999999999999998, 0],
      [-0.4],
      [0.04999999999999999, 0.09999999999999998, 0.6000000000000001],
    ];
    let belowObserved = 0;
    for (let replicate = 0; replicate < 1_000; replicate += 1) {
      const sampled: number[] = [];
      for (let position = 0; position < 3; position += 1) {
        sampled.push(...clusterDeltas[Math.floor((next() / 4_294_967_296) * 3)]!);
      }
      const estimate = sampled.reduce((sum, value) => sum + value, 0) / sampled.length;
      if (estimate < result.observed) belowObserved += 1;
    }
    expect(belowObserved).toBe(467);

    const regrouped = rates.map((rate) => rate.taskDigest === "b".repeat(64)
      ? { ...rate, cluster: ["source", "family-b"] as const }
      : rate);
    const regroupedResult = clusteredPairedRateDiffBca(regrouped, { seed: 1, resamples: 1_000 });
    expect({
      observed: regroupedResult.observed,
      lowerBound: regroupedResult.lowerBound,
      biasCorrection: regroupedResult.biasCorrection,
      adjustedQuantile: regroupedResult.adjustedQuantile,
      adjustedIndex: regroupedResult.adjustedIndex,
      draws: regroupedResult.draws,
    }).toEqual({
      observed: 0.04166666666666668,
      lowerBound: -0.2,
      biasCorrection: -0.002506630902398872,
      adjustedQuantile: 0.05667480707950723,
      adjustedIndex: 56,
      draws: 3_000,
    });
    expect(regroupedResult.acceleration).toBeCloseTo(0.025555839127816213, 15);
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
