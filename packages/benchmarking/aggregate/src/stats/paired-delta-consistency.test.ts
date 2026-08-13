import { beforeEach, describe, expect, test, vi } from "vitest";

const mocks = vi.hoisted(() => ({ clusteredPairedRateDiffBca: vi.fn() }));

vi.mock("./noninferiority.js", () => ({
  clusteredPairedRateDiffBca: mocks.clusteredPairedRateDiffBca,
}));

import { clusteredPairedDeltaInterval } from "./paired-delta.js";

const CLUSTERS = [
  { key: ["source", "repo-a"] as const, members: ["task-a"] },
  { key: ["source", "repo-b"] as const, members: ["task-b"] },
] as const;

function endpoint(overrides: Record<string, unknown> = {}) {
  return {
    observed: 0.25,
    lowerBound: -0.25,
    acceleration: 0,
    biasCorrection: 0,
    adjustedQuantile: 0.025,
    adjustedIndex: 2,
    draws: 200,
    unit: "source-cluster",
    clusters: CLUSTERS,
    ...overrides,
  };
}

describe("clusteredPairedDeltaInterval endpoint consistency", () => {
  beforeEach(() => {
    mocks.clusteredPairedRateDiffBca.mockReset();
  });

  test("reports one shared ensemble after agreeing endpoint passes", () => {
    mocks.clusteredPairedRateDiffBca
      .mockReturnValueOnce(endpoint({ lowerBound: -0.25 }))
      .mockReturnValueOnce(endpoint({ lowerBound: 0.75, adjustedQuantile: 0.975 }));

    expect(clusteredPairedDeltaInterval([], { seed: 7, resamples: 100, alpha: 0.05 }))
      .toMatchObject({ delta: 0.25, low: -0.25, high: 0.75, draws: 200, clusters: CLUSTERS });
  });

  test.each([
    ["draw counts", endpoint({ draws: 201 }), /endpoint passes disagree on draw count/],
    ["observed values", endpoint({ observed: 0.5 }), /endpoint passes disagree on observed value/],
    ["cluster manifests", endpoint({
      clusters: [
        CLUSTERS[0],
        { key: ["source", "repo-b"] as const, members: ["different-task"] },
      ],
    }), /endpoint passes disagree on cluster manifest/],
  ])("fails closed when %s differ", (_label, upper, expected) => {
    mocks.clusteredPairedRateDiffBca
      .mockReturnValueOnce(endpoint())
      .mockReturnValueOnce(upper);

    expect(() => clusteredPairedDeltaInterval([], { seed: 7, resamples: 100, alpha: 0.05 }))
      .toThrow(expected);
  });
});
