// SPDX-License-Identifier: Apache-2.0

/**
 * Harbor 0.21 named reader for `run import --from harbor` (#3991).
 *
 * The fixture is SYNTHETIC: it follows the Harbor 0.21 job/trial layout used by the in-repo
 * Harbor 0.21 fakes (`runtime/harbor/harbor.test.ts`) — trial `config.json` with
 * `exclude_defaults` path + `trial_name`, `result.json`, `verifier/reward.txt`. It is not a
 * preserved live Harbor dump.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { cellKey } from "@jinn-network/benchmarking-records";
import { assignHarborTrialAttempt } from "../runtime/harbor/manifest.js";
import { digestByTaskNameFromSuite, taskNameByDigestFromSuite } from "../runtime/suite-protocol/from-harbor.js";
import type { SuiteProtocolSelection } from "../runtime/suite-protocol/manifest.js";
import { readHarborRunRecords } from "./harbor-run-records.js";

const digestHello = "ab".repeat(32);
const digestOracle = "cd".repeat(32);

const suite: SuiteProtocolSelection = {
  schema: "jinn.network/benchmark-product/suite-protocol-selection/1",
  protocol: "terminal-bench-2.1",
  coverage: "custom",
  datasetId: "terminal-bench/terminal-bench-2-1",
  datasetRevision: `sha256:${"ee".repeat(32)}`,
  selectedTaskNames: ["hello-world", "oracle-fix"],
  datasetTaskCount: 89,
  replicates: 5,
  atifRequired: true,
  items: [
    { taskName: "hello-world", taskSha256: digestHello },
    { taskName: "oracle-fix", taskSha256: digestOracle },
  ],
};

const armId = "one";
const expected = [
  { cellKey: cellKey(digestHello, armId, 1), taskDigest: digestHello, armId, replicate: 1 },
  { cellKey: cellKey(digestOracle, armId, 1), taskDigest: digestOracle, armId, replicate: 1 },
];

let jobsDir: string;

beforeEach(() => {
  jobsDir = mkdtempSync(join(tmpdir(), "bp-harbor-import-"));
});

afterEach(() => {
  rmSync(jobsDir, { recursive: true, force: true });
});

function writeOfficialTrial(input: {
  readonly jobName: string;
  readonly trialDir: string;
  readonly taskName: string;
  readonly status: string;
  readonly exceptionType?: string;
  readonly reward?: string;
  readonly startedAt?: string;
  readonly finishedAt?: string;
  readonly attempt?: number;
  readonly agentName?: string;
  readonly modelName?: string;
}): void {
  const job = join(jobsDir, input.jobName);
  const trial = join(job, input.trialDir);
  const agentName = input.agentName ?? "terminus";
  const modelName = input.modelName ?? "openai/model-one";
  mkdirSync(join(trial, "verifier"), { recursive: true });
  mkdirSync(join(trial, "artifacts"), { recursive: true });
  writeFileSync(join(job, "config.json"), JSON.stringify({
    job_name: input.jobName,
    harbor_version: "0.21.4",
    agents: [{ name: agentName, model_name: modelName }],
  }));
  writeFileSync(join(job, "result.json"), JSON.stringify({
    id: input.jobName,
    status: "success",
    n_total_trials: 1,
    stats: { n_retries: 0 },
  }));
  writeFileSync(join(trial, "config.json"), JSON.stringify({
    task: { path: `/cache/${input.taskName}`, source: "local" },
    trial_name: `${input.taskName}__55xttAM`,
    agent: { name: agentName, model_name: modelName },
    ...(input.attempt === undefined ? {} : { attempt: input.attempt }),
  }));
  writeFileSync(join(trial, "result.json"), JSON.stringify({
    id: `${input.jobName}:${input.trialDir}`,
    status: input.status,
    ...(input.exceptionType === undefined ? {} : { exception_type: input.exceptionType }),
    ...(input.startedAt === undefined ? {} : { started_at: input.startedAt }),
    ...(input.finishedAt === undefined ? {} : { finished_at: input.finishedAt }),
  }));
  if (input.reward !== undefined) {
    writeFileSync(join(trial, "verifier", "reward.txt"), input.reward);
  }
}

function readRecords() {
  return readHarborRunRecords({
    jobsDir,
    digestByTaskName: digestByTaskNameFromSuite(suite),
    arms: [{ armId, agentName: "terminus", modelName: "openai/model-one" }],
    expected,
  });
}

describe("from-harbor suite mapping is the Harbor import name table", () => {
  test("digestByTaskNameFromSuite is the inverse of taskNameByDigestFromSuite", () => {
    expect(digestByTaskNameFromSuite(suite)).toEqual({
      "hello-world": digestHello,
      "oracle-fix": digestOracle,
    });
    expect(taskNameByDigestFromSuite(suite)).toEqual({
      [digestHello]: "hello-world",
      [digestOracle]: "oracle-fix",
    });
  });
});

describe("assignHarborTrialAttempt — Harbor 0.21 omits attempt_number", () => {
  test("first sight of a trial directory is attempt 1; the same directory is reused", () => {
    const nextAttemptByTask = new Map<string, number>();
    const directoryAttempt = new Map<string, number>();
    const trial = { task: { path: "/cache/hello-world", source: "local" }, trial_name: "hello-world__55xttAM" };
    const first = assignHarborTrialAttempt({ trial, directory: "trial-1", nextAttemptByTask, directoryAttempt });
    const again = assignHarborTrialAttempt({ trial, directory: "trial-1", nextAttemptByTask, directoryAttempt });
    const second = assignHarborTrialAttempt({ trial, directory: "trial-2", nextAttemptByTask, directoryAttempt });
    expect(first).toEqual({ taskName: "hello-world", attempt: 1 });
    expect(again).toEqual({ taskName: "hello-world", attempt: 1 });
    expect(second).toEqual({ taskName: "hello-world", attempt: 2 });
  });
});

describe("readHarborRunRecords — Harbor 0.21 jobs and trials", () => {
  test("one finished trial is one per-attempt record with timings and evidence paths", () => {
    writeOfficialTrial({
      jobName: "brought-job",
      trialDir: "trial-1",
      taskName: "hello-world",
      status: "success",
      reward: "1\n",
      startedAt: "2026-08-05T00:00:00.000Z",
      finishedAt: "2026-08-05T00:00:10.000Z",
    });
    const records = readRecords();
    const hello = records.find((record) => record.cellKey === expected[0]!.cellKey)!;
    const missing = records.find((record) => record.cellKey === expected[1]!.cellKey)!;
    expect(hello.outcome).toBe("ungradeable");
    expect(hello.startedAt).toBe("2026-08-05T00:00:00.000Z");
    expect(hello.endedAt).toBe("2026-08-05T00:00:10.000Z");
    expect(hello.durationMs).toBe(10_000);
    expect(hello.evidence).toEqual(expect.arrayContaining([
      { name: "trial-result.json", path: "brought-job/trial-1/result.json" },
      { name: "reward.txt", path: "brought-job/trial-1/verifier/reward.txt" },
    ]));
    expect(missing).toEqual({
      row: expect.any(Number),
      cellKey: expected[1]!.cellKey,
      outcome: "unrun",
      reason: "Harbor jobs directory contained no trial for this slot",
    });
    expect(records).toHaveLength(2);
  });

  test("AgentTimeoutError is timeout; a missing slot is unrun with a reason, not dropped", () => {
    writeOfficialTrial({
      jobName: "timed-out",
      trialDir: "trial-1",
      taskName: "hello-world",
      status: "error",
      exceptionType: "AgentTimeoutError",
    });
    const records = readRecords();
    expect(records.find((record) => record.cellKey === expected[0]!.cellKey)).toMatchObject({
      outcome: "timeout",
      reason: "AgentTimeoutError",
    });
    expect(records.find((record) => record.cellKey === expected[1]!.cellKey)).toMatchObject({
      outcome: "unrun",
      reason: "Harbor jobs directory contained no trial for this slot",
    });
    expect(records.find((record) => record.cellKey === expected[0]!.cellKey)?.evidence).toBeUndefined();
  });

  test("an extra Harbor task is a well-formed cellKey outside the slate (unknown-slot)", () => {
    writeOfficialTrial({
      jobName: "extra",
      trialDir: "trial-1",
      taskName: "not-on-slate",
      status: "success",
      reward: "1\n",
    });
    writeOfficialTrial({
      jobName: "hello",
      trialDir: "trial-1",
      taskName: "hello-world",
      status: "success",
      reward: "1\n",
    });
    const records = readRecords();
    const extra = records.filter((record) => record.cellKey !== expected[0]!.cellKey && record.cellKey !== expected[1]!.cellKey);
    expect(extra).toHaveLength(1);
    expect(extra[0]!.cellKey).toMatch(/^[a-f0-9]{64}\/extra\/1$/u);
  });

  test("two trials for the same Harbor 0.21 task without attempt_number are distinct replicates, not a silent overwrite", () => {
    const k5Expected = [1, 2, 3, 4, 5].map((replicate) => ({
      cellKey: cellKey(digestHello, armId, replicate),
      taskDigest: digestHello,
      armId,
      replicate,
    }));
    writeOfficialTrial({
      jobName: "k-job",
      trialDir: "trial-1",
      taskName: "hello-world",
      status: "success",
      reward: "1\n",
    });
    writeOfficialTrial({
      jobName: "k-job",
      trialDir: "trial-2",
      taskName: "hello-world",
      status: "success",
      reward: "0\n",
    });
    const records = readHarborRunRecords({
      jobsDir,
      digestByTaskName: { "hello-world": digestHello },
      arms: [{ armId, agentName: "terminus", modelName: "openai/model-one" }],
      expected: k5Expected,
    });
    expect(records.filter((record) => record.outcome === "ungradeable").map((record) => record.cellKey).sort())
      .toEqual([cellKey(digestHello, armId, 1), cellKey(digestHello, armId, 2)].sort());
    expect(records.filter((record) => record.outcome === "unrun")).toHaveLength(3);
  });

  test("two arms of the same Harbor task each start at attempt 1", () => {
    const twoArmExpected = [
      { cellKey: cellKey(digestHello, "one", 1), taskDigest: digestHello, armId: "one", replicate: 1 },
      { cellKey: cellKey(digestHello, "two", 1), taskDigest: digestHello, armId: "two", replicate: 1 },
    ];
    writeOfficialTrial({
      jobName: "arm-one",
      trialDir: "trial-1",
      taskName: "hello-world",
      status: "success",
      reward: "1\n",
    });
    writeOfficialTrial({
      jobName: "arm-two",
      trialDir: "trial-1",
      taskName: "hello-world",
      status: "success",
      reward: "0\n",
      agentName: "terminus-b",
      modelName: "openai/model-two",
    });
    const records = readHarborRunRecords({
      jobsDir,
      digestByTaskName: digestByTaskNameFromSuite(suite),
      arms: [
        { armId: "one", agentName: "terminus", modelName: "openai/model-one" },
        { armId: "two", agentName: "terminus-b", modelName: "openai/model-two" },
      ],
      expected: twoArmExpected,
    });
    expect(records.map((record) => record.cellKey).sort()).toEqual([
      twoArmExpected[0]!.cellKey,
      twoArmExpected[1]!.cellKey,
    ].sort());
    expect(records.every((record) => record.outcome === "ungradeable")).toBe(true);
  });

  test("a finished Harbor error without a timeout exception is error, not dropped", () => {
    writeOfficialTrial({
      jobName: "broke",
      trialDir: "trial-1",
      taskName: "hello-world",
      status: "error",
      exceptionType: "RuntimeError",
    });
    const records = readRecords();
    expect(records.find((record) => record.cellKey === expected[0]!.cellKey)).toMatchObject({
      outcome: "error",
      reason: "RuntimeError",
    });
    expect(records.find((record) => record.cellKey === expected[1]!.cellKey)).toMatchObject({
      outcome: "unrun",
    });
  });
});
