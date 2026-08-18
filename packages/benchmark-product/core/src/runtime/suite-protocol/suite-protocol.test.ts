import { describe, expect, test } from "vitest";
import {
  coverageFromSelectedNames,
  namedSliceTaskNames,
  SuiteProtocolSelectionSchema,
} from "./manifest.js";
import {
  DEEPSWE_NOT_LEADERBOARD_READY_LIMITATION,
  deriveSuiteComparability,
  methodLeaderboardEligible,
  officialHarborExecutionConformance,
  officialPierExecutionConformance,
  suiteLeaderboardLimitation,
  SUITE_NOT_LEADERBOARD_READY_LIMITATION,
} from "./comparability.js";

const twelve = ["t00", "t01", "t02", "t03", "t04", "t05", "t06", "t07", "t08", "t09", "t10", "t11"];

describe("suite protocol named slices", () => {
  test("lexicographic first 1 / first 10 / all from a 12-task snapshot", () => {
    expect(namedSliceTaskNames(twelve, "one_task")).toEqual(["t00"]);
    expect(namedSliceTaskNames(twelve, "ten_task")).toEqual(twelve.slice(0, 10));
    expect(namedSliceTaskNames(twelve, "full")).toEqual(twelve);
    expect(coverageFromSelectedNames(twelve, ["t00"])).toBe("one_task");
    expect(coverageFromSelectedNames(twelve, twelve.slice(0, 10))).toBe("ten_task");
    expect(coverageFromSelectedNames(twelve, twelve)).toBe("full");
    expect(coverageFromSelectedNames(twelve, ["t11"])).toBe("custom");
  });
});

describe("suite comparability", () => {
  test("1-task × 5 with official env is protocol-faithful and not leaderboard-ready", () => {
    expect(officialHarborExecutionConformance({
      k: 5, maxRetries: 3, jobGrain: "per-arm", environmentConfiguration: {}, harborVersion: "0.21.4",
    })).toBe(true);
    const bits = deriveSuiteComparability({
      coverage: "one_task",
      executionConformance: true,
      k: 5,
      selectedCount: 1,
      datasetCount: 12,
      atifPresent: true,
    });
    expect(bits).toEqual({ executionConformance: true, coverage: "one_task", leaderboardSubmitReady: false });
    expect(suiteLeaderboardLimitation(bits)).toMatch(/not a Terminal-Bench 2\.1 leaderboard submission/u);
    expect(suiteLeaderboardLimitation(bits)).not.toMatch(/DeepSWE|SWE-bench/u);
  });

  test("full coverage + k=5 + ATIF required + official env is method-eligible, not ready until collect", () => {
    const method = {
      coverage: "full" as const,
      executionConformance: true,
      k: 5,
      selectedCount: 12,
      datasetCount: 12,
      atifPresent: true,
      datasetRevisionMatchesLeaderboardPin: true,
    };
    expect(methodLeaderboardEligible(method)).toBe(true);
    expect(deriveSuiteComparability(method).leaderboardSubmitReady).toBe(false);
    const bits = deriveSuiteComparability({ ...method, cellsAccounted: true, atifOnRetainedJob: true });
    expect(bits.leaderboardSubmitReady).toBe(true);
    expect(suiteLeaderboardLimitation(bits)).toBeUndefined();
  });

  test("custom coverage cannot be leaderboard_submit_ready", () => {
    expect(deriveSuiteComparability({
      coverage: "custom",
      executionConformance: true,
      k: 5,
      selectedCount: 3,
      datasetCount: 12,
      atifPresent: true,
    }).leaderboardSubmitReady).toBe(false);
  });

  test("resource or timeout overrides break execution conformance", () => {
    expect(officialHarborExecutionConformance({
      k: 5, maxRetries: 3, jobGrain: "per-arm", environmentConfiguration: { override_cpus: 4 }, harborVersion: "0.21.4",
    })).toBe(false);
    expect(officialHarborExecutionConformance({
      k: 5, maxRetries: 0, jobGrain: "per-arm", environmentConfiguration: {}, harborVersion: "0.21.4",
    })).toBe(false);
    expect(officialHarborExecutionConformance({
      k: 5, maxRetries: 1, jobGrain: "per-arm", environmentConfiguration: {}, harborVersion: "0.21.4",
    })).toBe(false);
  });

  test("suite selection schema seals items to selected names", () => {
    expect(() => SuiteProtocolSelectionSchema.parse({
      schema: "jinn.network/benchmark-product/suite-protocol-selection/1",
      protocol: "terminal-bench-2.1",
      coverage: "one_task",
      datasetId: "terminal-bench/terminal-bench-2-1",
      datasetRevision: `sha256:${"a".repeat(64)}`,
      selectedTaskNames: ["t00"],
      datasetTaskCount: 12,
      replicates: 5,
      atifRequired: true,
      items: [{ taskName: "t00", taskSha256: "b".repeat(64) }],
    })).not.toThrow();
  });
});

