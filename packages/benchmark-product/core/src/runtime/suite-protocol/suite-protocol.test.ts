import { describe, expect, test } from "vitest";
import {
  coverageFromSelectedNames,
  namedSliceTaskNames,
  SuiteProtocolSelectionSchema,
} from "./manifest.js";
import {
  APEX_AGENTS_NOT_LEADERBOARD_READY_LIMITATION,
  deriveSuiteComparability,
  methodLeaderboardEligible,
  officialArchipelagoConformance,
  officialHarborExecutionConformance,
  officialSwebenchHarnessConformance,
  SWE_BENCH_VERIFIED_NOT_LEADERBOARD_READY_LIMITATION,
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

describe("SWE-bench Verified suite comparability", () => {
  test("Verified schema is k=1 with no ATIF and a HuggingFace revision", () => {
    expect(() => SuiteProtocolSelectionSchema.parse({
      schema: "jinn.network/benchmark-product/suite-protocol-selection/1",
      protocol: "swe-bench-verified",
      coverage: "one_task",
      datasetId: "princeton-nlp/SWE-bench_Verified",
      datasetRevision: "c104f840cc67f8b6eec6f759ebc8b2693d585d4a",
      selectedTaskNames: ["inst00"],
      datasetTaskCount: 12,
      replicates: 1,
      atifRequired: false,
      items: [{ taskName: "inst00", taskSha256: "b".repeat(64) }],
    })).not.toThrow();
    expect(() => SuiteProtocolSelectionSchema.parse({
      schema: "jinn.network/benchmark-product/suite-protocol-selection/1",
      protocol: "swe-bench-verified",
      coverage: "one_task",
      datasetId: "princeton-nlp/SWE-bench_Verified",
      datasetRevision: `sha256:${"a".repeat(64)}`,
      selectedTaskNames: ["inst00"],
      datasetTaskCount: 12,
      replicates: 5,
      atifRequired: true,
      items: [{ taskName: "inst00", taskSha256: "b".repeat(64) }],
    })).toThrow();
  });

  test("1-instance × 1 with official harness is protocol-faithful and not leaderboard-ready", () => {
    expect(officialSwebenchHarnessConformance({
      k: 1,
      harnessVersion: "4.1.0",
      timeoutSeconds: 1800,
      timeoutOverride: false,
      resourceOverride: false,
      evaluatorId: "swebench-harness",
    })).toBe(true);
    const bits = deriveSuiteComparability({
      protocol: "swe-bench-verified",
      coverage: "one_task",
      executionConformance: true,
      k: 1,
      selectedCount: 1,
      datasetCount: 12,
      atifPresent: false,
    });
    expect(bits).toEqual({ executionConformance: true, coverage: "one_task", leaderboardSubmitReady: false });
    expect(suiteLeaderboardLimitation(bits, "swe-bench-verified")).toBe(SWE_BENCH_VERIFIED_NOT_LEADERBOARD_READY_LIMITATION);
    expect(suiteLeaderboardLimitation(bits, "swe-bench-verified")).not.toMatch(/Terminal-Bench/u);
  });

  test("full coverage + k=1 + pin match is method-eligible, not ready until collect reports", () => {
    const method = {
      protocol: "swe-bench-verified" as const,
      coverage: "full" as const,
      executionConformance: true,
      k: 1,
      selectedCount: 12,
      datasetCount: 12,
      atifPresent: false,
      datasetRevisionMatchesLeaderboardPin: true,
    };
    expect(methodLeaderboardEligible(method)).toBe(true);
    expect(deriveSuiteComparability(method).leaderboardSubmitReady).toBe(false);
    expect(deriveSuiteComparability({ ...method, cellsAccounted: true, atifOnRetainedJob: true }).leaderboardSubmitReady).toBe(false);
    const bits = deriveSuiteComparability({ ...method, cellsAccounted: true, harnessReportsPresent: true });
    expect(bits.leaderboardSubmitReady).toBe(true);
    expect(suiteLeaderboardLimitation(bits, "swe-bench-verified")).toBeUndefined();
  });

  test("Verified k=5 or swe-rebench evaluator is not conforming or eligible", () => {
    expect(officialSwebenchHarnessConformance({
      k: 5,
      harnessVersion: "4.1.0",
      timeoutSeconds: 1800,
      timeoutOverride: false,
      resourceOverride: false,
      evaluatorId: "swebench-harness",
    })).toBe(false);
    expect(officialSwebenchHarnessConformance({
      k: 1,
      harnessVersion: "4.1.0",
      timeoutSeconds: 1800,
      timeoutOverride: false,
      resourceOverride: false,
      evaluatorId: "swe-rebench",
    })).toBe(false);
    expect(officialSwebenchHarnessConformance({
      k: 1,
      harnessVersion: "4.1.0",
      timeoutSeconds: 900,
      timeoutOverride: true,
      resourceOverride: false,
      evaluatorId: "swebench-harness",
    })).toBe(false);
    expect(methodLeaderboardEligible({
      protocol: "swe-bench-verified",
      coverage: "full",
      executionConformance: true,
      k: 5,
      selectedCount: 12,
      datasetCount: 12,
      atifPresent: false,
    })).toBe(false);
  });
});

describe("APEX-Agents suite comparability", () => {
  test("APEX-Agents schema is k=1 with no ATIF and a HuggingFace revision", () => {
    expect(() => SuiteProtocolSelectionSchema.parse({
      schema: "jinn.network/benchmark-product/suite-protocol-selection/1",
      protocol: "apex-agents",
      coverage: "one_task",
      datasetId: "mercor/apex-agents",
      datasetRevision: "92c86856cf1b11f9833a8a076b3a45a63afa3929",
      selectedTaskNames: ["task_00"],
      datasetTaskCount: 12,
      replicates: 1,
      atifRequired: false,
      items: [{ taskName: "task_00", taskSha256: "b".repeat(64) }],
    })).not.toThrow();
    expect(() => SuiteProtocolSelectionSchema.parse({
      schema: "jinn.network/benchmark-product/suite-protocol-selection/1",
      protocol: "apex-agents",
      coverage: "one_task",
      datasetId: "mercor/apex-agents",
      datasetRevision: `sha256:${"a".repeat(64)}`,
      selectedTaskNames: ["task_00"],
      datasetTaskCount: 12,
      replicates: 5,
      atifRequired: true,
      items: [{ taskName: "task_00", taskSha256: "b".repeat(64) }],
    })).toThrow();
  });

  test("1-task × 1 with official Archipelago is protocol-faithful and not leaderboard-ready", () => {
    expect(officialArchipelagoConformance({
      k: 1,
      archipelagoCommit: "0cb5c476c219a9df637e0bd37fb86b2361f4ab89",
      agentId: "react_toolbelt_agent",
      maxSteps: 250,
      timeoutSeconds: 10800,
      judgeModel: "gemini-3-flash",
      judgeThinking: "low",
      webSearch: false,
      timeoutOverride: false,
      resourceOverride: false,
      evaluatorId: "archipelago",
    })).toBe(true);
    const bits = deriveSuiteComparability({
      protocol: "apex-agents",
      coverage: "one_task",
      executionConformance: true,
      k: 1,
      selectedCount: 1,
      datasetCount: 12,
      atifPresent: false,
    });
    expect(bits).toEqual({ executionConformance: true, coverage: "one_task", leaderboardSubmitReady: false });
    expect(suiteLeaderboardLimitation(bits, "apex-agents")).toBe(APEX_AGENTS_NOT_LEADERBOARD_READY_LIMITATION);
    expect(suiteLeaderboardLimitation(bits, "apex-agents")).not.toMatch(/Terminal-Bench/u);
    expect(suiteLeaderboardLimitation(bits, "apex-agents")).not.toMatch(/SWE-bench/u);
  });

  test("full coverage + k=1 + pin match is method-eligible, not ready until collect grades", () => {
    const method = {
      protocol: "apex-agents" as const,
      coverage: "full" as const,
      executionConformance: true,
      k: 1,
      selectedCount: 12,
      datasetCount: 12,
      atifPresent: false,
      datasetRevisionMatchesLeaderboardPin: true,
    };
    expect(methodLeaderboardEligible(method)).toBe(true);
    expect(deriveSuiteComparability(method).leaderboardSubmitReady).toBe(false);
    expect(deriveSuiteComparability({ ...method, cellsAccounted: true, harnessReportsPresent: true }).leaderboardSubmitReady).toBe(false);
    const bits = deriveSuiteComparability({ ...method, cellsAccounted: true, archipelagoGradesPresent: true });
    expect(bits.leaderboardSubmitReady).toBe(true);
    expect(suiteLeaderboardLimitation(bits, "apex-agents")).toBeUndefined();
  });

  test("APEX-Agents k=8, Code/Codex agent, or Harbor evaluator is not conforming or eligible", () => {
    const official = {
      k: 1,
      archipelagoCommit: "0cb5c476c219a9df637e0bd37fb86b2361f4ab89",
      agentId: "react_toolbelt_agent" as const,
      maxSteps: 250,
      timeoutSeconds: 10800,
      judgeModel: "gemini-3-flash",
      judgeThinking: "low" as const,
      webSearch: false,
      timeoutOverride: false,
      resourceOverride: false,
      evaluatorId: "archipelago",
    };
    expect(officialArchipelagoConformance({ ...official, k: 8 })).toBe(false);
    expect(officialArchipelagoConformance({ ...official, agentId: "claude-code" })).toBe(false);
    expect(officialArchipelagoConformance({ ...official, evaluatorId: "harbor" })).toBe(false);
    expect(officialArchipelagoConformance({ ...official, webSearch: true })).toBe(false);
    expect(officialArchipelagoConformance({ ...official, judgeThinking: "high" })).toBe(false);
    expect(officialArchipelagoConformance({ ...official, maxSteps: 50 })).toBe(false);
    expect(methodLeaderboardEligible({
      protocol: "apex-agents",
      coverage: "full",
      executionConformance: true,
      k: 8,
      selectedCount: 12,
      datasetCount: 12,
      atifPresent: false,
    })).toBe(false);
  });
});
