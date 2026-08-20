import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";
import {
  coverageFromSelectedNames,
  namedSliceTaskNames,
  SuiteProtocolSelectionSchema,
} from "./manifest.js";
import {
  APEX_AGENTS_NOT_LEADERBOARD_READY_LIMITATION,
  CERTIFICATION_ACCOUNTING_DIVERGENCE_SENTENCE,
  DEEPSWE_NOT_LEADERBOARD_READY_LIMITATION,
  deriveSuiteComparability,
  exportCompletenessCertification,
  INSPECT_EVAL_NOT_LEADERBOARD_READY_LIMITATION,
  INSPECT_EVAL_SUBMIT_CLOSED_SENTENCE,
  methodLeaderboardEligible,
  officialArchipelagoConformance,
  officialApexSweDevConformance,
  officialHarborExecutionConformance,
  officialInspectEvalConformance,
  officialPierExecutionConformance,
  officialSwebenchHarnessConformance,
  SWE_BENCH_VERIFIED_NOT_LEADERBOARD_READY_LIMITATION,
  suiteLeaderboardLimitation,
  suiteProtocolDisplayName,
  SUITE_NOT_LEADERBOARD_READY_LIMITATION,
  SUITE_PROTOCOL_IDS,
  type DeriveSuiteComparabilityInput,
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

  test("Terminal-Bench 3.0 is a distinct protocol with 3.0 limitation copy", () => {
    expect(() => SuiteProtocolSelectionSchema.parse({
      schema: "jinn.network/benchmark-product/suite-protocol-selection/1",
      protocol: "terminal-bench-3.0",
      coverage: "one_task",
      datasetId: "terminal-bench/terminal-bench",
      datasetRevision: `sha256:${"a".repeat(64)}`,
      selectedTaskNames: ["t00"],
      datasetTaskCount: 12,
      replicates: 5,
      atifRequired: true,
      items: [{ taskName: "t00", taskSha256: "b".repeat(64) }],
    })).not.toThrow();
    expect(() => SuiteProtocolSelectionSchema.parse({
      schema: "jinn.network/benchmark-product/suite-protocol-selection/1",
      protocol: "terminal-bench-3.0",
      coverage: "one_task",
      datasetId: "terminal-bench/terminal-bench-2-1",
      datasetRevision: `sha256:${"a".repeat(64)}`,
      selectedTaskNames: ["t00"],
      datasetTaskCount: 12,
      replicates: 5,
      atifRequired: true,
      items: [{ taskName: "t00", taskSha256: "b".repeat(64) }],
    })).toThrow();
    const bits = deriveSuiteComparability({
      coverage: "one_task",
      executionConformance: true,
      k: 5,
      selectedCount: 1,
      datasetCount: 12,
      atifPresent: true,
    });
    expect(bits.leaderboardSubmitReady).toBe(false);
    expect(suiteLeaderboardLimitation(bits, "terminal-bench-3.0")).toMatch(/not a Terminal-Bench 3\.0 leaderboard submission/u);
    expect(suiteLeaderboardLimitation(bits, "terminal-bench-3.0")).not.toMatch(/Terminal-Bench 2\.1/u);
  });

  test("every suite protocol id has its own display name for shared refusal copy", () => {
    expect(suiteProtocolDisplayName("terminal-bench-2.1")).toBe("Terminal-Bench 2.1");
    expect(suiteProtocolDisplayName("terminal-bench-3.0")).toBe("Terminal-Bench 3.0");
    expect(new Set(SUITE_PROTOCOL_IDS.map(suiteProtocolDisplayName)).size).toBe(SUITE_PROTOCOL_IDS.length);
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

describe("APEX-SWE-dev suite comparability", () => {
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

const inspectSamples = [
  "HumanEval/0", "s01", "s02", "s03", "s04", "s05", "s06", "s07", "s08", "s09", "s10", "s11",
];

describe("inspect-eval suite protocol", () => {
  test("lexicographic first 1 / first 10 / all includes sample ids with slashes", () => {
    expect(namedSliceTaskNames(inspectSamples, "one_task")).toEqual(["HumanEval/0"]);
    expect(namedSliceTaskNames(inspectSamples, "ten_task")).toHaveLength(10);
    expect(coverageFromSelectedNames(inspectSamples, ["HumanEval/0"])).toBe("one_task");
    expect(coverageFromSelectedNames(inspectSamples, ["s11"])).toBe("custom");
  });

  test("seals inspect-eval items whose names contain slashes", () => {
    expect(() => SuiteProtocolSelectionSchema.parse({
      schema: "jinn.network/benchmark-product/suite-protocol-selection/1",
      protocol: "inspect-eval",
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

  test("one_task × k=1 with official inspect settings is not eval complete", () => {
    expect(officialInspectEvalConformance({
      k: 1,
      specifiedEpochs: 1,
      inspectVersion: "0.3.255",
      adapterId: "inspect",
      solver: "task-default",
      sampleLimit: null,
      epochsInRunOptions: false,
    })).toBe(true);
    const bits = deriveSuiteComparability({
      protocol: "inspect-eval",
      coverage: "one_task",
      executionConformance: true,
      k: 1,
      selectedCount: 1,
      datasetCount: 12,
      atifPresent: false,
    });
    expect(bits.leaderboardSubmitReady).toBe(false);
    expect(suiteLeaderboardLimitation(bits, "inspect-eval")).toBe(
      INSPECT_EVAL_NOT_LEADERBOARD_READY_LIMITATION,
    );
  });

  test("full inspect catalog + k matching epochs is method-eligible, not ready until collect", () => {
    const method = {
      protocol: "inspect-eval" as const,
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

  test("a ready inspect-eval run still carries the Inspect-named closed-submissions sentence", () => {
    // `suiteComparability` on the claim is three protocol-agnostic booleans written by both
    // protocols. If the ready path emitted no limitation, a ready Inspect eval claim would
    // name Inspect nowhere and read as a Terminal-Bench 2.1 leaderboard-ready claim.
    const ready = deriveSuiteComparability({
      protocol: "inspect-eval",
      coverage: "full",
      executionConformance: true,
      k: 3,
      selectedCount: 12,
      datasetCount: 12,
      atifPresent: false,
      datasetRevisionMatchesLeaderboardPin: true,
      cellsAccounted: true,
    });
    expect(ready.leaderboardSubmitReady).toBe(true);
    expect(suiteLeaderboardLimitation(ready, "inspect-eval")).toBe(INSPECT_EVAL_SUBMIT_CLOSED_SENTENCE);
    // TB 2.1's ready path is unchanged — its closed-submissions copy rides on the Hub export.
    expect(suiteLeaderboardLimitation(ready, "terminal-bench-2.1")).toBeUndefined();
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
    expect(officialInspectEvalConformance({ ...base, solver: "react" })).toBe(false);
    expect(officialInspectEvalConformance({ ...base, sampleLimit: 10 })).toBe(false);
    expect(officialInspectEvalConformance({ ...base, epochsInRunOptions: true })).toBe(false);
    expect(officialInspectEvalConformance({ ...base, k: 2 })).toBe(false);
    expect(officialInspectEvalConformance({ ...base, inspectVersion: "0.3.200" })).toBe(false);
    expect(officialInspectEvalConformance({ ...base, adapterId: "harbor" })).toBe(false);
  });
});

describe("exportCompletenessCertification (§8.2 clause 2)", () => {
  const runSha256 = "a".repeat(64);

  test("complete run states the sealed runOutcome, digest, and counts, computing nothing", () => {
    expect(exportCompletenessCertification({
      runSha256,
      completeness: { expected: 12, judged: 12, runOutcome: "complete" },
    })).toBe(`complete run of the selection sealed at lock ${runSha256}: 12 of 12 cells judged.`);
  });

  test("partial run renders the sealed partial outcome and counts as-is, without reconciling them", () => {
    expect(exportCompletenessCertification({
      runSha256,
      completeness: { expected: 12, judged: 7, runOutcome: "partial" },
    })).toBe(`partial run of the selection sealed at lock ${runSha256}: 7 of 12 cells judged.`);
  });

  test("cancelled run renders too — the first word is the sealed runOutcome, not a derived label", () => {
    expect(exportCompletenessCertification({
      runSha256,
      completeness: { expected: 12, judged: 3, runOutcome: "cancelled" },
    })).toBe(`cancelled run of the selection sealed at lock ${runSha256}: 3 of 12 cells judged.`);
  });

  test("no sealed Matrix states the lock digest without claiming a completeness it cannot see", () => {
    expect(exportCompletenessCertification({ runSha256 })).toBe(
      `no sealed Matrix: completeness of the selection sealed at lock ${runSha256} is not yet certified.`,
    );
  });
});

describe("accounting divergence explanation (operator ruling of 2026-08-20, option c)", () => {
  const runSha256 = "b".repeat(64);

  test("a not-complete outcome under a submit-ready framework verdict appends the one explanatory sentence", () => {
    expect(exportCompletenessCertification({
      runSha256,
      completeness: { expected: 12, judged: 11, runOutcome: "partial" },
      frameworkSubmitReady: true,
    })).toBe(
      `partial run of the selection sealed at lock ${runSha256}: 11 of 12 cells judged. ${CERTIFICATION_ACCOUNTING_DIVERGENCE_SENTENCE}`,
    );
    expect(exportCompletenessCertification({
      runSha256,
      completeness: { expected: 12, judged: 11, runOutcome: "partial" },
      frameworkSubmitReady: true,
    }).includes("\n")).toBe(false);
    // "not complete" is the condition, not "partial": a cancelled outcome under a submit-ready
    // verdict is the same divergence and reads the same explanation.
    expect(exportCompletenessCertification({
      runSha256,
      completeness: { expected: 12, judged: 3, runOutcome: "cancelled" },
      frameworkSubmitReady: true,
    })).toBe(
      `cancelled run of the selection sealed at lock ${runSha256}: 3 of 12 cells judged. ${CERTIFICATION_ACCOUNTING_DIVERGENCE_SENTENCE}`,
    );
  });

  test("no divergence, no sentence: agreeing lines and an uncertified selection stay one bare line", () => {
    // Agreement, submit-ready side: nothing to reconcile.
    expect(exportCompletenessCertification({
      runSha256,
      completeness: { expected: 12, judged: 12, runOutcome: "complete" },
      frameworkSubmitReady: true,
    })).toBe(`complete run of the selection sealed at lock ${runSha256}: 12 of 12 cells judged.`);
    // Agreement, not-ready side: the instructions already say this is not a submission.
    expect(exportCompletenessCertification({
      runSha256,
      completeness: { expected: 12, judged: 11, runOutcome: "partial" },
      frameworkSubmitReady: false,
    })).toBe(`partial run of the selection sealed at lock ${runSha256}: 11 of 12 cells judged.`);
    // Omitting the verdict is the not-ready case, so APEX-SWE-dev (never submit-ready) and any
    // other caller that passes nothing keep their exact bytes.
    expect(exportCompletenessCertification({
      runSha256,
      completeness: { expected: 12, judged: 11, runOutcome: "partial" },
    })).toBe(`partial run of the selection sealed at lock ${runSha256}: 11 of 12 cells judged.`);
    // No sealed Matrix quotes no runOutcome, so there is no divergence to explain even if the
    // caller reports submit-ready.
    expect(exportCompletenessCertification({ runSha256, frameworkSubmitReady: true })).toBe(
      `no sealed Matrix: completeness of the selection sealed at lock ${runSha256} is not yet certified.`,
    );
  });

  test("eligibility outputs match the origin/next characterization, even with completeness smuggled in", () => {
    const cases: readonly {
      readonly name: string;
      readonly input: DeriveSuiteComparabilityInput;
      readonly eligible: boolean;
      readonly ready: boolean;
    }[] = [
      {
        name: "tb2.1 quote-time eligible is not ready",
        input: { coverage: "full", executionConformance: true, k: 5, selectedCount: 12, datasetCount: 12, atifPresent: true },
        eligible: true,
        ready: false,
      },
      {
        name: "tb2.1 collected is ready",
        input: {
          coverage: "full", executionConformance: true, k: 5, selectedCount: 12, datasetCount: 12, atifPresent: true,
          cellsAccounted: true, atifOnRetainedJob: true,
        },
        eligible: true,
        ready: true,
      },
      {
        name: "tb2.1 custom never ready",
        input: {
          coverage: "custom", executionConformance: true, k: 5, selectedCount: 3, datasetCount: 12, atifPresent: true,
          cellsAccounted: true, atifOnRetainedJob: true,
        },
        eligible: false,
        ready: false,
      },
      {
        name: "tb3.0 collected is ready",
        input: {
          protocol: "terminal-bench-3.0", coverage: "full", executionConformance: true, k: 5, selectedCount: 12,
          datasetCount: 12, atifPresent: true, cellsAccounted: true, atifOnRetainedJob: true,
        },
        eligible: true,
        ready: true,
      },
      {
        name: "swe-bench-verified needs harness reports",
        input: {
          protocol: "swe-bench-verified", coverage: "full", executionConformance: true, k: 1, selectedCount: 12,
          datasetCount: 12, atifPresent: false, cellsAccounted: true,
        },
        eligible: true,
        ready: false,
      },
      {
        name: "swe-bench-verified collected is ready",
        input: {
          protocol: "swe-bench-verified", coverage: "full", executionConformance: true, k: 1, selectedCount: 12,
          datasetCount: 12, atifPresent: false, cellsAccounted: true, harnessReportsPresent: true,
        },
        eligible: true,
        ready: true,
      },
      {
        name: "apex-agents collected is ready",
        input: {
          protocol: "apex-agents", coverage: "full", executionConformance: true, k: 1, selectedCount: 12,
          datasetCount: 12, atifPresent: false, cellsAccounted: true, archipelagoGradesPresent: true,
        },
        eligible: true,
        ready: true,
      },
      {
        name: "apex-swe-dev is never method-eligible",
        input: {
          protocol: "apex-swe-dev", coverage: "full", executionConformance: true, k: 1, selectedCount: 50,
          datasetCount: 50, atifPresent: false, cellsAccounted: true, harnessReportsPresent: true,
        },
        eligible: false,
        ready: false,
      },
      {
        name: "deep-swe collected is ready",
        input: {
          protocol: "deep-swe-v1.1", coverage: "full", executionConformance: true, k: 4, selectedCount: 12,
          datasetCount: 12, atifPresent: true, cellsAccounted: true, atifOnRetainedJob: true, rewardOnRetainedJob: true,
        },
        eligible: true,
        ready: true,
      },
      {
        name: "inspect-eval collected is ready",
        input: {
          protocol: "inspect-eval", coverage: "full", executionConformance: true, k: 1, selectedCount: 12,
          datasetCount: 12, atifPresent: false, cellsAccounted: true,
        },
        eligible: true,
        ready: true,
      },
    ];
    for (const c of cases) {
      expect(methodLeaderboardEligible(c.input), c.name).toBe(c.eligible);
      expect(deriveSuiteComparability(c.input).leaderboardSubmitReady, c.name).toBe(c.ready);
      const smuggled = {
        ...c.input,
        completeness: { expected: 12, judged: 11, runOutcome: "partial" as const },
        runOutcome: "partial" as const,
        judged: 11,
        frameworkSubmitReady: true,
      };
      expect(methodLeaderboardEligible(smuggled), `${c.name} smuggled`).toBe(c.eligible);
      expect(deriveSuiteComparability(smuggled).leaderboardSubmitReady, `${c.name} smuggled`).toBe(c.ready);
    }
  });

  test("eligibility, conformance, and mode-decision function bodies are byte-identical to origin/next", () => {
    const suiteProtocolDir = dirname(fileURLToPath(import.meta.url));
    const operationsDir = join(suiteProtocolDir, "../../operations");
    const files: Readonly<Record<string, string>> = {
      "comparability.ts": readFileSync(join(suiteProtocolDir, "comparability.ts"), "utf8"),
      "hub-export.ts": readFileSync(join(operationsDir, "hub-export.ts"), "utf8"),
      "inspect-view-export.ts": readFileSync(join(operationsDir, "inspect-view-export.ts"), "utf8"),
      "apex-agents-export.ts": readFileSync(join(operationsDir, "apex-agents-export.ts"), "utf8"),
      "apex-swe-export.ts": readFileSync(join(operationsDir, "apex-swe-export.ts"), "utf8"),
      "deepswe-export.ts": readFileSync(join(operationsDir, "deepswe-export.ts"), "utf8"),
      "swebench-export.ts": readFileSync(join(operationsDir, "swebench-export.ts"), "utf8"),
    };
    // SHA-256 of each `export function` body on origin/next (d7d14c1f4). exportCompletenessCertification
    // is the one function this packet is allowed to change; it is deliberately absent.
    const originNext = [
      ["comparability.ts", "methodLeaderboardEligible", "e7b6ef1334df8c1237dc6d17893acbc07ae1d417317dd170d24564dbd65b5f0d"],
      ["comparability.ts", "deriveSuiteComparability", "46ac518245a6e3e053f1bbcc21ecfe42b0de84b193759ffeb788956ca31995f2"],
      ["comparability.ts", "suiteLeaderboardLimitation", "2fcd463df00885e356424e811d273c3a1000a6ca42020c74f8ac7baaea8ad86d"],
      ["comparability.ts", "officialHarborExecutionConformance", "e1ea5f863dbe962be7bdb98432963b5d6f1447d66cadc5c633bfce1f9c324df6"],
      ["comparability.ts", "officialPierExecutionConformance", "ac59ad9125a9037a321ec1181ab569d0f9cdb47aeebd9edd8f6af617f0793c7d"],
      ["comparability.ts", "officialSwebenchHarnessConformance", "1f59fc1f40be033638c3e7f2fef3dc2976917f86a91977a808502c00dc54880b"],
      ["comparability.ts", "officialArchipelagoConformance", "a85b096c19439ea8100536353e8fc05a97c32dac6259d1b5ad6b3a641ac84abd"],
      ["comparability.ts", "officialApexSweDevConformance", "96d513f3e3c076ff3bf38201cfdb839d63ff42a4720fdb78d6a4a8429124240c"],
      ["comparability.ts", "officialInspectEvalConformance", "28431986bcd47d33c218d663c6ad19a37b11f17a3873bd112f5aeca34798b665"],
      ["hub-export.ts", "decideHarborHubExportMode", "6e665145a90dbdcd1d1994187286f434c7441c3033b2c476ed14671f7792276a"],
      ["hub-export.ts", "harborHubExportInstructions", "71ef2f3df522ae12824434bcbf4664a148c69d0bad6c8214cc2c3a4a97855b15"],
      ["inspect-view-export.ts", "decideInspectViewExportMode", "ffea3e4a13381b3d70852849024ea73ebfd93afcb2a65fcae923445530f466d8"],
      ["inspect-view-export.ts", "inspectViewExportInstructions", "b7f9c9d97e6fd4c33e6a84258ad607c6e3acd451a5b2ce238f5e4da5f62e77c5"],
      ["apex-agents-export.ts", "decideApexAgentsExportMode", "633cc0d280af5caff69e3f94268fba6a493003abfd2ae00ad05d85149ed9f85a"],
      ["apex-agents-export.ts", "apexAgentsExportInstructions", "386dd56ee49d7b110c9e746196db79287616b7e8fd6bb68a4e04ca076662fe58"],
      ["apex-swe-export.ts", "decideApexSweExportMode", "40e8f8e3ac357a143e22d2f7cbede8ac86acf22651d2ae3fab4b56a357eeadd4"],
      ["apex-swe-export.ts", "apexSweExportInstructions", "96abfb4af2c797ee89d78eb0fa7092bad22387afb9f4007aaf6fbe31fa192ef4"],
      ["deepswe-export.ts", "decideDeepSweExportMode", "0e6411e29ef67a7785c689fb7bf75e7d624466cec0d50d3b19d6a6d4b64dbd1a"],
      ["deepswe-export.ts", "deepSweExportInstructions", "67bf27a6706789273949a48c89070a07c3b6e5a21fc86cf40107eba8c4db47cb"],
      ["swebench-export.ts", "decideSwebenchPredictionsExportMode", "1ba169c84291aba9c37274849837cd0d3846301a82603ad5265a32e44d70cdeb"],
      ["swebench-export.ts", "swebenchPredictionsExportInstructions", "e4ced1b22d3da919d68ee27c6d8239b598c8d68b796fbb0593c923e9f2d231dc"],
    ] as const;
    for (const [file, name, digest] of originNext) {
      const source = files[file];
      if (source === undefined) throw new Error(`missing fixture file ${file}`);
      expect(sha256Hex(exportedFunctionSource(source, name)), `${file} ${name}`).toBe(digest);
    }
  });
});

function exportedFunctionSource(source: string, name: string): string {
  const needle = `export function ${name}(`;
  const start = source.indexOf(needle);
  if (start < 0) throw new Error(`missing export function ${name}`);
  let depth = 0;
  const open = source.indexOf("{", start);
  if (open < 0) throw new Error(`missing body for ${name}`);
  for (let i = open; i < source.length; i += 1) {
    const ch = source[i];
    if (ch === "{") depth += 1;
    else if (ch === "}") {
      depth -= 1;
      if (depth === 0) return source.slice(start, i + 1);
    }
  }
  throw new Error(`unclosed ${name}`);
}

function sha256Hex(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}
