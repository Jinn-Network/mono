import { describe, expect, test } from "vitest";
import {
  coverageFromSelectedNames,
  namedSliceTaskNames,
  SuiteProtocolSelectionSchema,
} from "./manifest.js";
import {
  deriveSuiteComparability,
  INSPECT_AS_SPECIFIED_NOT_LEADERBOARD_READY_LIMITATION,
  methodLeaderboardEligible,
  officialHarborExecutionConformance,
  officialInspectAsSpecifiedConformance,
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
});

const inspectSamples = [
  "HumanEval/0", "s01", "s02", "s03", "s04", "s05", "s06", "s07", "s08", "s09", "s10", "s11",
];

describe("inspect-as-specified suite protocol", () => {
  test("lexicographic first 1 / first 10 / all includes sample ids with slashes", () => {
    expect(namedSliceTaskNames(inspectSamples, "one_task")).toEqual(["HumanEval/0"]);
    expect(namedSliceTaskNames(inspectSamples, "ten_task")).toHaveLength(10);
    expect(coverageFromSelectedNames(inspectSamples, ["HumanEval/0"])).toBe("one_task");
    expect(coverageFromSelectedNames(inspectSamples, ["s11"])).toBe("custom");
  });

  test("seals inspect-as-specified items whose names contain slashes", () => {
    expect(() => SuiteProtocolSelectionSchema.parse({
      schema: "jinn.network/benchmark-product/suite-protocol-selection/1",
      protocol: "inspect-as-specified",
      coverage: "one_task",
      datasetId: "inspect_evals/humaneval",
      datasetRevision: "a".repeat(64),
      selectedTaskNames: ["HumanEval/0"],
      datasetTaskCount: 12,
      replicates: 1,
      atifRequired: false,
      items: [{ taskName: "HumanEval/0", taskSha256: "b".repeat(64) }],
    })).not.toThrow();
  });

  test("terminal-bench-2.1 still refuses slash sample names", () => {
    expect(() => SuiteProtocolSelectionSchema.parse({
      schema: "jinn.network/benchmark-product/suite-protocol-selection/1",
      protocol: "terminal-bench-2.1",
      coverage: "one_task",
      datasetId: "terminal-bench/terminal-bench-2-1",
      datasetRevision: `sha256:${"a".repeat(64)}`,
      selectedTaskNames: ["HumanEval/0"],
      datasetTaskCount: 12,
      replicates: 5,
      atifRequired: true,
      items: [{ taskName: "HumanEval/0", taskSha256: "b".repeat(64) }],
    })).toThrow();
  });

  test("one_task × k=1 with official inspect settings is not as-specified ready", () => {
    expect(officialInspectAsSpecifiedConformance({
      k: 1,
      specifiedEpochs: 1,
      inspectVersion: "0.3.255",
      adapterId: "inspect",
      solver: "task-default",
      sampleLimit: null,
      epochsInRunOptions: false,
    })).toBe(true);
    const bits = deriveSuiteComparability({
      protocol: "inspect-as-specified",
      coverage: "one_task",
      executionConformance: true,
      k: 1,
      selectedCount: 1,
      datasetCount: 12,
      atifPresent: false,
    });
    expect(bits.leaderboardSubmitReady).toBe(false);
    expect(suiteLeaderboardLimitation(bits, "inspect-as-specified")).toBe(
      INSPECT_AS_SPECIFIED_NOT_LEADERBOARD_READY_LIMITATION,
    );
  });

  test("full inspect catalog + k matching epochs is method-eligible, not ready until collect", () => {
    const method = {
      protocol: "inspect-as-specified" as const,
      coverage: "full" as const,
      executionConformance: true,
      k: 3,
      selectedCount: 12,
      datasetCount: 12,
      atifPresent: false,
      datasetRevisionMatchesLeaderboardPin: true,
    };
    expect(methodLeaderboardEligible(method)).toBe(true);
    expect(deriveSuiteComparability(method).leaderboardSubmitReady).toBe(false);
    expect(deriveSuiteComparability({ ...method, cellsAccounted: true }).leaderboardSubmitReady).toBe(true);
    expect(deriveSuiteComparability({
      ...method,
      cellsAccounted: true,
      atifOnRetainedJob: true,
    }).leaderboardSubmitReady).toBe(true);
  });

  test("solver override, --limit, epochs in runOptions, or k mismatch break inspect conformance", () => {
    const base = {
      k: 1,
      specifiedEpochs: 1,
      inspectVersion: "0.3.255",
      adapterId: "inspect" as const,
      solver: "task-default" as const,
      sampleLimit: null as number | null,
      epochsInRunOptions: false,
    };
    expect(officialInspectAsSpecifiedConformance({ ...base, solver: "react" })).toBe(false);
    expect(officialInspectAsSpecifiedConformance({ ...base, sampleLimit: 10 })).toBe(false);
    expect(officialInspectAsSpecifiedConformance({ ...base, epochsInRunOptions: true })).toBe(false);
    expect(officialInspectAsSpecifiedConformance({ ...base, k: 2 })).toBe(false);
    expect(officialInspectAsSpecifiedConformance({ ...base, inspectVersion: "0.3.200" })).toBe(false);
    expect(officialInspectAsSpecifiedConformance({ ...base, adapterId: "harbor" })).toBe(false);
  });
});
