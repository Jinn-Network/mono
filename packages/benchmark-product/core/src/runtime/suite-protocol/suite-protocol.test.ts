import { describe, expect, test } from "vitest";
import {
  coverageFromSelectedNames,
  namedSliceTaskNames,
  SuiteProtocolSelectionSchema,
} from "./manifest.js";
import {
  deriveSuiteComparability,
  methodLeaderboardEligible,
  officialApexSweDevConformance,
  officialHarborExecutionConformance,
  suiteLeaderboardLimitation,
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

  test("apex-swe-dev is a distinct protocol: k=1, no ATIF, never leaderboard-ready, cannot wear apex-swe", () => {
    expect(() => SuiteProtocolSelectionSchema.parse({
      schema: "jinn.network/benchmark-product/suite-protocol-selection/1",
      protocol: "apex-swe",
      coverage: "full",
      datasetId: "mercor/APEX-SWE",
      datasetRevision: "a".repeat(40),
      selectedTaskNames: ["0xpolygon-bor-1710-observability"],
      datasetTaskCount: 50,
      replicates: 1,
      atifRequired: false,
      items: [{
        taskName: "0xpolygon-bor-1710-observability",
        taskSha256: "b".repeat(64),
        taskType: "observability",
      }],
    })).toThrow();
    const suite = SuiteProtocolSelectionSchema.parse({
      schema: "jinn.network/benchmark-product/suite-protocol-selection/1",
      protocol: "apex-swe-dev",
      coverage: "one_task",
      datasetId: "mercor/APEX-SWE",
      datasetRevision: "a".repeat(40),
      selectedTaskNames: ["0xpolygon-bor-1710-observability"],
      datasetTaskCount: 50,
      replicates: 1,
      atifRequired: false,
      items: [{
        taskName: "0xpolygon-bor-1710-observability",
        taskSha256: "b".repeat(64),
        taskType: "observability",
      }],
    });
    expect(suite.protocol).toBe("apex-swe-dev");
    expect(suite.replicates).toBe(1);
    expect(suite.atifRequired).toBe(false);
    const method = {
      protocol: "apex-swe-dev" as const,
      coverage: "full" as const,
      executionConformance: true,
      k: 1,
      selectedCount: 50,
      datasetCount: 50,
      atifPresent: false,
      datasetRevisionMatchesLeaderboardPin: true,
    };
    expect(methodLeaderboardEligible(method)).toBe(false);
    expect(deriveSuiteComparability(method).leaderboardSubmitReady).toBe(false);
    expect(deriveSuiteComparability({
      ...method,
      cellsAccounted: true,
      harnessReportsPresent: true,
    }).leaderboardSubmitReady).toBe(false);
    const bits = deriveSuiteComparability({
      protocol: "apex-swe-dev",
      coverage: "one_task",
      executionConformance: true,
      k: 1,
      selectedCount: 1,
      datasetCount: 50,
      atifPresent: false,
    });
    expect(bits).toEqual({ executionConformance: true, coverage: "one_task", leaderboardSubmitReady: false });
    expect(suiteLeaderboardLimitation(bits, "apex-swe-dev")).toMatch(/APEX-SWE-dev/u);
    expect(suiteLeaderboardLimitation(bits, "apex-swe-dev")).toMatch(/200-task APEX-SWE leaderboard/u);
    expect(suiteLeaderboardLimitation(bits, "apex-swe-dev")).not.toMatch(/Terminal-Bench/u);
    expect(officialApexSweDevConformance({
      k: 1,
      nTrials: 1,
      timeoutSeconds: 3600,
      timeoutOverride: false,
      resourceOverride: false,
      evaluatorId: "apex-swe-dev",
      messageLimit: 250,
    })).toBe(true);
    expect(officialApexSweDevConformance({
      k: 1,
      nTrials: 3,
      timeoutSeconds: 3600,
      timeoutOverride: false,
      resourceOverride: false,
      evaluatorId: "apex-swe-dev",
    })).toBe(false);
    expect(officialApexSweDevConformance({
      k: 1,
      nTrials: 1,
      timeoutSeconds: 900,
      timeoutOverride: false,
      resourceOverride: false,
      evaluatorId: "apex-swe-dev",
    })).toBe(false);
    expect(officialApexSweDevConformance({
      k: 1,
      nTrials: 1,
      timeoutSeconds: 3600,
      timeoutOverride: false,
      resourceOverride: false,
      evaluatorId: "inspect",
    })).toBe(false);
  });
});
