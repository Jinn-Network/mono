import { describe, expect, test } from "vitest";
import { clusteredPairedDeltaInterval } from "./paired-delta.js";
import type { ClusteredTaskRate } from "./noninferiority.js";

function rate(task: string, cluster: string, pA: number, pB: number): ClusteredTaskRate {
  return { taskDigest: task, cluster: ["source", cluster] as const, pA, pB };
}

/** Six clusters, mixed per-task deltas — a genuinely non-degenerate bootstrap. */
const mixed: readonly ClusteredTaskRate[] = [
  rate("t1", "repo-a", 0.0, 1.0),
  rate("t2", "repo-b", 0.5, 1.0),
  rate("t3", "repo-c", 1.0, 1.0),
  rate("t4", "repo-d", 1.0, 0.5),
  rate("t5", "repo-e", 0.5, 0.0),
  rate("t6", "repo-f", 0.0, 0.5),
];

describe("clusteredPairedDeltaInterval", () => {
  test("brackets the observed paired mean difference with a two-sided interval", () => {
    const result = clusteredPairedDeltaInterval(mixed, { seed: 123456789, resamples: 500, alpha: 0.05 });
    // mean of (pB - pA) over the six tasks = (1 + .5 + 0 - .5 - .5 + .5) / 6 = 1/6
    expect(result.delta).toBeCloseTo(1 / 6, 12);
    expect(result.low).toBeLessThan(result.delta);
    expect(result.high).toBeGreaterThan(result.delta);
    expect(result.low).toBeLessThan(result.high);
  });

  test("is deterministic — the same seed reproduces byte-identical endpoints", () => {
    const options = { seed: 42, resamples: 500, alpha: 0.05 };
    expect(clusteredPairedDeltaInterval(mixed, options))
      .toEqual(clusteredPairedDeltaInterval(mixed, options));
  });

  test("nests a 90% interval strictly inside a 99% interval at one seed", () => {
    const wide = clusteredPairedDeltaInterval(mixed, { seed: 7, resamples: 2000, alpha: 0.01 });
    const narrow = clusteredPairedDeltaInterval(mixed, { seed: 7, resamples: 2000, alpha: 0.1 });
    expect(narrow.low).toBeGreaterThanOrEqual(wide.low);
    expect(narrow.high).toBeLessThanOrEqual(wide.high);
    expect(narrow.delta).toBe(wide.delta);
  });

  test("collapses both endpoints onto the point estimate when every task delta is identical", () => {
    const degenerate = ["a", "b", "c", "d"].map((key, index) =>
      rate(`t${index}`, `repo-${key}`, 0, 1));
    const result = clusteredPairedDeltaInterval(degenerate, { seed: 9, resamples: 200, alpha: 0.05 });
    expect(result.delta).toBe(1);
    expect(result.low).toBe(1);
    expect(result.high).toBe(1);
  });

  test("counts zero-delta tasks in the mean rather than discarding them", () => {
    const withTies = [rate("t1", "repo-a", 0, 1), rate("t2", "repo-b", 1, 1), rate("t3", "repo-c", 1, 1)];
    const result = clusteredPairedDeltaInterval(withTies, { seed: 5, resamples: 200, alpha: 0.05 });
    // A sign test would drop the two ties; the mean must not.
    expect(result.delta).toBeCloseTo(1 / 3, 12);
  });

  test("reports two bootstrap passes worth of draws over whole clusters", () => {
    const result = clusteredPairedDeltaInterval(mixed, { seed: 11, resamples: 250, alpha: 0.05 });
    expect(result.draws).toBe(2 * 250 * 6);
    expect(result.unit).toBe("source-cluster");
    expect(result.clusters).toHaveLength(6);
  });

  test("groups multi-task clusters into a single resample position", () => {
    const grouped = [
      rate("t1", "repo-a", 0, 1),
      rate("t2", "repo-a", 0, 1),
      rate("t3", "repo-b", 0, 0),
    ];
    const result = clusteredPairedDeltaInterval(grouped, { seed: 3, resamples: 100, alpha: 0.05 });
    expect(result.clusters).toHaveLength(2);
    expect(result.draws).toBe(2 * 100 * 2);
  });

  test("computes at the two-cluster floor", () => {
    const two = [rate("t1", "repo-a", 0, 1), rate("t2", "repo-b", 1, 0)];
    expect(() => clusteredPairedDeltaInterval(two, { seed: 1, resamples: 100, alpha: 0.05 })).not.toThrow();
  });

  test("refuses a single source cluster", () => {
    const one = [rate("t1", "repo-a", 0, 1), rate("t2", "repo-a", 1, 0)];
    expect(() => clusteredPairedDeltaInterval(one, { seed: 1, resamples: 100, alpha: 0.05 }))
      .toThrow(/at least two source clusters/);
  });

  test("refuses an alpha outside (0,1)", () => {
    for (const alpha of [0, 1, -0.1, 1.5]) {
      expect(() => clusteredPairedDeltaInterval(mixed, { seed: 1, resamples: 100, alpha }))
        .toThrow(/alpha must be in \(0,1\)/);
    }
  });
});
