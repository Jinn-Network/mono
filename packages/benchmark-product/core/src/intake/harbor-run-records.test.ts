// SPDX-License-Identifier: Apache-2.0

/**
 * Harbor 0.21 named reader for `run import --from harbor` (#3991).
 *
 * Two kinds of input are read here. The first suites write a SYNTHETIC jobs directory: it follows
 * the Harbor 0.21 job/trial layout used by the in-repo Harbor 0.21 fakes
 * (`runtime/harbor/harbor.test.ts`) — trial `config.json` with `exclude_defaults` path +
 * `trial_name`, `result.json`, `verifier/reward.txt`. The last suites read a REAL Harbor 0.21.0
 * jobs directory, `test/fixtures/harbor-0.21-jobs-terminal-bench-2-1/` (#4937), whose shape the
 * synthetic one never had: no `status`, `exception_info.exception_type`, a job `config.json`
 * without `agents`, and the Harbor version only in the job `lock.json`.
 */

import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { cellKey } from "@jinn-network/benchmarking-records";
import { BenchmarkProductError } from "../errors.js";
import { armAdd } from "../operations/arms.js";
import type { OperationContext } from "../operations/context.js";
import { createDraft, readDraftDocument } from "../operations/drafts.js";
import { importSweBenchRows } from "../operations/import.js";
import { initWorkspace } from "../operations/init.js";
import { selectMethod } from "../operations/method.js";
import { runLock } from "../operations/run-lock.js";
import { runQuote } from "../operations/run-quote.js";
import { assignHarborTrialAttempt } from "../runtime/harbor/manifest.js";
import { digestByTaskNameFromSuite, taskNameByDigestFromSuite } from "../runtime/suite-protocol/from-harbor.js";
import type { SuiteProtocolSelection } from "../runtime/suite-protocol/manifest.js";
import { TERMINAL_BENCH_2_1_DATASET_REF } from "../runtime/terminal-bench-2-1/manifest.js";
import { readHarborRunImport, readHarborRunRecords, taskNameByDigestForHarborImport } from "./harbor-run-records.js";

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

/**
 * The real Harbor 0.21.0 jobs directory (#4937): three official Terminal-Bench 2.1 tasks by two
 * arms. See the fixture README for where it came from and what was removed from it.
 */
const REAL_JOBS = fileURLToPath(
  new URL("../../test/fixtures/harbor-0.21-jobs-terminal-bench-2-1/jobs", import.meta.url),
);
const REAL_TASKS = ["adaptive-rejection-sampler", "cancel-async-tasks", "chess-best-move"] as const;
const REAL_MODEL = "openrouter/deepseek/deepseek-v4.1-flash";

describe("readHarborRunRecords — a real Harbor 0.21.0 jobs directory", () => {
  const digests: Record<string, string> = {
    "adaptive-rejection-sampler": "a1".repeat(32),
    "cancel-async-tasks": "b2".repeat(32),
    "chess-best-move": "c3".repeat(32),
  };
  // One arm is found by its id (the Harbor agent name), the other by its pinned agent and model.
  const realArms = [
    { armId: "oracle" },
    { armId: "deepseek-flash", agentName: "terminus-2", modelName: REAL_MODEL },
  ];
  const realExpected = realArms.flatMap((arm) => REAL_TASKS.map((task) => ({
    cellKey: cellKey(digests[task]!, arm.armId, 1),
    taskDigest: digests[task]!,
    armId: arm.armId,
    replicate: 1,
  })));

  function readReal(root = REAL_JOBS) {
    return readHarborRunRecords({ jobsDir: root, digestByTaskName: digests, arms: realArms, expected: realExpected });
  }

  function outcomes(records: ReturnType<typeof readReal>): Record<string, string> {
    return Object.fromEntries(records.map((record) => [record.cellKey, record.outcome]));
  }

  test("a job whose config.json names no agents is placed on its arm from each trial's result.json", () => {
    const records = readReal();
    expect(records).toHaveLength(6);
    expect(records.map((record) => record.cellKey).sort())
      .toEqual(realExpected.map((coord) => coord.cellKey).sort());
  });

  test("a nested exception_info.exception_type is read: the timed-out trial is timeout", () => {
    const records = readReal();
    const timedOut = cellKey(digests["chess-best-move"]!, "deepseek-flash", 1);
    expect(records.find((record) => record.cellKey === timedOut)).toMatchObject({
      outcome: "timeout",
      reason: "AgentTimeoutError",
      startedAt: "2026-10-01T13:13:30.253511Z",
      endedAt: "2026-10-01T13:31:19.179759Z",
    });
    // Every other trial finished with a verifier reward and stays classified as it is today.
    expect(outcomes(records)).toEqual({
      ...Object.fromEntries(realExpected.map((coord) => [coord.cellKey, "ungradeable"])),
      [timedOut]: "timeout",
    });
    const oracle = records.find((record) => record.cellKey === cellKey(digests["chess-best-move"]!, "oracle", 1))!;
    expect(oracle.evidence).toEqual([
      { name: "trial-result.json", path: "oracle/chess-best-move__5FuHvzp/result.json" },
      { name: "trial-config.json", path: "oracle/chess-best-move__5FuHvzp/config.json" },
      { name: "reward.txt", path: "oracle/chess-best-move__5FuHvzp/verifier/reward.txt" },
    ]);
  });

  test("a trial with no result.json takes its agent from the job lock.json", () => {
    const copy = join(jobsDir, "jobs");
    cpSync(REAL_JOBS, copy, { recursive: true });
    rmSync(join(copy, "oracle", "chess-best-move__5FuHvzp", "result.json"));
    const records = readReal(copy);
    expect(records.find((record) => record.cellKey === cellKey(digests["chess-best-move"]!, "oracle", 1))).toMatchObject({
      outcome: "unrun",
      reason: "Harbor trial is not finished",
    });
    expect(records).toHaveLength(6);
  });

  test("an agent that matches no locked arm is refused with the agent and the arms named", () => {
    expect(() => readHarborRunRecords({
      jobsDir: REAL_JOBS,
      digestByTaskName: digests,
      arms: [{ armId: "one" }, { armId: "two" }],
      expected: [],
    })).toThrowError(/Harbor agent "oracle".*locked arms: one, two/su);
  });
});