const pierConforming = {
  k: 4,
  maxRetries: 3,
  jobGrain: "per-arm" as const,
  environmentConfiguration: {},
  pierVersion: "0.3.1",
  adapterId: "pier",
  environmentType: "docker",
  agentNames: ["mini-swe-agent", "mini-swe-agent"],
};

describe("DeepSWE v1.1 suite comparability", () => {
  test("k=4 + Pier 0.3.1 + mini-swe-agent + official env is protocol-faithful; k=1 and Harbor 0.21 are not", () => {
    expect(officialPierExecutionConformance(pierConforming)).toBe(true);
    expect(officialPierExecutionConformance({ ...pierConforming, k: 20 })).toBe(true);
    expect(officialPierExecutionConformance({ ...pierConforming, k: 1 })).toBe(false);
    expect(officialPierExecutionConformance({ ...pierConforming, adapterId: "harbor", pierVersion: "0.21.4" })).toBe(false);
    expect(officialPierExecutionConformance({ ...pierConforming, agentNames: ["claude-code"] })).toBe(false);
    expect(officialPierExecutionConformance({ ...pierConforming, environmentType: "daytona" })).toBe(false);
    expect(officialPierExecutionConformance({ ...pierConforming, environmentConfiguration: { override_cpus: 4 } })).toBe(false);
  });

  test("DeepSWE limitations name DeepSWE v1.1 and never Terminal-Bench or SWE-bench", () => {
    const bits = deriveSuiteComparability({
      protocol: "deep-swe-v1.1",
      coverage: "one_task",
      executionConformance: true,
      k: 4,
      selectedCount: 1,
      datasetCount: 12,
      atifPresent: true,
    });
    expect(bits.leaderboardSubmitReady).toBe(false);
    const sentence = suiteLeaderboardLimitation(bits, "deep-swe-v1.1");
    expect(sentence).toBe(DEEPSWE_NOT_LEADERBOARD_READY_LIMITATION);
    expect(sentence).toMatch(/DeepSWE v1\.1/u);
    expect(sentence).not.toMatch(/Terminal-Bench|SWE-bench/u);
    expect(SUITE_NOT_LEADERBOARD_READY_LIMITATION).not.toMatch(/DeepSWE|SWE-bench/u);
  });

  test("full coverage + k=4 + ATIF + collect is method-eligible and ready; k=1 cannot be eligible", () => {
    const method = {
      protocol: "deep-swe-v1.1" as const,
      coverage: "full" as const,
      executionConformance: true,
      k: 4,
      selectedCount: 12,
      datasetCount: 12,
      atifPresent: true,
      datasetRevisionMatchesLeaderboardPin: true,
    };
    expect(methodLeaderboardEligible(method)).toBe(true);
    expect(deriveSuiteComparability(method).leaderboardSubmitReady).toBe(false);
    const bits = deriveSuiteComparability({ ...method, cellsAccounted: true, atifOnRetainedJob: true, rewardOnRetainedJob: true });
    expect(bits.leaderboardSubmitReady).toBe(true);
    expect(suiteLeaderboardLimitation(bits, "deep-swe-v1.1")).toBeUndefined();
    expect(methodLeaderboardEligible({ ...method, k: 1 })).toBe(false);
  });

  test("DeepSWE suite selection schema seals git SHA, tasks tree SHA, and k≥4", () => {
    expect(() => SuiteProtocolSelectionSchema.parse({
      schema: "jinn.network/benchmark-product/suite-protocol-selection/1",
      protocol: "deep-swe-v1.1",
      coverage: "one_task",
      datasetId: "datacurve-ai/deep-swe",
      datasetRevision: "435ee89ec2f2e2289f33b0da4f992f0b7b7266b9",
      tasksTreeSha: "66df25a1b382017d0ae014d94cadb2698baaed48",
      selectedTaskNames: ["t00"],
      datasetTaskCount: 12,
      replicates: 4,
      atifRequired: true,
      items: [{ taskName: "t00", taskSha256: "b".repeat(64) }],
    })).not.toThrow();
    expect(() => SuiteProtocolSelectionSchema.parse({
      schema: "jinn.network/benchmark-product/suite-protocol-selection/1",
      protocol: "deep-swe-v1.1",
      coverage: "one_task",
      datasetId: "datacurve-ai/deep-swe",
      datasetRevision: "435ee89ec2f2e2289f33b0da4f992f0b7b7266b9",
      tasksTreeSha: "66df25a1b382017d0ae014d94cadb2698baaed48",
      selectedTaskNames: ["t00"],
      datasetTaskCount: 12,
      replicates: 1,
      atifRequired: true,
      items: [{ taskName: "t00", taskSha256: "b".repeat(64) }],
    })).toThrow();
  });
});
