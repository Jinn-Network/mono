import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";
import { clusteredPairedDeltaInterval } from "./paired-delta.js";
import {
  clusteredPairedRateDiffBca,
  type ClusteredTaskRate,
} from "./noninferiority.js";

interface OracleEndpoint {
  readonly adjustedIndex: number;
  readonly adjustedQuantile: number;
  readonly biasCorrection: number;
  readonly value: number;
  readonly below: number;
  readonly ties: number;
  readonly tieMass: number;
}

interface OracleCase {
  readonly id: string;
  readonly description: string;
  readonly seed: number;
  readonly resamples: number;
  readonly alpha: number;
  readonly rates: readonly ClusteredTaskRate[];
  readonly oracle: {
    readonly observed: number;
    readonly acceleration: number;
    readonly draws: number;
    readonly clusterManifest: readonly {
      readonly key: readonly ["source" | "sourceCommitment", string];
      readonly members: readonly string[];
    }[];
    readonly strict: { readonly low: OracleEndpoint; readonly high: OracleEndpoint };
    readonly midP: { readonly low: OracleEndpoint; readonly high: OracleEndpoint };
  };
  readonly taskAverageAudit?: {
    readonly enumeratedSelections: number;
    readonly expectedBootstrapMean: number;
    readonly intraclassCorrelationAnova: number;
    readonly offset: number;
    readonly absoluteOffset: number;
    readonly strictIntervalHalfWidth: number;
    readonly offsetShareOfHalfWidth: number;
  };
}

interface OracleDocument {
  readonly schema: string;
  readonly reference: {
    readonly runtime: string;
    readonly normalDistribution: string;
    readonly generator: string;
    readonly generatorSha256: string;
    readonly quantileConvention: string;
    readonly tieConventions: readonly string[];
  };
  readonly decisionAudit: {
    readonly pairedDeltaV1Convention: string;
    readonly sensitivityConvention: string;
    readonly publicSemanticsChanged: boolean;
    readonly postRunRequirement: string;
  };
  readonly fixtures: readonly OracleCase[];
}

const fixtureUrl = new URL("./oracles/paired-delta-bca.python-3.11.0.v1.json", import.meta.url);
const generatorUrl = new URL("../../scripts/generate-paired-delta-oracles.py", import.meta.url);
const fixtureBytes = readFileSync(fixtureUrl);
const oracle = JSON.parse(fixtureBytes.toString("utf8")) as OracleDocument;

function endpointDirection(low: number, high: number): "positive" | "negative" | "crosses-zero" {
  if (low > 0) return "positive";
  if (high < 0) return "negative";
  return "crosses-zero";
}

function clustersFor(testCase: OracleCase): ClusteredTaskRate[][] {
  const byDigest = new Map(testCase.rates.map((rate) => [rate.taskDigest, rate]));
  return testCase.oracle.clusterManifest.map((cluster) =>
    cluster.members.map((digest) => {
      const rate = byDigest.get(digest);
      if (rate === undefined) throw new Error(`oracle manifest references missing task ${digest}`);
      return rate;
    }));
}

function enumerateClusterBootstrapMeans(clusters: readonly (readonly ClusteredTaskRate[])[]): number[] {
  const output: number[] = [];
  const selection: number[] = [];
  const visit = (position: number): void => {
    if (position < clusters.length) {
      for (let index = 0; index < clusters.length; index += 1) {
        selection.push(index);
        visit(position + 1);
        selection.pop();
      }
      return;
    }
    const members = selection.flatMap((index) => clusters[index]!);
    output.push(members.reduce((sum, rate) => sum + (rate.pB - rate.pA), 0) / members.length);
  };
  visit(0);
  return output;
}

function anovaIcc(clusters: readonly (readonly ClusteredTaskRate[])[]): number {
  const groups = clusters.map((cluster) => cluster.map((rate) => rate.pB - rate.pA));
  const count = groups.reduce((sum, group) => sum + group.length, 0);
  const grand = groups.flat().reduce((sum, value) => sum + value, 0) / count;
  const means = groups.map((group) => group.reduce((sum, value) => sum + value, 0) / group.length);
  const between = groups.reduce((sum, group, index) =>
    sum + group.length * Math.pow(means[index]! - grand, 2), 0);
  const within = groups.reduce((sum, group, index) =>
    sum + group.reduce((inner, value) => inner + Math.pow(value - means[index]!, 2), 0), 0);
  const meanBetween = between / (groups.length - 1);
  const meanWithin = within / (count - groups.length);
  const effectiveSize = (
    count - groups.reduce((sum, group) => sum + group.length ** 2, 0) / count
  ) / (groups.length - 1);
  return (meanBetween - meanWithin) / (meanBetween + (effectiveSize - 1) * meanWithin);
}

