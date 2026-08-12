import { describe, expect, test } from "vitest";
import { provenanceClusterSign } from "./provenance-cluster-sign.js";

describe("provenanceClusterSign", () => {
  test("six uniformly favorable clusters cross the two-sided .05 boundary", () => {
    const result = provenanceClusterSign(Array.from({ length: 6 }, (_, index) => ({
      clusterKey: `repo-${index}`,
      delta: 1 as const,
    })));
    expect(result).toMatchObject({
      clusters: 6,
      favorable: 6,
      unfavorable: 0,
      tied: 0,
      nonTied: 6,
      pValue: 0.03125,
    });
  });

  test("five uniformly favorable clusters cannot cross the two-sided .05 boundary", () => {
    expect(provenanceClusterSign(Array.from({ length: 5 }, (_, index) => ({
      clusterKey: `repo-${index}`,
      delta: 1 as const,
    }))).pValue).toBe(0.0625);
  });

  test("gives each cluster one sign vote and reports within-cluster ties", () => {
    const result = provenanceClusterSign([
      { clusterKey: "repo-b", delta: 1 },
      { clusterKey: "repo-a", delta: 1 },
      { clusterKey: "repo-a", delta: -1 },
      { clusterKey: "repo-c", delta: -1 },
      { clusterKey: "repo-b", delta: 1 },
    ]);
    expect(result).toMatchObject({
      clusters: 3,
      favorable: 1,
      unfavorable: 1,
      tied: 1,
      nonTied: 2,
      pValue: 1,
    });
    expect(result.votes).toEqual([
      { clusterKey: "repo-a", taskDelta: 0, vote: "tied" },
      { clusterKey: "repo-b", taskDelta: 2, vote: "favorable" },
      { clusterKey: "repo-c", taskDelta: -1, vote: "unfavorable" },
    ]);
  });

  test("refuses an empty cluster key", () => {
    expect(() => provenanceClusterSign([{ clusterKey: "", delta: 1 }]))
      .toThrow(/clusterKey/);
  });
});
