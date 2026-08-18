import { cellKey } from "@jinn-network/benchmarking-records";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { deriveSuiteComparability, methodLeaderboardEligible } from "./comparability.js";
import type { SuiteProtocolSelection } from "./manifest.js";
import { accountSuiteArmCells, assessArmRunComplete, atifOnRetainedJob } from "./run-complete.js";

const digestA = "a".repeat(64);
const digestB = "b".repeat(64);

const suite: SuiteProtocolSelection = {
  schema: "jinn.network/benchmark-product/suite-protocol-selection/1",
  protocol: "terminal-bench-2.1",
  coverage: "full",
  datasetId: "terminal-bench/terminal-bench-2-1",
  datasetRevision: `sha256:${"c".repeat(64)}`,
  selectedTaskNames: ["t00", "t01"],
  datasetTaskCount: 2,
  replicates: 5,
  atifRequired: true,
  items: [
    { taskName: "t00", taskSha256: digestA },
    { taskName: "t01", taskSha256: digestB },
  ],
};

const eligibleInput = {
  coverage: "full" as const,
  executionConformance: true,
  k: 5,
  selectedCount: 2,
  datasetCount: 2,
  atifPresent: true,
  datasetRevisionMatchesLeaderboardPin: true,
};

function cells(outcome: "judged" | "unscorable" | "expired" = "judged", skip?: string) {
  return suite.items.flatMap((item) => Array.from({ length: 5 }, (_, index) => {
    const replicate = index + 1;
    const key = cellKey(item.taskSha256, "one", replicate);
    return {
      cellKey: key,
      taskDigest: item.taskSha256,
      armId: "one",
      replicate,
      outcome: key === skip ? "expired" as const : outcome,
    };
  }));
}

function writeTrial(jobDir: string, name: string, taskName: string, attempt: number, atif: boolean): void {
  const trial = join(jobDir, name);
  mkdirSync(join(trial, "agent"), { recursive: true });
  writeFileSync(join(trial, "config.json"), JSON.stringify({ task: { name: taskName }, attempt }));
  if (atif) {
    writeFileSync(join(trial, "agent", "recording.cast"), Buffer.from([0, 255, 1]));
    writeFileSync(join(trial, "agent", "trajectory.json"), JSON.stringify({ schema: "ATIF" }));
  }
}

describe("suite run-complete assessor", () => {
  let root: string;
  afterEach(() => {
    if (root !== undefined) rmSync(root, { recursive: true, force: true });
  });

  test("quote-time method-eligible full coverage is not leaderboard_submit_ready", () => {
    expect(methodLeaderboardEligible(eligibleInput)).toBe(true);
    expect(deriveSuiteComparability(eligibleInput).leaderboardSubmitReady).toBe(false);
    expect(deriveSuiteComparability({
      ...eligibleInput,
      cellsAccounted: true,
      atifOnRetainedJob: true,
    }).leaderboardSubmitReady).toBe(true);
  });

  test("method-eligible + all judged + ATIF is ready", () => {
    root = mkdtempSync(join(tmpdir(), "suite-complete-"));
    const jobDir = join(root, "job");
    mkdirSync(jobDir);
    writeFileSync(join(jobDir, "result.json"), JSON.stringify({ status: "success" }));
    let index = 0;
    for (const item of suite.items) {
      for (let attempt = 1; attempt <= 5; attempt += 1) {
        index += 1;
        writeTrial(jobDir, `trial-${index}`, item.taskName, attempt, true);
      }
    }
    const matrix = { cells: cells("judged") };
    expect(accountSuiteArmCells(matrix, suite, "one")).toBe(true);
    expect(atifOnRetainedJob(jobDir, suite, matrix, "one")).toBe(true);
    const complete = assessArmRunComplete({ matrix, suite, armId: "one", jobDir });
    expect(complete).toEqual({ cellsAccounted: true, atifOnRetainedJob: true, rewardOnRetainedJob: true });
    expect(deriveSuiteComparability({ ...eligibleInput, ...complete }).leaderboardSubmitReady).toBe(true);
  });

  test("missing cell or expired hole is not accounted", () => {
    const hole = cellKey(digestB, "one", 3);
    expect(accountSuiteArmCells({ cells: cells("judged", hole) }, suite, "one")).toBe(false);
    expect(accountSuiteArmCells({ cells: cells("judged").slice(0, 9) }, suite, "one")).toBe(false);
  });

  test("unscorable cell is accounted as Harbor-error 0", () => {
    const mixed = cells("judged").map((cell) => (
      cell.replicate === 2 && cell.taskDigest === digestA ? { ...cell, outcome: "unscorable" } : cell
    ));
    expect(accountSuiteArmCells({ cells: mixed }, suite, "one")).toBe(true);
  });

  test("judged trial without ATIF is not ready", () => {
    root = mkdtempSync(join(tmpdir(), "suite-complete-"));
    const jobDir = join(root, "job");
    mkdirSync(jobDir);
    let index = 0;
    for (const item of suite.items) {
      for (let attempt = 1; attempt <= 5; attempt += 1) {
        index += 1;
        writeTrial(jobDir, `trial-${index}`, item.taskName, attempt, !(item.taskName === "t00" && attempt === 1));
      }
    }
    const matrix = { cells: cells("judged") };
    expect(accountSuiteArmCells(matrix, suite, "one")).toBe(true);
    expect(atifOnRetainedJob(jobDir, suite, matrix, "one")).toBe(false);
  });

  test("accountSuiteArmCells loops inspect-eval replicates when k>1", () => {
    const inspectSuite: SuiteProtocolSelection = {
      schema: "jinn.network/benchmark-product/suite-protocol-selection/1",
      protocol: "inspect-eval",
      coverage: "one_task",
      datasetId: "hermetic",
      datasetRevision: "c".repeat(64),
      selectedTaskNames: ["HumanEval/0"],
      datasetTaskCount: 2,
      replicates: 3,
      atifRequired: false,
      items: [{ taskName: "HumanEval/0", taskSha256: digestA }],
    };
    const complete = [1, 2, 3].map((replicate) => ({
      cellKey: cellKey(digestA, "one", replicate),
      taskDigest: digestA,
      armId: "one",
      replicate,
      outcome: "judged" as const,
    }));
    expect(accountSuiteArmCells({ cells: complete }, inspectSuite, "one")).toBe(true);
    expect(accountSuiteArmCells({ cells: complete.slice(0, 2) }, inspectSuite, "one")).toBe(false);
  });

  test("job result.json only is not ATIF", () => {
    root = mkdtempSync(join(tmpdir(), "suite-complete-"));
    const jobDir = join(root, "job");
    mkdirSync(jobDir);
    writeFileSync(join(jobDir, "result.json"), JSON.stringify({ status: "success" }));
    const matrix = { cells: cells("judged") };
    expect(accountSuiteArmCells(matrix, suite, "one")).toBe(true);
    expect(atifOnRetainedJob(jobDir, suite, matrix, "one")).toBe(false);
    expect(assessArmRunComplete({ matrix, suite, armId: "one", jobDir }).atifOnRetainedJob).toBe(false);
  });
});