describe("Demo-1 H4 independent paired-BCa oracle", () => {
  test("pins the external implementation, its exact bytes, and three frozen cases", () => {
    expect(oracle.schema).toBe("jinn.demo1.paired-delta-bca-oracle.v1");
    expect(oracle.reference).toMatchObject({
      runtime: "CPython 3.11.0",
      normalDistribution: "Python statistics.NormalDist (Python 3.11.0 standard library)",
      quantileConvention: "inverse-empirical-cdf-hyndman-fan-type-1",
    });
    expect(createHash("sha256").update(readFileSync(generatorUrl)).digest("hex"))
      .toBe(oracle.reference.generatorSha256);
    expect(createHash("sha256").update(fixtureBytes).digest("hex"))
      .toBe("09189872493e725b86189ef95fcf4d2a9a1adaabea1b2c7f28faabec6304bcbe");
    expect(oracle.fixtures.map((fixture) => fixture.id)).toEqual([
      "balanced-six-singletons",
      "unequal-correlated-clusters",
      "discrete-tie-mass",
    ]);
  });

  test.each(oracle.fixtures)("matches both independent endpoints for $id", (testCase) => {
    const common = { seed: testCase.seed, resamples: testCase.resamples };
    const lower = clusteredPairedRateDiffBca(testCase.rates, {
      ...common,
      alpha: testCase.alpha / 2,
    });
    const upper = clusteredPairedRateDiffBca(testCase.rates, {
      ...common,
      alpha: 1 - testCase.alpha / 2,
    });
    const interval = clusteredPairedDeltaInterval(testCase.rates, {
      ...common,
      alpha: testCase.alpha,
    });

    expect(lower.observed).toBeCloseTo(testCase.oracle.observed, 15);
    expect(lower.acceleration).toBeCloseTo(testCase.oracle.acceleration, 14);
    expect(lower.draws).toBe(testCase.oracle.draws);
    expect(upper.draws).toBe(testCase.oracle.draws);
    expect(lower.clusters).toEqual(testCase.oracle.clusterManifest);
    expect(upper.clusters).toEqual(testCase.oracle.clusterManifest);
    expect(Math.abs(lower.adjustedIndex - testCase.oracle.strict.low.adjustedIndex)).toBeLessThanOrEqual(1);
    expect(Math.abs(upper.adjustedIndex - testCase.oracle.strict.high.adjustedIndex)).toBeLessThanOrEqual(1);
    expect(Math.abs(lower.lowerBound - testCase.oracle.strict.low.value)).toBeLessThanOrEqual(0.002);
    expect(Math.abs(upper.lowerBound - testCase.oracle.strict.high.value)).toBeLessThanOrEqual(0.002);
    expect(interval.low).toBe(lower.lowerBound);
    expect(interval.high).toBe(upper.lowerBound);
    expect(interval.draws).toBe(testCase.oracle.draws);
  });
});

describe("Demo-1 H5 discrete tie decision audit", () => {
  test("retains paired-delta@1's exact strict-inequality rule and freezes mid-p as sensitivity only", () => {
    expect(oracle.decisionAudit).toEqual({
      pairedDeltaV1Convention: "strict-less-than",
      sensitivityConvention: "mid-p",
      publicSemanticsChanged: false,
      postRunRequirement: "Publish tie mass and strict-versus-mid-p endpoint/verdict sensitivity for the locked slate.",
    });
    expect(oracle.reference.tieConventions).toEqual(["strict-less-than", "mid-p"]);
  });

  test.each(oracle.fixtures)("production follows strict-less-than while $id audits mid-p", (testCase) => {
    const common = { seed: testCase.seed, resamples: testCase.resamples };
    const lower = clusteredPairedRateDiffBca(testCase.rates, {
      ...common,
      alpha: testCase.alpha / 2,
    });
    const upper = clusteredPairedRateDiffBca(testCase.rates, {
      ...common,
      alpha: 1 - testCase.alpha / 2,
    });
    expect(lower.biasCorrection).toBeCloseTo(testCase.oracle.strict.low.biasCorrection, 6);
    expect(upper.biasCorrection).toBeCloseTo(testCase.oracle.strict.high.biasCorrection, 6);
    expect(testCase.oracle.strict.low.ties).toBeGreaterThan(0);
    expect(testCase.oracle.strict.low.tieMass).toBeGreaterThan(0);
    expect(endpointDirection(testCase.oracle.strict.low.value, testCase.oracle.strict.high.value))
      .toBe(endpointDirection(testCase.oracle.midP.low.value, testCase.oracle.midP.high.value));
  });

  test("the audit is decision-relevant rather than a vacuous duplicate", () => {
    expect(oracle.fixtures.some((testCase) =>
      Math.abs(testCase.oracle.strict.low.value - testCase.oracle.midP.low.value) > 0.005
      || Math.abs(testCase.oracle.strict.high.value - testCase.oracle.midP.high.value) > 0.005,
    )).toBe(true);
  });
});

