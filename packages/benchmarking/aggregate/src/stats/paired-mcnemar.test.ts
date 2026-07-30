import { describe, expect, test } from "vitest";
import { clusteredVariance, mcnemarExact, pairedMcnemar } from "./paired-mcnemar.js";

describe("mcnemarExact (ported from packages/core/src/paired.ts)", () => {
  test("b=3,c=1 (n=4,k=1): 2*(0.5^4 + 4*0.5^4) = 0.625", () => {
    expect(mcnemarExact(3, 1)).toBeCloseTo(0.625, 12);
  });

  test("b=2,c=1 (n=3,k=1): 2*(0.5^3 + 3*0.5^3) = 1 (capped)", () => {
    expect(mcnemarExact(2, 1)).toBe(1);
  });

  test("no discordant pairs: no evidence, p=1", () => {
    expect(mcnemarExact(0, 0)).toBe(1);
  });

  test("is symmetric in b and c", () => {
    expect(mcnemarExact(5, 2)).toBeCloseTo(mcnemarExact(2, 5), 12);
  });

  test("large balanced discordance remains exactly p=1 instead of underflowing", () => {
    expect(mcnemarExact(600, 600)).toBe(1);
  });

  test("large extreme-but-representable tail is stable when the p=0.5 seed term underflows", () => {
    // Independent high-precision oracle:
    // 2 * sum(i=0..10, C(1075,i)) / 2^1075
    expect(mcnemarExact(1065, 10)).toBeCloseTo(
      2.7162020597214054e-300,
      312,
    );
  });

  test.each([
    [-1, 0],
    [0, -1],
    [1.5, 1],
  ])("rejects invalid discordant counts b=%s,c=%s", (b, c) => {
    expect(() => mcnemarExact(b, c)).toThrow(/nonnegative integers/);
  });
});

describe("clusteredVariance", () => {
  test("all-singleton clusters: clustered variance equals the naive variance (design effect 1)", () => {
    const result = clusteredVariance([
      { clusterKey: "t1", delta: 1 },
      { clusterKey: "t2", delta: -1 },
      { clusterKey: "t3", delta: 1 },
    ]);
    expect(result.naiveVariance).toBe(3);
    expect(result.clusteredVariance).toBe(3);
    expect(result.designEffect).toBe(1);
    expect(result.clusters).toBe(3);
  });

  test("two same-direction flips in one cluster inflate the design effect above 1", () => {
    // repoA: +1, +1 (cluster sum 2, squared 4); repoB: -1 (cluster sum -1, squared 1).
    const result = clusteredVariance([
      { clusterKey: "repoA", delta: 1 },
      { clusterKey: "repoA", delta: 1 },
      { clusterKey: "repoB", delta: -1 },
    ]);
    expect(result.naiveVariance).toBe(3);
    expect(result.clusteredVariance).toBe(5);
    expect(result.designEffect).toBeCloseTo(5 / 3, 12);
    expect(result.clusters).toBe(2);
  });

  test("opposite-direction flips in one cluster can DEFLATE the design effect below 1", () => {
    // One cluster with a +1 and a -1 cancels to a cluster sum of 0.
    const result = clusteredVariance([
      { clusterKey: "repoA", delta: 1 },
      { clusterKey: "repoA", delta: -1 },
    ]);
    expect(result.naiveVariance).toBe(2);
    expect(result.clusteredVariance).toBe(0);
    expect(result.designEffect).toBe(0);
  });

  test("no discordant pairs: designEffect defaults to 1 (never divides by zero)", () => {
    const result = clusteredVariance([{ clusterKey: "t1", delta: 0 }]);
    expect(result.naiveVariance).toBe(0);
    expect(result.clusteredVariance).toBe(0);
    expect(result.designEffect).toBe(1);
  });
});

describe("pairedMcnemar", () => {
  const outcomes = [
    { taskDigest: "t1", baseline: "pass", candidate: "pass" }, // concordant pass
    { taskDigest: "t2", baseline: "fail", candidate: "pass" }, // improved
    { taskDigest: "t3", baseline: "fail", candidate: "pass" }, // improved
    { taskDigest: "t4", baseline: "fail", candidate: "pass" }, // improved
    { taskDigest: "t5", baseline: "pass", candidate: "fail" }, // regressed
    { taskDigest: "t6", baseline: "fail", candidate: "fail" }, // concordant fail
  ] as const;

  test("counts discordant/concordant pairs correctly and matches the exact fixture pValue", () => {
    const result = pairedMcnemar(outcomes);
    expect(result.pairs).toBe(6);
    expect(result.improved).toBe(3);
    expect(result.regressed).toBe(1);
    expect(result.concordantPass).toBe(1);
    expect(result.concordantFail).toBe(1);
    expect(result.pValue).toBeCloseTo(0.625, 12);
  });

  test("without a cluster resolver, clustering.basis is honestly 'none' and no clustered p-value is reported", () => {
    const result = pairedMcnemar(outcomes);
    expect(result.clustering).toEqual({ basis: "none", clusters: 4 });
    expect(result.clusteredPValue).toBeUndefined();
    expect(result.designEffect).toBeUndefined();
  });

  test("with a cluster resolver grouping t2/t3 into one repo, a clustered companion p-value is reported alongside the exact one", () => {
    const result = pairedMcnemar(outcomes, (taskDigest) =>
      taskDigest === "t2" || taskDigest === "t3" ? "repoA" : taskDigest);
    expect(result.pValue).toBeCloseTo(0.625, 12); // the exact test never changes
    expect(result.clustering.basis).toBe("task-provenance-source");
    // clusters: repoA{t2,t3}, t4, t5 -> 3 clusters over 4 discordant pairs.
    expect(result.clustering.clusters).toBe(3);
    // t2+t3 agree in direction (both improved), so the cluster-robust variance (6) exceeds the
    // naive variance (4): designEffect = 6/4 = 1.5.
    expect(result.designEffect).toBeCloseTo(1.5, 12);
    expect(result.clusteredPValue).toBeCloseTo(0.4142160660619236, 10);
  });

  test("a larger design effect (more within-cluster agreement) widens the clustered p-value relative to the same z-test with no clustering", () => {
    // Same discordant counts (3 improved, 1 regressed) as `outcomes`, but every improvement
    // shares one cluster -- the maximal within-cluster agreement case.
    const allSameCluster = pairedMcnemar(outcomes, (taskDigest) =>
      ["t2", "t3", "t4"].includes(taskDigest) ? "repoA" : taskDigest);
    const noClustering = pairedMcnemar(outcomes, (taskDigest) => taskDigest); // every item its own cluster
    expect(allSameCluster.designEffect).toBeGreaterThan(noClustering.designEffect!);
    expect(allSameCluster.clusteredPValue!).toBeGreaterThan(noClustering.clusteredPValue!);
  });
});