describe("readHarborRunImport — the official Terminal-Bench 2.1 slate", () => {
  let workspaceDir: string;

  beforeEach(() => {
    workspaceDir = join(jobsDir, "workspace");
    mkdirSync(workspaceDir);
    writeFileSync(join(jobsDir, "host.json"), "{}");
  });

  function context(): OperationContext {
    let ms = Date.parse("2026-10-01T12:00:00.000Z");
    return {
      workspaceDir,
      principal: "claimant",
      clock: () => {
        ms += 10;
        return new Date(ms).toISOString();
      },
    };
  }

  /** Binds the catalog method the way a claimant does, then quotes and locks. */
  async function lockedOfficialSlate(): Promise<void> {
    const operation = context();
    initWorkspace(operation);
    createDraft(operation, { draftId: "draft-1", name: "Brought Harbor run" });
    const bound = await selectMethod(operation, {
      draftId: "draft-1",
      ref: "terminal-bench-2.1",
      cwd: jobsDir,
      hostPath: join(jobsDir, "host.json"),
      ids: REAL_TASKS.join(","),
    });
    expect(bound.ok, JSON.stringify(bound)).toBe(true);
    armAdd(operation, { draftId: "draft-1", armId: "oracle", pinning: { harness: { id: "harbor-oracle" } } });
    armAdd(operation, {
      draftId: "draft-1",
      armId: "deepseek-flash",
      pinning: { agent: { id: "terminus-2" }, model: { id: REAL_MODEL } },
    });
    const quoted = await runQuote(operation, { draftId: "draft-1" });
    expect(quoted.ok, JSON.stringify(quoted)).toBe(true);
    const locked = runLock(operation, { draftId: "draft-1" });
    expect(locked.ok, JSON.stringify(locked)).toBe(true);
  }

  function copyOfRealJobs(): string {
    const copy = join(jobsDir, "jobs");
    cpSync(REAL_JOBS, copy, { recursive: true });
    return copy;
  }

  function rewriteJson(path: string, edit: (value: Record<string, any>) => void): void {
    const value = JSON.parse(readFileSync(path, "utf8")) as Record<string, any>;
    edit(value);
    writeFileSync(path, JSON.stringify(value));
  }

  function refusal(run: () => unknown): BenchmarkProductError {
    try {
      run();
    } catch (cause) {
      if (cause instanceof BenchmarkProductError) return cause;
      throw cause;
    }
    throw new Error("expected the Harbor reader to refuse");
  }

  test("names every task of a draft bound by method terminal-bench-2.1 and reads the real jobs directory", async () => {
    await lockedOfficialSlate();
    const dump = readHarborRunImport({ workspaceDir, draftId: "draft-1", jobsDir: REAL_JOBS });
    expect(dump.records).toHaveLength(6);
    expect(dump.records.map((record) => record.cellKey.split("/")[1]).sort())
      .toEqual(["deepseek-flash", "deepseek-flash", "deepseek-flash", "oracle", "oracle", "oracle"]);
    expect(dump.records.map((record) => record.outcome).sort())
      .toEqual(["timeout", "ungradeable", "ungradeable", "ungradeable", "ungradeable", "ungradeable"]);
    expect(new Set(dump.records.map((record) => record.cellKey)).size).toBe(6);
  });

  test("the Harbor version is the one the job lock.json records", async () => {
    await lockedOfficialSlate();
    const dump = readHarborRunImport({ workspaceDir, draftId: "draft-1", jobsDir: REAL_JOBS });
    expect(dump.source).toEqual({ harness: "harbor", version: "0.21.0" });
  });

  test("a trial whose task ref is not the sealed packageRef is refused, naming both", async () => {
    await lockedOfficialSlate();
    const jobs = copyOfRealJobs();
    const other = `sha256:${"0".repeat(64)}`;
    rewriteJson(join(jobs, "oracle", "chess-best-move__5FuHvzp", "config.json"), (config) => {
      config["task"].ref = other;
    });
    const refused = refusal(() => readHarborRunImport({ workspaceDir, draftId: "draft-1", jobsDir: jobs }));
    expect(refused.code).toBe("validation");
    expect(refused.message).toContain("oracle/chess-best-move__5FuHvzp");
    expect(refused.message).toContain(other);
    expect(refused.message).toContain("sha256:9ab8e4b3674282e751edafbd9b5bd551fef995fd6601585a2cdb04fd70c520da");
  });

  test("a trial that records no task ref is not mapped by name alone", async () => {
    await lockedOfficialSlate();
    const jobs = copyOfRealJobs();
    rewriteJson(join(jobs, "oracle", "chess-best-move__5FuHvzp", "config.json"), (config) => {
      delete config["task"].ref;
    });
    const refused = refusal(() => readHarborRunImport({ workspaceDir, draftId: "draft-1", jobsDir: jobs }));
    expect(refused.code).toBe("validation");
    expect(refused.message).toContain("records no package ref");
    expect(refused.message).toContain("sha256:9ab8e4b3674282e751edafbd9b5bd551fef995fd6601585a2cdb04fd70c520da");
  });

  test("a job whose dataset ref is not the sealed dataset revision is refused, naming both", async () => {
    await lockedOfficialSlate();
    const jobs = copyOfRealJobs();
    const other = `sha256:${"1".repeat(64)}`;
    rewriteJson(join(jobs, "terminus-2", "config.json"), (config) => {
      config["datasets"][0].ref = other;
    });
    const refused = refusal(() => readHarborRunImport({ workspaceDir, draftId: "draft-1", jobsDir: jobs }));
    expect(refused.code).toBe("validation");
    expect(refused.message).toContain("terminus-2");
    expect(refused.message).toContain(other);
    expect(refused.message).toContain(TERMINAL_BENCH_2_1_DATASET_REF);
  });

  test("a draft whose tasks carry no Harbor task name is refused with what the claimant can do", () => {
    const operation = context();
    initWorkspace(operation);
    createDraft(operation, { draftId: "draft-1", name: "Not a Harbor slate" });
    // The platform's own public importer fixture row: a Task with no Harbor task name anywhere.
    const imported = importSweBenchRows(operation, {
      draftId: "draft-1",
      rows: [{
        instance_id: "swe-rebench-2024-00042",
        repo: "psf/requests",
        base_commit: "d8bdd423ab2df9f87b7975cdb32b31f3002a20c0",
        problem_statement: "Fix the connection pool leak when retries are exhausted.",
        language: "python",
        image: {
          uri: "https://example.org/images/swe-rebench-runner:2024-00042",
          digest: { sha256: "e8d6cfe4f52e87a1292f3897bf0bea28e4bde32703e6792bb9b1bc60d3024817" },
        },
        testMaterial: [{ uri: "https://example.org/tests/swe-rebench-2024-00042/test_pool.py" }],
        parser: {
          id: "jinn.parser.pytest-json-report",
          version: "1.0.0",
          digest: "sha256:d2136b44c86f551b2494d616a8ee7afd58e6f90681f1beb84441113154a13897",
        },
        transitions: {
          failToPass: ["test_pool.py::test_retry_releases_connection"],
          passToPass: ["test_pool.py::test_basic_get"],
        },
        timeout: 1800,
      }],
    });
    expect(imported.ok, JSON.stringify(imported)).toBe(true);
    const refused = refusal(() => taskNameByDigestForHarborImport(workspaceDir, readDraftDocument(workspaceDir, "draft-1")));
    expect(refused.code).toBe("conflict");
    expect(refused.message).toContain("method terminal-bench-2.1");
    expect(refused.message).toContain("run import --file");
    // #4678 is merged and the official slate is in the tree: nothing here is pending on it.
    expect(refused.message).not.toContain("4678");
  });
});