describe("Demo-1 H7 task-average estimand audit", () => {
  test("unequal, correlated repository clusters remain centered within both declared bounds", () => {
    const testCase = oracle.fixtures.find((fixture) => fixture.id === "unequal-correlated-clusters");
    if (testCase === undefined || testCase.taskAverageAudit === undefined) {
      throw new Error("unequal-cluster oracle fixture is missing its task-average audit");
    }
    const clusters = clustersFor(testCase);
    expect(clusters.map((cluster) => cluster.length)).toEqual([1, 2, 3, 4]);
    expect(anovaIcc(clusters)).toBeCloseTo(testCase.taskAverageAudit.intraclassCorrelationAnova, 14);
    expect(testCase.taskAverageAudit.intraclassCorrelationAnova).toBeGreaterThan(0.9);

    const taskAverage = testCase.rates.reduce((sum, rate) => sum + (rate.pB - rate.pA), 0)
      / testCase.rates.length;
    expect(taskAverage).toBeCloseTo(testCase.oracle.observed, 15);

    const exactBootstrapMeans = enumerateClusterBootstrapMeans(clusters);
    const expectedBootstrapMean = exactBootstrapMeans.reduce((sum, value) => sum + value, 0)
      / exactBootstrapMeans.length;
    expect(exactBootstrapMeans).toHaveLength(testCase.taskAverageAudit.enumeratedSelections);
    expect(expectedBootstrapMean).toBeCloseTo(testCase.taskAverageAudit.expectedBootstrapMean, 15);
    expect(expectedBootstrapMean - taskAverage).toBeCloseTo(testCase.taskAverageAudit.offset, 15);
    expect(testCase.taskAverageAudit.absoluteOffset).toBeLessThan(0.005);
    expect(testCase.taskAverageAudit.offsetShareOfHalfWidth).toBeLessThan(0.1);
  });
});

type ReplicateSensitivityRow = Readonly<Record<"baseline" | "candidate", readonly (0 | 1)[]>>;

function replicateSensitivity(rows: readonly ReplicateSensitivityRow[]) {
  const armValue = (values: readonly (0 | 1)[], rule: "mean-rate" | "any-pass" | "strict-majority") => {
    const passes = values.reduce<number>((sum, value) => sum + value, 0);
    if (rule === "mean-rate") return passes / values.length;
    if (rule === "any-pass") return passes > 0 ? 1 : 0;
    return passes * 2 > values.length ? 1 : 0;
  };
  return Object.fromEntries((["mean-rate", "any-pass", "strict-majority"] as const).map((rule) => [
    rule,
    rows.reduce((sum, row) =>
      sum + armValue(row.candidate, rule) - armValue(row.baseline, rule), 0) / rows.length,
  ]));
}

describe("Demo-1 H13 deterministic replicate-aggregation sensitivity recipe", () => {
  test("freezes mean-rate as primary and any-pass/strict-majority as outcome-changing sensitivities", () => {
    const result = replicateSensitivity([
      { baseline: [1, 0], candidate: [1, 1] },
      { baseline: [0, 0], candidate: [1, 0] },
      { baseline: [1, 1], candidate: [0, 1] },
    ]);
    expect(result).toEqual({
      "mean-rate": 1 / 6,
      "any-pass": 1 / 3,
      "strict-majority": 0,
    });
  });
});