const deepsweSuite: SuiteProtocolSelection = {
  schema: "jinn.network/benchmark-product/suite-protocol-selection/1",
  protocol: "deep-swe-v1.1",
  coverage: "full",
  datasetId: "datacurve-ai/deep-swe",
  datasetRevision: "435ee89ec2f2e2289f33b0da4f992f0b7b7266b9",
  tasksTreeSha: "66df25a1b382017d0ae014d94cadb2698baaed48",
  selectedTaskNames: ["t00"],
  datasetTaskCount: 1,
  replicates: 4,
  atifRequired: true,
  items: [{ taskName: "t00", taskSha256: digestA }],
};

describe("DeepSWE v1.1 run-complete reward.json", () => {
  let root: string;
  afterEach(() => {
    if (root !== undefined) rmSync(root, { recursive: true, force: true });
  });

  test("judged trial without reward.json is not DeepSWE-ready", () => {
    root = mkdtempSync(join(tmpdir(), "deepswe-complete-"));
    const jobDir = join(root, "job");
    mkdirSync(jobDir);
    for (let attempt = 1; attempt <= 4; attempt += 1) {
      writeTrial(jobDir, `trial-${attempt}`, "t00", attempt, true);
    }
    const matrix = {
      cells: Array.from({ length: 4 }, (_, index) => ({
        cellKey: cellKey(digestA, "one", index + 1),
        taskDigest: digestA,
        armId: "one",
        replicate: index + 1,
        outcome: "judged" as const,
      })),
    };
    const complete = assessArmRunComplete({ matrix, suite: deepsweSuite, armId: "one", jobDir });
    expect(complete).toEqual({ cellsAccounted: true, atifOnRetainedJob: true, rewardOnRetainedJob: false });
  });

  test("judged trial with verifier/reward.json is DeepSWE-ready", () => {
    root = mkdtempSync(join(tmpdir(), "deepswe-reward-"));
    const jobDir = join(root, "job");
    mkdirSync(jobDir);
    for (let attempt = 1; attempt <= 4; attempt += 1) {
      writeTrial(jobDir, `trial-${attempt}`, "t00", attempt, true);
      mkdirSync(join(jobDir, `trial-${attempt}`, "verifier"), { recursive: true });
      writeFileSync(join(jobDir, `trial-${attempt}`, "verifier", "reward.json"), JSON.stringify({ reward: 1 }));
    }
    const matrix = {
      cells: Array.from({ length: 4 }, (_, index) => ({
        cellKey: cellKey(digestA, "one", index + 1),
        taskDigest: digestA,
        armId: "one",
        replicate: index + 1,
        outcome: "judged" as const,
      })),
    };
    expect(assessArmRunComplete({ matrix, suite: deepsweSuite, armId: "one", jobDir })).toEqual({
      cellsAccounted: true,
      atifOnRetainedJob: true,
      rewardOnRetainedJob: true,
    });
  });
});
