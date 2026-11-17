// SPDX-License-Identifier: Apache-2.0

/**
 * Harbor 0.21 named reader for `run import --from harbor` (#3991).
 *
 * Two kinds of input are read here. The first suites write a SYNTHETIC jobs directory: it follows
 * the Harbor 0.21 job/trial layout used by the in-repo Harbor 0.21 fakes
 * (`runtime/harbor/harbor.test.ts`) — trial `config.json` with `exclude_defaults` path +
 * `trial_name`, `result.json`, `verifier/reward.txt`. The last suites read the REAL Harbor 0.21.0
 * jobs directories under `test/fixtures/harbor-0.21-jobs-terminal-bench-2-1/` (#4937), whose shape
 * the synthetic one never had: no `status`, `exception_info.exception_type`, a job `config.json`
 * without `agents`, the Harbor version only in the job `lock.json`, the reward in
 * `verifier_result.rewards`, and two unnumbered sibling trial directories for two attempts of one
 * task.
 */

import { cpSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, join, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { cellKey, sealBenchmark } from "@jinn-network/benchmarking-records";
import { evaluateVerdictRule, parseEvaluationSpec, sealEvaluationSpec } from "@jinn-network/task-execution-profiles";
import { sealTask } from "@jinn-network/task-execution-protocol";
import { materializePublicBundle } from "../bundle/materialize.js";
import { verifyPublicBundle } from "../bundle/verify.js";
import { BenchmarkProductError } from "../errors.js";
import { armAdd } from "../operations/arms.js";
import { attachBenchmarkToDraft } from "../operations/attach.js";
import type { OperationContext } from "../operations/context.js";
import { createDraft, readDraftDocument, updateDraft } from "../operations/drafts.js";
import { importSweBenchRows } from "../operations/import.js";
import { initWorkspace } from "../operations/init.js";
import { selectMethod } from "../operations/method.js";
import { importRunRecords } from "../operations/run-import.js";
import { runCollect } from "../operations/run-collect.js";
import { runLock } from "../operations/run-lock.js";
import { runQuote } from "../operations/run-quote.js";
import { runReport } from "../operations/report.js";
import { EXTERNAL_IMPORT_MAX_AGGREGATE_BYTES, ExternalRunImportDeclarationSchema } from "../run/external-import.js";
import { readRunState } from "../run/state.js";
import { assignHarborTrialAttempt } from "../runtime/harbor/manifest.js";
import { digestByTaskNameFromSuite, taskNameByDigestFromSuite } from "../runtime/suite-protocol/from-harbor.js";
import type { SuiteProtocolSelection } from "../runtime/suite-protocol/manifest.js";
import {
  TERMINAL_BENCH_2_1_DATASET_ID,
  TERMINAL_BENCH_2_1_DATASET_REF,
} from "../runtime/terminal-bench-2-1/manifest.js";
import { getSealedBytes, putSealedBytes, sha256Hex } from "../workspace/sealed-store.js";
import {
  HARBOR_RUN_IMPORT_EVIDENCE_BYTES_PER_CELL,
  HARBOR_RUN_IMPORT_VERSIONS,
  harborCarriedEvidence,
  harborRunImportEvidenceCap,
  readHarborRunImport,
  readHarborRunRecords,
  taskNameByDigestForHarborImport,
  type HarborRunImportDump,
} from "./harbor-run-records.js";
import { buildTerminalBench21EvaluationSpec, buildTerminalBench21Tasks } from "./terminal-bench-2-1.js";
import { TERMINAL_BENCH_21_OFFICIAL_TASKS } from "./terminal-bench-2-1-slate.js";

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

describe("harborCarriedEvidence — what a Harbor import carries of a trial's own record (#5266)", () => {
  const encode = (text: string) => new TextEncoder().encode(text);
  const decode = (bytes: Uint8Array) => new TextDecoder().decode(bytes);

  function carried(name: string, text: string): string {
    return decode(harborCarriedEvidence(jobsDir)({ name, path: `job/trial-1/${name}`, bytes: encode(text) }));
  }

  test("a local task's absolute path and an absolute trials_dir are removed, however the file is laid out", () => {
    expect(carried(
      "trial-config.json",
      '{"task":{"path":"/srv/datasets/hello-world"},"trial_name":"hello-world__55xttAM","trials_dir":"/srv/jobs/job"}',
    )).toBe('{"task":{},"trial_name":"hello-world__55xttAM"}');
    expect(carried(
      "trial-result.json",
      '{"task_id": {"path": "/srv/datasets/hello-world"}, "trial_uri": "file:///srv/jobs/job/trial-1", "id": "x"}',
    )).toBe('{"task_id": {}, "id": "x"}');
  });

  test("a relative trials_dir and a task named rather than pathed are carried as Harbor wrote them", () => {
    const text = '{\n    "task": {\n        "path": null,\n        "name": "terminal-bench/hello-world"\n    },\n    "trials_dir": "jobs/job"\n}';
    expect(carried("trial-config.json", text)).toBe(text);
  });

  /** The refusal `harborCarriedEvidence` gives a trial record, which must name the file. */
  function refusalOf(name: string, text: string): BenchmarkProductError {
    try {
      carried(name, text);
    } catch (cause) {
      if (cause instanceof BenchmarkProductError) return cause;
      throw cause;
    }
    throw new Error(`expected ${name} to be refused: ${text}`);
  }

  /** `value` at `field` of a trial `config.json`, and the same config as the `config` of a trial `result.json`. */
  function trialRecords(field: string, value: unknown): readonly (readonly [string, string, string])[] {
    const config: Record<string, unknown> = { trial_name: "hello-world__55xttAM" };
    let at = config;
    const keys = field.split(".");
    for (const key of keys.slice(0, -1)) at = (at[key] ??= {}) as Record<string, unknown>;
    at[keys.at(-1)!] = value;
    return [
      ["trial-config.json", JSON.stringify(config, null, 4), field],
      ["trial-result.json", JSON.stringify({ id: "x", config }, null, 4), `config.${field}`],
    ];
  }

  // #5289: Harbor wrote these on another machine (a CI runner, a cloud VM), so they are under
  // neither the jobs directory nor the home directory of the machine that imports them.
  test.each([
    ["a bind mount under /home", "environment.mounts", [{ type: "bind", source: "/home/runner-7/datasets", target: "/data" }], "environment.mounts[0].source", "/home/runner-7"],
    ["an instruction file under /Users", "extra_instruction_paths", ["/Users/bob/notes/instructions.md"], "extra_instruction_paths[0]", "/Users/bob"],
    ["a skill directory under /root", "agent.skills", ["/root/.cache/harbor/skills/web"], "agent.skills[0]", "/root"],
    ["a trajectory under a Windows user directory", "agent.load_trajectory", "C:\\Users\\carol\\runs\\trajectory.json", "agent.load_trajectory", "\\Users\\carol"],
    ["a compose file under a Windows user directory written with forward slashes", "environment.extra_docker_compose", ["C:/Users/carol/compose.yaml"], "environment.extra_docker_compose[0]", "/Users/carol"],
    ["a file: URI of a home directory", "task.git_url", "file:///home/dave/tasks.git", "task.git_url", "/home/dave"],
    ["a percent-encoded file: URI of a home directory", "agent.kwargs.prompt_template", "file:///Users/%C3%A9mile/prompt.j2", "agent.kwargs.prompt_template", "/Users/%C3%A9mile"],
    ["a file: URI of a directory that is not a home directory", "agent.kwargs.prompt_template", "file:///Volumes/erin-data/prompt.j2", "agent.kwargs.prompt_template", "file:"],
    ["a home directory inside an agent setting", "agent.kwargs.cache", "--cache-dir=/home/erin/.cache", "agent.kwargs.cache", "/home/erin"],
  ])("a trial record naming %s of another machine is refused, naming the file and the field", (_what, field, value, named, shown) => {
    for (const [name, text, at] of trialRecords(field, value)) {
      const error = refusalOf(name, text);
      expect(error.code).toBe("validation");
      expect(error.issues!.map((issue) => issue.path)).toEqual([`job/trial-1/${name}`]);
      expect(error.message).toContain(`Harbor trial file job/trial-1/${name}`);
      expect(error.message).toContain(at.replace(field, named));
      expect(error.message).toContain(shown);
    }
  });

  // Python prints a Windows path in an OSError message with its backslashes doubled.
  test.each([
    ["on Linux", "[Errno 2] No such file or directory: '/home/ci-builder/.docker/config.json'", "/home/ci-builder"],
    ["on Windows", "[Errno 2] No such file or directory: 'C:\\\\Users\\\\carol\\\\.docker\\\\config.json'", "\\\\Users\\\\carol"],
  ])("a home directory of another machine %s in an exception message is refused, naming the field", (_where, message, shown) => {
    const text = JSON.stringify({
      id: "x",
      exception_info: { exception_type: "FileNotFoundError", exception_message: message },
    }, null, 4);
    const error = refusalOf("trial-result.json", text);
    expect(error.message).toContain("exception_info.exception_message");
    expect(error.message).toContain(shown);
  });

  // This machine's jobs and home directories are matched as paths, not as text: on a runner whose
  // home is /home/runner, /home/runner-7 is another machine's home, not under this one.
  test("a home directory whose path begins with your home directory's is not read as yours", () => {
    const other = `${homedir()}-7`;
    for (const [name, text] of trialRecords("environment.mounts", [{ type: "bind", source: `${other}/datasets`, target: "/data" }])) {
      const { message } = refusalOf(name, text);
      expect(message).toContain(other);
      expect(message).not.toContain("your home directory");
    }
  });

  test("your home directory at the end of a sentence is still read as yours", () => {
    const text = JSON.stringify({
      id: "x",
      exception_info: { exception_type: "PermissionError", exception_message: `cannot write to ${homedir()}.` },
    }, null, 4);
    expect(refusalOf("trial-result.json", text).message).toContain(`names your home directory (${homedir()})`);
  });

  // #5302: on a cluster or a CI runner Harbor's -o is often outside any home directory and still
  // names the user. The record names that jobs directory in trials_dir and trial_uri, which the
  // import removes; any other string that names it is a path of the machine that ran Harbor.
  test.each([
    [
      "a file in the trial directory trial_uri names, in an exception message",
      "trial-result.json",
      {
        id: "x",
        trial_uri: "file:///scratch/alice/jobs/terminus-2/hello-world__55xttAM",
        config: { trials_dir: "jobs/terminus-2" },
        exception_info: {
          exception_type: "FileNotFoundError",
          exception_message: "[Errno 2] No such file or directory: '/scratch/alice/jobs/terminus-2/hello-world__55xttAM/agent/trajectory.json'",
        },
      },
      "exception_info.exception_message",
    ],
    [
      "the job directory that holds the trial trial_uri names",
      "trial-result.json",
      {
        id: "x",
        trial_uri: "file:///scratch/alice/jobs/terminus-2/hello-world__55xttAM",
        exception_info: { exception_type: "OSError", exception_message: "cannot lock /scratch/alice/jobs/terminus-2/job.log" },
      },
      "exception_info.exception_message",
    ],
    [
      "a trial directory trial_uri percent-encodes",
      "trial-result.json",
      {
        id: "x",
        trial_uri: "file:///data/alice%20b/jobs/oracle/hello-world__55xttAM",
        exception_info: { exception_type: "OSError", exception_message: "cannot read /data/alice b/jobs/oracle/hello-world__55xttAM/verifier" },
      },
      "exception_info.exception_message",
    ],
    [
      "an absolute trials_dir, in a step's exception message",
      "trial-result.json",
      {
        id: "x",
        config: { trials_dir: "/data/ci-builder/jobs/oracle" },
        step_results: [{ exception_info: { exception_type: "OSError", exception_message: "cannot read /data/ci-builder/jobs/oracle/job.log" } }],
      },
      "step_results[0].exception_info.exception_message",
    ],
    [
      "an absolute trials_dir, in an agent setting",
      "trial-config.json",
      { trial_name: "hello-world__55xttAM", trials_dir: "/data/ci-builder/jobs/oracle", agent: { kwargs: { cache_dir: "/data/ci-builder/jobs/oracle/cache" } } },
      "agent.kwargs.cache_dir",
    ],
    [
      "a Windows trial directory trial_uri names, in an exception message as Python prints it",
      "trial-result.json",
      {
        id: "x",
        trial_uri: "file:///D:/work/jobs/terminus-2/hello-world__55xttAM",
        config: { trials_dir: "jobs\\terminus-2" },
        exception_info: { exception_type: "PermissionError", exception_message: "[Errno 13] Permission denied: 'D:\\\\work\\\\jobs\\\\terminus-2\\\\hello-world__55xttAM\\\\agent'" },
      },
      "exception_info.exception_message",
    ],
  ])("a trial record naming %s, outside any home directory, is refused, naming the file and the field", (_what, name, record, field) => {
    const error = refusalOf(name, JSON.stringify(record, null, 4));
    expect(error.code).toBe("validation");
    expect(error.issues!.map((issue) => issue.path)).toEqual([`job/trial-1/${name}`]);
    expect(error.message).toContain(`Harbor trial file job/trial-1/${name}, at ${field}, names the jobs directory of the machine that ran Harbor`);
  });

  test("a path that only begins with the jobs directory trial_uri names, and a relative one, are carried as Harbor wrote them", () => {
    const text = JSON.stringify({
      id: "x",
      trial_uri: "file:///scratch/alice/jobs/terminus-2/hello-world__55xttAM",
      config: { trials_dir: "jobs/terminus-2", artifacts: ["/app/jobs/terminus-2-notes.txt"] },
      exception_info: { exception_type: "OSError", exception_message: "cannot read jobs/terminus-2/hello-world__55xttAM/a and /scratch/alice/jobs/terminus-2-old/b" },
    }, null, 4);
    expect(carried("trial-result.json", text)).toBe(text.replace(/^ *"trial_uri": .*\n/mu, ""));
  });

  test.each([
    ["a URL of another scheme", "https://harbor.example.com/trials/hello-world__55xttAM"],
    ["not a URL", "scratch/alice/jobs/terminus-2/hello-world__55xttAM"],
  ])("a trial_uri that is %s is refused: the trial directory it should name is unknown", (_what, uri) => {
    const error = refusalOf("trial-result.json", JSON.stringify({ id: "x", trial_uri: uri }, null, 4));
    expect(error.code).toBe("validation");
    expect(error.message).toContain("its trial_uri is not a file: URI");
    expect(error.message).not.toContain(uri);
  });

  test.each([
    ["a bind mount", "environment.mounts", [{ type: "bind", source: "/srv/datasets", target: "/data" }], "environment.mounts[0].source"],
    ["an instruction file", "extra_instruction_paths", ["/srv/notes/instructions.md"], "extra_instruction_paths[0]"],
    ["a skill directory", "agent.skills", ["/var/cache/harbor/skills/web"], "agent.skills[0]"],
    ["a compose file", "environment.extra_docker_compose", ["D:\\harbor\\compose.yaml"], "environment.extra_docker_compose[0]"],
    ["a trajectory", "agent.load_trajectory", "/srv/runs/trajectory.json", "agent.load_trajectory"],
    ["a download directory", "task.download_dir", "/mnt/tasks", "task.download_dir"],
    ["a regrade source", "source_trial", { action: "regrade", type: "local", path: "/srv/jobs/oracle/t__x" }, "source_trial.path"],
  ])("an absolute path in a Harbor setting that names a path on the machine that ran it (%s) is refused", (_what, field, value, named) => {
    for (const [name, text, at] of trialRecords(field, value)) {
      expect(refusalOf(name, text).message).toContain(at.replace(field, named));
    }
  });

  test("a container path, a volume name and a relative path are carried as Harbor wrote them", () => {
    const config = {
      trial_name: "hello-world__55xttAM",
      agent: { skills: ["skills/web", "harbor/web-skill@1"] },
      environment: { mounts: [{ type: "volume", source: "pip-cache", target: "/opt/pip-cache" }, { type: "bind", source: "data", target: "/app/data" }] },
      artifacts: ["/app/output.txt", { source: "/workspace/out", destination: "out" }],
      extra_instruction_paths: ["notes/instructions.md"],
    };
    const text = JSON.stringify(config, null, 4);
    expect(carried("trial-config.json", text)).toBe(text);
  });

  test.each([
    ["an API key in agent kwargs", "agent.kwargs", { api_key: "0123456789abcdef0123456789abcdef" }, "agent.kwargs.api_key", "0123456789abcdef0123456789abcdef"],
    ["a key-shaped string under an ordinary name", "agent.kwargs", { llm: { route: "sk-proj-AbCdEf0123456789" } }, "agent.kwargs.llm.route", "sk-proj-AbCdEf0123456789"],
    ["a token-shaped string in agent kwargs", "agent.kwargs", { github: "ghp_R8x2Kq9LmN4pT7vW1yZ3aB5cD6eF0gH2iJ4k" }, "agent.kwargs.github", "ghp_R8x2Kq9LmN4pT7vW1yZ3aB5cD6eF0gH2iJ4k"],
    ["a bearer header in verifier kwargs", "verifier.kwargs", { headers: { "X-Upstream": "Bearer abc.def.ghi" } }, "verifier.kwargs.headers.X-Upstream", "abc.def.ghi"],
    ["a value Harbor redacted", "agent.env", { OPENROUTER_API_KEY: "sk-o****xyz" }, "agent.env.OPENROUTER_API_KEY", "sk-o****xyz"],
    ["a value Harbor redacted, outside env", "agent.kwargs", { upstream: "sk-o****xyz" }, "agent.kwargs.upstream", "sk-o****xyz"],
    ["a secret Harbor did not recognize by its name", "environment.env", { HF_HUB_PAT: "hf_mysecretvalue" }, "environment.env.HF_HUB_PAT", "hf_mysecretvalue"],
    ["an env placeholder with a default", "verifier.env", { GRADER_TOKEN: "${GRADER_TOKEN:-plain-default-value}" }, "verifier.env.GRADER_TOKEN", "plain-default-value"],
    ["an MCP server URL with a user and password", "agent.mcp_servers", [{ name: "docs", transport: "sse", url: "https://ci:hunter2@mcp.example.com/sse" }], "agent.mcp_servers[0].url", "hunter2"],
    ["an MCP server URL with a token in its query", "agent.mcp_servers", [{ name: "docs", transport: "sse", url: "https://mcp.example.com/sse?access_token=qwerty123" }], "agent.mcp_servers[0].url", "qwerty123"],
    ["an MCP server argument that is a token", "agent.mcp_servers", [{ name: "gh", transport: "stdio", command: "github-mcp", args: ["--pat", "github_pat_11ABCDEFG0123456789abcdefXYZ"] }], "agent.mcp_servers[0].args[1]", "github_pat_11ABCDEFG0123456789abcdefXYZ"],
    ["a task git URL with a token", "task.git_url", "https://x-access-token:gho_Secret0123@github.com/org/tasks.git", "task.git_url", "gho_Secret0123"],
    ["a REST URL under /users/ with a key in its query", "agent.kwargs", { endpoint: "https://api.example.com/users/me?api_key=S3cretValueXYZ" }, "agent.kwargs.endpoint", "S3cretValueXYZ"],
    ["an MCP server URL under /home/ with a token in its query", "agent.mcp_servers", [{ name: "docs", transport: "sse", url: "https://mcp.example.com/home/sse?access_token=qwerty123" }], "agent.mcp_servers[0].url", "qwerty123"],
    ["a credential used as a member name", "agent.kwargs", { headers: { "sk-proj-AbCdEf0123456789": "x" } }, "agent.kwargs.headers", "sk-proj-AbCdEf0123456789"],
    ["a URL with a token in its fragment", "agent.kwargs", { callback: "https://app.example.com/cb#access_token=qwerty123" }, "agent.kwargs.callback", "qwerty123"],
  ])("a trial record holding %s is refused, naming the file and the field and not the value", (_what, field, value, named, secret) => {
    for (const [name, text, at] of trialRecords(field, value)) {
      const error = refusalOf(name, text);
      expect(error.code).toBe("validation");
      expect(error.issues!.map((issue) => issue.path)).toEqual([`job/trial-1/${name}`]);
      expect(error.message).toContain(`Harbor trial file job/trial-1/${name}`);
      expect(error.message).toContain(at.replace(field, named));
      expect(`${error.message}\n${JSON.stringify(error.issues)}`).not.toContain(secret);
    }
  });

  // `run import` prints the refusal, which a claimant may run in a public CI log: a string or key
  // that holds a credential and also meets a rule that shows text is reported without the credential.
  test("no refusal shows the credential it refuses, whichever other rule the string or key meets", () => {
    const probes: readonly (readonly [string, unknown, string])[] = [
      ["agent.kwargs.endpoint", "https://api.example.com/users/me?api_key=S3cretValueXYZ", "S3cretValueXYZ"],
      ["agent.kwargs.endpoint", "https://api.github.com/users/octocat?access_token=gho_Secret0123", "gho_Secret0123"],
      ["agent.mcp_servers", [{ name: "docs", transport: "sse", url: "https://mcp.example.com/home/sse?access_token=qwerty123" }], "qwerty123"],
      ["agent.kwargs.remote", "/home/bob:pw123@x", "pw123"],
      ["agent.skills", ["/srv/skills/web?token=hunter2hunter2"], "hunter2hunter2"],
      ["agent.kwargs.headers", { "sk-proj-AbCdEf0123456789": "x" }, "sk-proj-AbCdEf0123456789"],
      ["sk-proj-AbCdEf0123456789", "x", "sk-proj-AbCdEf0123456789"],
    ];
    for (const [field, value, secret] of probes) {
      for (const [name, text] of trialRecords(field, value)) {
        const error = refusalOf(name, text);
        expect(`${error.message}\n${JSON.stringify(error.issues)}`, `${name} at ${field}`).not.toContain(secret);
      }
    }
  });

  const TOKEN = "ghp_R8x2Kq9LmN4pT7vW1yZ3aB5cD6eF0gH2iJ4k";

  // #5302: a secret the import does not know as one, where a rule that shows a path or a field
  // reads it, is refused without being shown.
  test("no refusal shows a token-shaped string, a URL fragment or a query value, whichever rule names it", () => {
    const probes: readonly (readonly [string, unknown, string])[] = [
      ["agent.kwargs.endpoint", `https://api.example.com/users/${TOKEN}`, TOKEN],
      ["agent.env", { CACHE_HOME: `/home/${TOKEN}` }, TOKEN],
      ["agent.skills", [`/srv/skills/${TOKEN}`], TOKEN],
      ["agent.skills", ["/srv/skills/web#sig=qwerty123"], "qwerty123"],
      ["environment.mounts", [{ type: "bind", source: "/srv/data?X-Amz-Signature=qwerty123", target: "/data" }], "qwerty123"],
      ["agent.kwargs.api_keys", { [TOKEN]: "github" }, TOKEN],
      ["agent.model_info", { [TOKEN]: "/home/alice/notes" }, TOKEN],
      ["agent.model_info", { [TOKEN]: { "/home/alice": 1 } }, TOKEN],
    ];
    for (const [field, value, secret] of probes) {
      for (const [name, text] of trialRecords(field, value)) {
        const error = refusalOf(name, text);
        expect(`${error.message}\n${JSON.stringify(error.issues)}`, `${name} at ${field}`).not.toContain(secret);
      }
    }
  });

  test.each([
    ["agent kwargs", "agent.kwargs", { [TOKEN]: "x" }, "agent.kwargs"],
    ["agent env", "agent.env", { [TOKEN]: "${HF_TOKEN}" }, "agent.env"],
    ["an MCP server", "agent.mcp_servers", [{ name: "docs", transport: "sse", url: "https://mcp.example.com/sse", [TOKEN]: "x" }], "agent.mcp_servers[0]"],
    ["verifier headers", "verifier.kwargs.headers", { [TOKEN]: "x" }, "verifier.kwargs.headers"],
  ])("a token-shaped member name in %s is refused as a member name in its parent field, without the name", (_what, field, value, named) => {
    for (const [name, text, at] of trialRecords(field, value)) {
      const error = refusalOf(name, text);
      expect(error.message).toContain(`at a member name in ${at.replace(field, named)}, holds a token-shaped string`);
      expect(`${error.message}\n${JSON.stringify(error.issues)}`).not.toContain(TOKEN);
    }
  });

  test("ordinary agent settings and Harbor's env placeholder are carried as Harbor wrote them", () => {
    const config = {
      trial_name: "hello-world__55xttAM",
      agent: {
        name: "terminus-2",
        model_name: "openrouter/deepseek/deepseek-v4.1-flash",
        kwargs: {
          temperature: 0.7,
          max_thinking_tokens: 2048,
          parser_name: "xml",
          api_base: "https://openrouter.ai/api/v1",
          summarizer_model: "claude-sonnet-4-5-20250929",
        },
        env: { OPENROUTER_API_KEY: "${OPENROUTER_API_KEY}" },
        mcp_servers: [{ name: "docs", transport: "streamable-http", url: "https://mcp.example.com/mcp", args: [] }],
      },
    };
    const text = JSON.stringify(config, null, 4);
    expect(carried("trial-config.json", text)).toBe(text);
  });

  test.each([
    ["No reward file found at ", "/home/ci/jobs/oracle/t__x/verifier/reward.txt or /home/ci/jobs/oracle/t__x/verifier/reward.json"],
    ["Reward file is empty at ", "/srv/jobs/oracle/t__x/verifier/reward.txt"],
    ["Failed to parse rewards from text file ", "C:\\jobs\\oracle\\t__x\\verifier\\reward.txt"],
    ["Failed to parse rewards from JSON file ", "/srv/jobs/oracle/t__x/verifier/reward.json"],
  ])("Harbor's reward-file message %s<absolute path> is removed, and the exception type is kept", (message, path) => {
    const text = `{\n    "id": "x",\n    "exception_info": {\n        "exception_type": "RewardFileNotFoundError",\n        "exception_message": ${JSON.stringify(`${message}${path}`)},\n        "occurred_at": "2026-10-01T13:29:04.493781Z"\n    }\n}`;
    expect(carried("trial-result.json", text)).toBe(
      '{\n    "id": "x",\n    "exception_info": {\n        "exception_type": "RewardFileNotFoundError",\n        "occurred_at": "2026-10-01T13:29:04.493781Z"\n    }\n}',
    );
  });

  test("Harbor's reward-file message with a relative path is carried as Harbor wrote it", () => {
    const text = '{\n    "exception_info": {\n        "exception_type": "RewardFileNotFoundError",\n        "exception_message": "No reward file found at jobs/oracle/t__x/verifier/reward.txt or jobs/oracle/t__x/verifier/reward.json"\n    }\n}';
    expect(carried("trial-result.json", text)).toBe(text);
  });

  test("a long run of path separators is read in linear time", () => {
    // #5302: a home-directory match that could start anywhere in a run of separators took about
    // 15 seconds on the record below, and an evidence file may be 8 MiB. Read in linear time it
    // takes about 6 milliseconds; the budget sits between the two.
    const text = JSON.stringify({ trial_name: "hello-world__55xttAM", agent: { kwargs: { pattern: "/".repeat(200_000) } } });
    const started = performance.now();
    const kept = carried("trial-config.json", text);
    const elapsed = performance.now() - started;
    expect(kept).toBe(text);
    expect(elapsed).toBeLessThan(1_000);
  });

  // #5332: the answer for each string below was taken from the patterns as they stood before they
  // were rewritten to read a long run once, so a rewrite that changes what the import refuses or
  // carries fails here. `agent.kwargs.note` is an ordinary name, so only the string's own shape counts.
  test.each([
    ["a user and password", "https://user:pw@example.com/x"],
    ["a user alone", "ssh://git@host/repo"],
    ["an empty user", "a://@h"],
    ["a port before the @", "a://host:8080@x"],
    ["a scheme after other words", "see https://u@h now"],
    ["a scheme in capitals", "HTTP://U@H"],
    ["a scheme that follows a digit", "1http://u@h"],
    ["a scheme that follows signs", "+.-a://u@h"],
    ["a scheme with every kind of character", "x-y.z+w1://u@h"],
    ["a second URL after a clean one", "https://example.com/a and ftp://bob@example.com"],
  ])("a string holding %s is refused as a URL carrying credentials", (_what, note) => {
    for (const [name, text, at] of trialRecords("agent.kwargs.note", note)) {
      const error = refusalOf(name, text);
      expect(error.message).toContain(`at ${at}, holds a URL carrying credentials`);
    }
  });

  test.each([
    ["a query parameter", "https://h/p?api_key=abc"],
    ["a second query parameter", "https://h/p?x=1&token=abc"],
    ["a fragment parameter", "https://h/p#access_token=abc"],
    ["a parameter after a fragment", "https://h/p?x=1#key=2"],
    ["a parameter after a semicolon", "https://h/p;passwd=x"],
    ["a parameter after an ampersand alone", "a&secret=1"],
    ["a name in capitals", "?Password=x"],
    ["a name that holds auth", "?my_authz=1"],
    ["a name that holds credential", "?credential=x"],
    ["a name that holds bearer", "?bearer=x"],
    ["a second question mark", "a?b?key=v"],
    ["a question mark and a semicolon", "?;key=v"],
    ["a value that is an equals sign", "?key=="],
    ["a name that ends at the equals sign of the value before it", "?x=1&Key=2"],
    ["a parameter inside text", "see https://h/p?token=abc, then"],
  ])("a string holding %s is refused as a URL carrying credentials", (_what, note) => {
    for (const [name, text, at] of trialRecords("agent.kwargs.note", note)) {
      const error = refusalOf(name, text);
      expect(error.message).toContain(`at ${at}, holds a URL carrying credentials`);
    }
  });

  test.each([
    ["a path with an @ after a slash", "https://example.com/path@x"],
    ["an @ after a question mark", "https://example.com?x=y@z"],
    ["an @ after a fragment", "https://example.com#frag@x"],
    ["an @ with no scheme", "://u@h"],
    ["a scheme of digits only", "123://u@h"],
    ["a scheme of signs only", "-+.://u@h"],
    ["a scheme with one slash", "a:/u@h"],
    ["a mailto address", "mailto:u@h"],
    ["white space after the slashes", "a:// u@h"],
    ["a credential name without a value", "?key"],
    ["a credential name with an empty value", "?key="],
    ["a credential name whose value is an ampersand", "?key=&x"],
    ["a credential name whose value is a fragment", "?key=#x"],
    ["a credential name whose value is white space", "?key= x"],
    ["a credential name split by white space", "?ke y=1"],
    ["a credential name split by a semicolon", "?k;ey=1"],
    ["a credential name with no question mark before it", "key=abc"],
    ["a credential name before the semicolon that starts the parameter", "key;x=1"],
    ["a credential name that is a value", "?a=key&b=1"],
    ["a credential name in a value that holds another equals sign", "?x=key=1"],
    ["a credential name in an ordinary parameter name", "?a=1&b=key"],
    ["a parameter with an ordinary name", "https://h/p?page=2&size=10#top"],
    ["three asterisks", "***"],
  ])("a string holding %s is carried as written", (_what, note) => {
    const text = JSON.stringify({ trial_name: "hello-world__55xttAM", agent: { kwargs: { note } } });
    expect(carried("trial-config.json", text)).toBe(text);
  });

  test.each([
    ["twenty characters of all three kinds", "Abcdefghij0123456789"],
    ["a run joined by a hyphen and an underscore", "abcdefghij-ABCDEFGH_12"],
    ["a run inside a sentence", "the token Abcdefghij0123456789 is here"],
    ["a run of a hundred", "aB3".repeat(34)],
  ])("a string holding %s is refused as token-shaped", (_what, note) => {
    for (const [name, text] of trialRecords("agent.kwargs.note", note)) {
      expect(refusalOf(name, text).message).toContain("holds a token-shaped string");
    }
  });

  test.each([
    ["nineteen characters", "Abcdefghij012345678"],
    ["twenty characters with no digit", "Abcdefghijklmnopqrst"],
    ["twenty characters with no upper case", "abcdefghij0123456789"],
    ["twenty characters with no lower case", "ABCDEFGHIJ0123456789"],
    ["runs of ten and thirteen split by a space", "Abcdefghij 0123456789abc"],
    ["runs split by a dot", "Abcdefghij.0123456789abc"],
    ["three kinds spread over two runs", "ABCDEFGHIJKLMNOP abcdefghijklmnop0123456789"],
  ])("a string holding %s is carried as written", (_what, note) => {
    const text = JSON.stringify({ trial_name: "hello-world__55xttAM", agent: { kwargs: { note } } });
    expect(carried("trial-config.json", text)).toBe(text);
  });

  // #5332: each check below took time that grew with the square of the run, or threw. An evidence
  // file may be 8 MiB. Before the fix the first took about 160 seconds on a 1,000,000-letter run
  // (7 seconds on 100,000, as measured in the issue) and the third about 3 minutes; the 8 MiB run
  // threw a RangeError. Read once, each takes well under a second; the budget leaves a loaded
  // runner room.
  const EVIDENCE_CAP = 8 * 1024 * 1024;
  function timedCarry(note: string): { readonly text: string; readonly kept: string; readonly milliseconds: number } {
    const text = JSON.stringify({ trial_name: "hello-world__55xttAM", agent: { kwargs: { note } } });
    const started = performance.now();
    const kept = carried("trial-config.json", text);
    return { text, kept, milliseconds: performance.now() - started };
  }

  test("a run of a million letters is read in linear time", () => {
    const { text, kept, milliseconds } = timedCarry("a".repeat(1_000_000));
    expect(kept).toBe(text);
    expect(milliseconds).toBeLessThan(2_000);
  });

  test("a question mark followed by a million characters that repeat a credential-shaped name is read in linear time", () => {
    for (const note of ["?" + "key".repeat(333_334), "#" + "token".repeat(200_000), "&" + "k;ey".repeat(250_000)]) {
      const { text, kept, milliseconds } = timedCarry(note);
      expect(kept).toBe(text);
      expect(milliseconds).toBeLessThan(2_000);
    }
  });

  test("a run of millions of question marks or scheme characters is read in linear time", () => {
    for (const note of ["?".repeat(2_000_000), "a:".repeat(1_000_000), "1".repeat(2_000_000) + "a", "a://".repeat(500_000)]) {
      const { text, kept, milliseconds } = timedCarry(note);
      expect(kept).toBe(text);
      expect(milliseconds).toBeLessThan(2_000);
    }
  });

  test("a single run of letters up to the evidence cap is carried, not an internal error", () => {
    const { text, kept, milliseconds } = timedCarry("a".repeat(EVIDENCE_CAP - 200));
    expect(kept).toBe(text);
    expect(milliseconds).toBeLessThan(5_000);
  });

  test("a single token-shaped run up to the evidence cap is refused as token-shaped, not an internal error", () => {
    const note = "aB3".repeat(Math.floor((EVIDENCE_CAP - 200) / 3));
    const error = refusalOf("trial-config.json", JSON.stringify({ trial_name: "hello-world__55xttAM", agent: { kwargs: { note } } }));
    expect(error.code).toBe("validation");
    expect(error.message).toContain("at agent.kwargs.note, holds a token-shaped string");
  });
});

/**
 * The real Harbor 0.21.0 jobs directories (#4937). `jobs` is three official Terminal-Bench 2.1
 * tasks by two arms, one trial each. `jobs-two-attempts` is two of those tasks by the same arms,
 * two attempts each. `jobs-resumed` is one oracle job of three tasks that was interrupted and then
 * resumed with `harbor job resume -f CancelledError`. See the fixture README for where each came
 * from and what was removed.
 */
const FIXTURES = fileURLToPath(new URL("../../test/fixtures", import.meta.url));
const REAL_JOBS = join(FIXTURES, "harbor-0.21-jobs-terminal-bench-2-1", "jobs");
const TWO_ATTEMPT_JOBS = join(FIXTURES, "harbor-0.21-jobs-terminal-bench-2-1", "jobs-two-attempts");
const REAL_TASKS = ["adaptive-rejection-sampler", "cancel-async-tasks", "chess-best-move"] as const;
const TWO_ATTEMPT_TASKS = ["adaptive-rejection-sampler", "cancel-async-tasks"] as const;
const RESUMED_JOBS = join(FIXTURES, "harbor-0.21-jobs-terminal-bench-2-1", "jobs-resumed");
const RESUMED_TASKS = ["adaptive-rejection-sampler", "cancel-async-tasks", "circuit-fibsqrt"] as const;
const REAL_MODEL = "openrouter/deepseek/deepseek-v4.1-flash";
/** The one measurement an official Task's `external-verifier` EvaluationSpec declares. */
const REWARD = [{ name: "reward", type: "number", required: true }] as const;

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

  test("with no official pin nothing is graded: the timed-out trial is timeout, by its nested exception type", () => {
    const records = readReal();
    const timedOut = cellKey(digests["chess-best-move"]!, "deepseek-flash", 1);
    expect(records.find((record) => record.cellKey === timedOut)).toMatchObject({
      outcome: "timeout",
      reason: "AgentTimeoutError",
      startedAt: "2026-10-01T13:13:30.253511Z",
      endedAt: "2026-10-01T13:31:19.179759Z",
    });
    // A bare name table says nothing about what a reward means, so every trial that has one is
    // carried as evidence and no measurement is read from it.
    expect(records.every((record) => record.measurements === undefined)).toBe(true);
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

  test("a task with an official pin and a declared reward is graded from each trial's raw reward map", () => {
    const officialPins = Object.fromEntries(REAL_TASKS.map((task) => [digests[task]!, {
      datasetId: TERMINAL_BENCH_2_1_DATASET_ID,
      datasetRevision: TERMINAL_BENCH_2_1_DATASET_REF,
      packageRef: TERMINAL_BENCH_21_OFFICIAL_TASKS.find((official) => official.name === task)!.ref,
      // Only chess-best-move declares the reward here, so only its two trials are graded.
      ...(task === "chess-best-move" ? { measurements: REWARD } : {}),
    }]));
    const records = readHarborRunRecords({
      jobsDir: REAL_JOBS,
      digestByTaskName: digests,
      arms: realArms,
      expected: realExpected,
      officialPins,
    });
    const graded = records.filter((record) => record.outcome === "graded");
    expect(Object.fromEntries(graded.map((record) => [record.cellKey, record.measurements]))).toEqual({
      [cellKey(digests["chess-best-move"]!, "oracle", 1)]: { reward: 1 },
      [cellKey(digests["chess-best-move"]!, "deepseek-flash", 1)]: { reward: 0 },
    });
    // A graded row carries no reason, and it carries the trial's own result file as evidence.
    for (const record of graded) {
      expect(record.reason).toBeUndefined();
      expect(record.evidence!.map((file) => file.name)).toEqual(["trial-result.json", "trial-config.json", "reward.txt"]);
    }
    expect(records.filter((record) => record.outcome === "ungradeable")).toHaveLength(4);
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

  test("a real trial record with its times edited out is read as a trial that has not finished", () => {
    // A Harbor 0.21.0 trial result carries no status word, so the reader tells a finished trial by
    // its `finished_at`. Removing the times therefore does not get an earlier run past the sealed
    // run window: the trial is recorded as not delivered, its reward unread. EXTERNAL-RUN-IMPORT.md
    // tells a claimant this, in place of the advice it used to give.
    const copy = join(jobsDir, "jobs");
    cpSync(REAL_JOBS, copy, { recursive: true });
    const resultPath = join(copy, "oracle", "chess-best-move__5FuHvzp", "result.json");
    const result = JSON.parse(readFileSync(resultPath, "utf8")) as Record<string, unknown>;
    expect(result["status"]).toBeUndefined();
    expect(result["verifier_result"]).toEqual({ rewards: { reward: 1 } });
    delete result["started_at"];
    delete result["finished_at"];
    writeFileSync(resultPath, JSON.stringify(result));

    const record = readReal(copy).find((entry) => entry.cellKey === cellKey(digests["chess-best-move"]!, "oracle", 1))!;
    expect(record).toMatchObject({ outcome: "unrun", reason: "Harbor trial is not finished" });
    expect(record.startedAt).toBeUndefined();
    expect(record.endedAt).toBeUndefined();
    expect(record.measurements).toBeUndefined();
    expect(record.evidence).toBeUndefined();
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

  function context(startAt = "2026-10-01T12:00:00.000Z"): OperationContext {
    let ms = Date.parse(startAt);
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
  async function lockedOfficialSlate(input: {
    readonly tasks?: readonly string[];
    readonly replicates?: number;
    readonly lockedAt?: string;
  } = {}): Promise<void> {
    const operation = context(input.lockedAt);
    initWorkspace(operation);
    createDraft(operation, { draftId: "draft-1", name: "Brought Harbor run" });
    const bound = await selectMethod(operation, {
      draftId: "draft-1",
      ref: "terminal-bench-2.1",
      cwd: jobsDir,
      hostPath: join(jobsDir, "host.json"),
      ids: (input.tasks ?? REAL_TASKS).join(","),
    });
    expect(bound.ok, JSON.stringify(bound)).toBe(true);
    if (input.replicates !== undefined) {
      const updated = updateDraft(operation, { draftId: "draft-1", patch: { replicates: input.replicates } });
      expect(updated.ok, JSON.stringify(updated)).toBe(true);
    }
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

  function copyOfRealJobs(source = REAL_JOBS): string {
    const copy = join(jobsDir, "jobs");
    cpSync(source, copy, { recursive: true });
    return copy;
  }

  function sealedJson(sha256: string): Record<string, any> {
    return JSON.parse(new TextDecoder().decode(getSealedBytes(workspaceDir, sha256))) as Record<string, any>;
  }

  /** `<arm>: <task> #<replicate>` for a record, read from the Task its cell names. */
  function cellName(key: string): string {
    const [taskSha256, arm, replicate] = key.split("/") as [string, string, string];
    return `${arm}: ${sealedJson(taskSha256)["payload"]["taskName"] as string} #${replicate}`;
  }

  function byCell<T>(dump: HarborRunImportDump, pick: (record: HarborRunImportDump["records"][number]) => T): Record<string, T> {
    return Object.fromEntries(dump.records.map((record) => [cellName(record.cellKey), pick(record)]));
  }

  function recordOf(dump: HarborRunImportDump, name: string): HarborRunImportDump["records"][number] {
    const found = dump.records.find((record) => cellName(record.cellKey) === name);
    if (found === undefined) throw new Error(`no record for ${name}`);
    return found;
  }

  /** The verdict the Task's own sealed rule gives a record's measurements. */
  function sealedVerdict(record: HarborRunImportDump["records"][number]): string {
    const task = sealedJson(record.cellKey.split("/")[0]!);
    const spec = parseEvaluationSpec(getSealedBytes(workspaceDir, task["evaluation"]["digest"]["sha256"] as string));
    return evaluateVerdictRule(
      spec.verdictRule as Parameters<typeof evaluateVerdictRule>[0],
      { ...record.measurements },
    ).verdict;
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

  test("names every task of a draft bound by method terminal-bench-2.1 and grades the real jobs directory", async () => {
    await lockedOfficialSlate();
    const dump = readHarborRunImport({ workspaceDir, draftId: "draft-1", jobsDir: REAL_JOBS });
    expect(dump.records).toHaveLength(6);
    expect(new Set(dump.records.map((record) => record.cellKey)).size).toBe(6);
    expect(dump.records.map((record) => record.outcome)).toEqual(Array.from({ length: 6 }, () => "graded"));
    // Harbor's raw reward for each trial: the reference solution passed all three, the agent one.
    expect(byCell(dump, (record) => record.measurements)).toEqual({
      "oracle: adaptive-rejection-sampler #1": { reward: 1 },
      "oracle: cancel-async-tasks #1": { reward: 1 },
      "oracle: chess-best-move #1": { reward: 1 },
      "deepseek-flash: adaptive-rejection-sampler #1": { reward: 1 },
      "deepseek-flash: cancel-async-tasks #1": { reward: 0 },
      "deepseek-flash: chess-best-move #1": { reward: 0 },
    });
    expect(byCell(dump, sealedVerdict)).toEqual({
      "oracle: adaptive-rejection-sampler #1": "pass",
      "oracle: cancel-async-tasks #1": "pass",
      "oracle: chess-best-move #1": "pass",
      "deepseek-flash: adaptive-rejection-sampler #1": "pass",
      "deepseek-flash: cancel-async-tasks #1": "fail",
      "deepseek-flash: chess-best-move #1": "fail",
    });
  });

  test("a trial that ran to the agent timeout and still has a reward is graded by that reward", async () => {
    await lockedOfficialSlate();
    const dump = readHarborRunImport({ workspaceDir, draftId: "draft-1", jobsDir: REAL_JOBS });
    const timedOut = recordOf(dump, "deepseek-flash: chess-best-move #1");
    expect(JSON.parse(readFileSync(join(REAL_JOBS, "terminus-2", "chess-best-move__gs92yNg", "result.json"), "utf8"))
      .exception_info.exception_type).toBe("AgentTimeoutError");
    expect(timedOut).toMatchObject({
      outcome: "graded",
      measurements: { reward: 0 },
      startedAt: "2026-10-01T13:13:30.253511Z",
      endedAt: "2026-10-01T13:31:19.179759Z",
    });
    // A graded row has no reason field. The exception stays in the trial result it carries.
    expect(timedOut.reason).toBeUndefined();
    expect(timedOut.evidence).toEqual([
      { name: "trial-result.json", path: "terminus-2/chess-best-move__gs92yNg/result.json" },
      { name: "trial-config.json", path: "terminus-2/chess-best-move__gs92yNg/config.json" },
      { name: "reward.txt", path: "terminus-2/chess-best-move__gs92yNg/verifier/reward.txt" },
    ]);
  });

  test("a reward of 0.5 is carried as a decimal string and the sealed rule answers inconclusive", async () => {
    await lockedOfficialSlate();
    const jobs = copyOfRealJobs();
    rewriteJson(join(jobs, "terminus-2", "cancel-async-tasks__xiVVWvx", "result.json"), (result) => {
      result["verifier_result"].rewards.reward = 0.5;
    });
    const dump = readHarborRunImport({ workspaceDir, draftId: "draft-1", jobsDir: jobs });
    const half = recordOf(dump, "deepseek-flash: cancel-async-tasks #1");
    expect(half).toMatchObject({ outcome: "graded", measurements: { reward: "0.5" } });
    expect(sealedVerdict(half)).toBe("inconclusive");
    // The whole dump imports: a fractional reward is sealed, not refused.
    const imported = await importRunRecords(context("2026-10-01T14:00:00.000Z"), {
      draftId: "draft-1",
      records: dump.records,
      source: dump.source,
      evidenceRoot: dump.evidenceRoot,
      namedReader: "harbor",
    });
    expect(imported).toMatchObject({ ok: true, result: { written: { graded: 6, ungradeable: 0, notDelivered: 0 } } });
  });

  test("a trial with VerifierTimeoutError and no reward stays timeout", async () => {
    await lockedOfficialSlate();
    const jobs = copyOfRealJobs();
    rewriteJson(join(jobs, "terminus-2", "chess-best-move__gs92yNg", "result.json"), (result) => {
      result["verifier_result"] = null;
      result["exception_info"].exception_type = "VerifierTimeoutError";
    });
    const dump = readHarborRunImport({ workspaceDir, draftId: "draft-1", jobsDir: jobs });
    const timedOut = recordOf(dump, "deepseek-flash: chess-best-move #1");
    expect(timedOut).toMatchObject({ outcome: "timeout", reason: "VerifierTimeoutError" });
    expect(timedOut.measurements).toBeUndefined();
    expect(timedOut.evidence).toBeUndefined();
    expect(dump.records.filter((record) => record.outcome === "graded")).toHaveLength(5);
  });

  test("a reward map without the declared key is ungradeable, and the reason names the key", async () => {
    await lockedOfficialSlate();
    const jobs = copyOfRealJobs();
    rewriteJson(join(jobs, "oracle", "chess-best-move__5FuHvzp", "result.json"), (result) => {
      result["verifier_result"].rewards = { score: 1.0 };
    });
    const dump = readHarborRunImport({ workspaceDir, draftId: "draft-1", jobsDir: jobs });
    const keyless = recordOf(dump, "oracle: chess-best-move #1");
    expect(keyless).toMatchObject({ outcome: "ungradeable", reason: 'Harbor reward map has no "reward" key' });
    expect(keyless.measurements).toBeUndefined();
    expect(keyless.evidence!.map((file) => file.name)).toContain("trial-result.json");
  });

  test.each([
    ["a string", "1"],
    ["a boolean", true],
    ["null", null],
    ["a nested object", { value: 1 }],
  ])("a reward that is %s is ungradeable, and the reason names the key", async (_what, value) => {
    await lockedOfficialSlate();
    const jobs = copyOfRealJobs();
    rewriteJson(join(jobs, "oracle", "chess-best-move__5FuHvzp", "result.json"), (result) => {
      result["verifier_result"].rewards.reward = value;
    });
    const dump = readHarborRunImport({ workspaceDir, draftId: "draft-1", jobsDir: jobs });
    const record = recordOf(dump, "oracle: chess-best-move #1");
    expect(record).toMatchObject({ outcome: "ungradeable", reason: 'Harbor reward "reward" is not a finite number' });
    expect(record.measurements).toBeUndefined();
  });

  test("a Task whose sealed spec names another package as its grader is not graded", async () => {
    // A hand-built slate: the official chess-best-move Task, rebound to a spec that is the
    // official one in every field but the grader digest. No command produces this Task. A trial
    // is held to the package ref the Task seals, so its reward is that package's reward, and it
    // is not read under a spec that calls a different package its grader.
    const operation = context();
    initWorkspace(operation);
    createDraft(operation, { draftId: "draft-1", name: "Hand-built slate" });
    const built = buildTerminalBench21Tasks(["chess-best-move"]);
    const decode = (bytes: Uint8Array): Record<string, any> => JSON.parse(new TextDecoder().decode(bytes));
    const official = buildTerminalBench21EvaluationSpec("chess-best-move");
    const spec = sealEvaluationSpec({
      ...official,
      grader: { ...official.grader, digest: { sha256: "0".repeat(64) } },
    });
    const taskBytes = sealTask({
      ...decode(built.tasks[0]!.bytes),
      evaluation: { digest: { sha256: spec.digest.slice("sha256:".length) } },
    } as Parameters<typeof sealTask>[0]);
    const benchmark = sealBenchmark({
      ...decode(built.benchmark.bytes),
      items: [{ task: { digest: { sha256: sha256Hex(taskBytes) } } }],
    } as Parameters<typeof sealBenchmark>[0]);
    for (const bytes of [built.profile.bytes, spec.bytes, taskBytes, benchmark.bytes]) {
      putSealedBytes(workspaceDir, bytes);
    }
    attachBenchmarkToDraft(workspaceDir, "draft-1", benchmark.digest.slice("sha256:".length), operation.clock());
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

    const dump = readHarborRunImport({ workspaceDir, draftId: "draft-1", jobsDir: REAL_JOBS });
    const onSlate = dump.records.filter((record) => record.cellKey.startsWith(sha256Hex(taskBytes)));
    expect(onSlate).toHaveLength(2);
    for (const record of onSlate) {
      expect(record.outcome).not.toBe("graded");
      expect(record.measurements).toBeUndefined();
    }
    expect(dump.records.some((record) => record.outcome === "graded")).toBe(false);
  });

  test("the Harbor version is the one the job lock.json records", async () => {
    await lockedOfficialSlate();
    const dump = readHarborRunImport({ workspaceDir, draftId: "draft-1", jobsDir: REAL_JOBS });
    expect(dump.source).toEqual({ harness: "harbor", version: "0.21.0" });
  });

  test("the accepted Harbor versions are exactly the versions of the real jobs directories in the tree", () => {
    const versions = new Set<string>();
    const walk = (dir: string): void => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        if (entry.isDirectory()) walk(join(dir, entry.name));
        // A job `lock.json` states the Harbor version; a trial `lock.json` is not kept in a fixture.
        if (entry.isFile() && entry.name === "lock.json") {
          versions.add(JSON.parse(readFileSync(join(dir, entry.name), "utf8")).harbor.version as string);
        }
      }
    };
    for (const entry of readdirSync(FIXTURES, { withFileTypes: true })) {
      if (entry.isDirectory() && entry.name.startsWith("harbor-")) walk(join(FIXTURES, entry.name));
    }
    expect([...versions].sort()).toEqual([...HARBOR_RUN_IMPORT_VERSIONS].sort());
    expect(HARBOR_RUN_IMPORT_VERSIONS).toEqual(["0.21.0"]);
  });

  test("a job written by another Harbor version is refused, naming the job and both versions", async () => {
    await lockedOfficialSlate();
    const jobs = copyOfRealJobs();
    rewriteJson(join(jobs, "terminus-2", "lock.json"), (lock) => {
      lock["harbor"].version = "0.23.0";
    });
    const refused = refusal(() => readHarborRunImport({ workspaceDir, draftId: "draft-1", jobsDir: jobs }));
    expect(refused.code).toBe("validation");
    expect(refused.message).toContain("Harbor job terminus-2");
    expect(refused.message).toContain("0.23.0");
    expect(refused.message).toContain("0.21.0");
  });

  test("the refusal the claimant walkthrough quotes is the one the reader prints (#5021)", async () => {
    await lockedOfficialSlate();
    const jobs = copyOfRealJobs();
    rewriteJson(join(jobs, "terminus-2", "lock.json"), (lock) => {
      lock["harbor"].version = "0.24.0";
    });
    const refused = refusal(() => readHarborRunImport({ workspaceDir, draftId: "draft-1", jobsDir: jobs }));
    const walkthrough = readFileSync(fileURLToPath(new URL("../../../CLAIMANT-WALKTHROUGH.md", import.meta.url)), "utf8");
    expect(walkthrough).toContain(`\n${refused.message}\n`);
  });

  test("a later patch release of the accepted line is refused too: there is no fixture for it", async () => {
    await lockedOfficialSlate();
    const jobs = copyOfRealJobs();
    rewriteJson(join(jobs, "oracle", "lock.json"), (lock) => {
      lock["harbor"].version = "0.21.1";
    });
    const refused = refusal(() => readHarborRunImport({ workspaceDir, draftId: "draft-1", jobsDir: jobs }));
    expect(refused.message).toContain("Harbor job oracle");
    expect(refused.message).toContain("0.21.1");
  });

  test.each([
    ["a lock.json that states no version", (jobs: string) => rewriteJson(join(jobs, "oracle", "lock.json"), (lock) => {
      delete lock["harbor"];
    })],
    ["no lock.json", (jobs: string) => rmSync(join(jobs, "oracle", "lock.json"))],
  ])("a job with %s is refused, naming the job", async (_what, strip) => {
    await lockedOfficialSlate();
    const jobs = copyOfRealJobs();
    // The job config.json is not where Harbor states its version, so a version there is not read.
    rewriteJson(join(jobs, "oracle", "config.json"), (config) => {
      config["harbor_version"] = "0.21.0";
    });
    strip(jobs);
    const refused = refusal(() => readHarborRunImport({ workspaceDir, draftId: "draft-1", jobsDir: jobs }));
    expect(refused.code).toBe("validation");
    expect(refused.message).toContain("Harbor job oracle");
    expect(refused.message).toContain("states no Harbor version");
    expect(refused.message).toContain("0.21.0");
  });

  test("a job that allowed retries is refused, naming the job", async () => {
    await lockedOfficialSlate();
    const jobs = copyOfRealJobs();
    rewriteJson(join(jobs, "terminus-2", "lock.json"), (lock) => {
      lock["retry"].max_retries = 3;
    });
    const refused = refusal(() => readHarborRunImport({ workspaceDir, draftId: "draft-1", jobsDir: jobs }));
    expect(refused.code).toBe("validation");
    expect(refused.message).toContain("Harbor job terminus-2");
    expect(refused.message).toContain("retry.max_retries");
    expect(refused.message).toContain("--max-retries 0");
  });

  test("a job whose lock.json states no retry setting is refused: retries off is not shown", async () => {
    await lockedOfficialSlate();
    const jobs = copyOfRealJobs();
    rewriteJson(join(jobs, "terminus-2", "lock.json"), (lock) => {
      delete lock["retry"];
    });
    const refused = refusal(() => readHarborRunImport({ workspaceDir, draftId: "draft-1", jobsDir: jobs }));
    expect(refused.message).toContain("Harbor job terminus-2");
    expect(refused.message).toContain("retry.max_retries");
  });

  test("a job whose result counts a retry is refused, naming the job", async () => {
    await lockedOfficialSlate();
    const jobs = copyOfRealJobs();
    rewriteJson(join(jobs, "oracle", "result.json"), (result) => {
      result["stats"].n_retries = 1;
    });
    const refused = refusal(() => readHarborRunImport({ workspaceDir, draftId: "draft-1", jobsDir: jobs }));
    expect(refused.code).toBe("validation");
    expect(refused.message).toContain("Harbor job oracle");
    expect(refused.message).toContain("n_retries");
  });

  test("a directory that holds no Harbor job is refused: there is no version to accept", async () => {
    await lockedOfficialSlate();
    const empty = join(jobsDir, "empty");
    mkdirSync(empty);
    const refused = refusal(() => readHarborRunImport({ workspaceDir, draftId: "draft-1", jobsDir: empty }));
    expect(refused.code).toBe("validation");
    expect(refused.message).toContain("holds no Harbor job");
  });

  test("the evidence cap is the larger of 64 MiB and 4 MiB for each expected cell", async () => {
    expect(HARBOR_RUN_IMPORT_EVIDENCE_BYTES_PER_CELL).toBe(4 * 1024 * 1024);
    expect(EXTERNAL_IMPORT_MAX_AGGREGATE_BYTES).toBe(64 * 1024 * 1024);
    expect(harborRunImportEvidenceCap(6)).toBe(64 * 1024 * 1024);
    expect(harborRunImportEvidenceCap(16)).toBe(64 * 1024 * 1024);
    expect(harborRunImportEvidenceCap(17)).toBe(68 * 1024 * 1024);
    // The full slate at five replicates by two arms.
    expect(harborRunImportEvidenceCap(89 * 5 * 2)).toBe(3560 * 1024 * 1024);
    await lockedOfficialSlate();
    const dump = readHarborRunImport({ workspaceDir, draftId: "draft-1", jobsDir: REAL_JOBS });
    expect(dump.maxAggregateEvidenceBytes).toBe(harborRunImportEvidenceCap(6));
  });

  describe("two attempts per task (the real jobs-two-attempts record)", () => {
    /** The record ran 19:10Z to 19:33Z on 2026-10-06. */
    const LOCKED_AT = "2026-10-06T19:00:00.000Z";
    const IMPORTED_AT = "2026-10-06T20:00:00.000Z";

    function twoAttemptSlate(): Promise<void> {
      return lockedOfficialSlate({ tasks: TWO_ATTEMPT_TASKS, replicates: 2, lockedAt: LOCKED_AT });
    }

    function importDump(dump: HarborRunImportDump) {
      return importRunRecords(context(IMPORTED_AT), {
        draftId: "draft-1",
        records: dump.records,
        source: dump.source,
        evidenceRoot: dump.evidenceRoot,
        namedReader: "harbor",
        maxAggregateEvidenceBytes: dump.maxAggregateEvidenceBytes,
      });
    }

    test("two trial directories of one task fill replicates 1 and 2", async () => {
      await twoAttemptSlate();
      const dump = readHarborRunImport({ workspaceDir, draftId: "draft-1", jobsDir: TWO_ATTEMPT_JOBS });
      expect(dump.source).toEqual({ harness: "harbor", version: "0.21.0" });
      expect(dump.records).toHaveLength(8);
      expect(dump.records.every((record) => record.outcome === "graded")).toBe(true);
      // Both agent trials of adaptive-rejection-sampler ran to AgentTimeoutError. One has a
      // reward of 1 and one of 0, and each is graded by its own.
      expect(byCell(dump, (record) => record.measurements)).toEqual({
        "oracle: adaptive-rejection-sampler #1": { reward: 1 },
        "oracle: adaptive-rejection-sampler #2": { reward: 1 },
        "oracle: cancel-async-tasks #1": { reward: 1 },
        "oracle: cancel-async-tasks #2": { reward: 1 },
        "deepseek-flash: adaptive-rejection-sampler #1": { reward: 1 },
        "deepseek-flash: adaptive-rejection-sampler #2": { reward: 0 },
        "deepseek-flash: cancel-async-tasks #1": { reward: 0 },
        "deepseek-flash: cancel-async-tasks #2": { reward: 1 },
      });
    });

    test("Harbor numbers neither trial, so the reader numbers them by directory name in code-point order", async () => {
      await twoAttemptSlate();
      const dump = readHarborRunImport({ workspaceDir, draftId: "draft-1", jobsDir: TWO_ATTEMPT_JOBS });
      // `EZiYZgD` sorts before `eiRCBED` by code point, and after it in a dictionary order. The
      // numbering must not depend on the locale of the machine that runs the import.
      expect(byCell(dump, (record) => record.evidence![0]!.path)).toEqual({
        "oracle: adaptive-rejection-sampler #1": "oracle/adaptive-rejection-sampler__VmTuVai/result.json",
        "oracle: adaptive-rejection-sampler #2": "oracle/adaptive-rejection-sampler__xRxLebm/result.json",
        "oracle: cancel-async-tasks #1": "oracle/cancel-async-tasks__EZiYZgD/result.json",
        "oracle: cancel-async-tasks #2": "oracle/cancel-async-tasks__eiRCBED/result.json",
        "deepseek-flash: adaptive-rejection-sampler #1": "terminus-2/adaptive-rejection-sampler__8eveqhg/result.json",
        "deepseek-flash: adaptive-rejection-sampler #2": "terminus-2/adaptive-rejection-sampler__T6ZojUQ/result.json",
        "deepseek-flash: cancel-async-tasks #1": "terminus-2/cancel-async-tasks__ngFYxLa/result.json",
        "deepseek-flash: cancel-async-tasks #2": "terminus-2/cancel-async-tasks__u3KL6Xo/result.json",
      });
    });

    test("the two-attempt record imports onto a two-replicate run, every cell graded", async () => {
      await twoAttemptSlate();
      const dump = readHarborRunImport({ workspaceDir, draftId: "draft-1", jobsDir: TWO_ATTEMPT_JOBS });
      const imported = await importDump(dump);
      expect(imported).toMatchObject({
        ok: true,
        result: { importedCellCount: 8, written: { graded: 8, ungradeable: 0, notDelivered: 0 } },
      });
      expect(readDraftDocument(workspaceDir, "draft-1").state).toBe("running");
    });

    test("a third trial directory for one task is refused at import, and the draft stays locked", async () => {
      await twoAttemptSlate();
      const jobs = copyOfRealJobs(TWO_ATTEMPT_JOBS);
      const third = join(jobs, "oracle", "cancel-async-tasks__zzzzzzz");
      cpSync(join(jobs, "oracle", "cancel-async-tasks__EZiYZgD"), third, { recursive: true });
      for (const file of ["config.json", "result.json"]) {
        rewriteJson(join(third, file), (value) => {
          value["trial_name"] = "cancel-async-tasks__zzzzzzz";
        });
      }
      const dump = readHarborRunImport({ workspaceDir, draftId: "draft-1", jobsDir: jobs });
      expect(dump.records).toHaveLength(9);
      const imported = await importDump(dump);
      expect(imported.ok).toBe(false);
      if (imported.ok) throw new Error("expected the import to be refused");
      expect(imported.error.code).toBe("validation");
      expect(imported.error.issues!.map((issue) => issue.path)).toEqual(["unknown-slot"]);
      expect(imported.error.detail).toMatch(/unknown slot\s+[a-f0-9]{64}\/oracle\/3 /u);
      expect(readDraftDocument(workspaceDir, "draft-1").state).toBe("locked");
    });

    test("the same record on a one-replicate run is refused: the second attempt has no slot", async () => {
      await lockedOfficialSlate({ tasks: TWO_ATTEMPT_TASKS, lockedAt: LOCKED_AT });
      const dump = readHarborRunImport({ workspaceDir, draftId: "draft-1", jobsDir: TWO_ATTEMPT_JOBS });
      const imported = await importDump(dump);
      expect(imported.ok).toBe(false);
      if (imported.ok) throw new Error("expected the import to be refused");
      expect(imported.error.issues!.map((issue) => issue.path)).toEqual(Array.from({ length: 4 }, () => "unknown-slot"));
      expect(readDraftDocument(workspaceDir, "draft-1").state).toBe("locked");
    });
  });

  describe("an interrupted job resumed by Harbor (the real jobs-resumed record, #5175)", () => {
    /** The job started at 15:55:44Z on 2026-11-11 and the resume finished at 16:01:05Z. */
    const LOCKED_AT = "2026-11-11T15:50:00.000Z";
    const IMPORTED_AT = "2026-11-11T16:30:00.000Z";

    test("resume -f CancelledError leaves one finished trial for each task, and the import takes the job", async () => {
      await lockedOfficialSlate({ tasks: RESUMED_TASKS, lockedAt: LOCKED_AT });
      const dump = readHarborRunImport({ workspaceDir, draftId: "draft-1", jobsDir: RESUMED_JOBS });
      expect(dump.source).toEqual({ harness: "harbor", version: "0.21.0" });
      // Harbor removed the cancelled trial and ran its task again. The record holds no trial
      // for the agent arm, so that arm's slots are not delivered.
      expect(byCell(dump, (record) => record.outcome)).toEqual({
        "oracle: adaptive-rejection-sampler #1": "graded",
        "oracle: cancel-async-tasks #1": "graded",
        "oracle: circuit-fibsqrt #1": "graded",
        "deepseek-flash: adaptive-rejection-sampler #1": "unrun",
        "deepseek-flash: cancel-async-tasks #1": "unrun",
        "deepseek-flash: circuit-fibsqrt #1": "unrun",
      });
      const imported = await importRunRecords(context(IMPORTED_AT), {
        draftId: "draft-1",
        records: dump.records,
        source: dump.source,
        evidenceRoot: dump.evidenceRoot,
        namedReader: "harbor",
        maxAggregateEvidenceBytes: dump.maxAggregateEvidenceBytes,
      });
      expect(imported).toMatchObject({
        ok: true,
        result: { importedCellCount: 6, written: { graded: 3, ungradeable: 0, notDelivered: 3 } },
      });
      expect(readDraftDocument(workspaceDir, "draft-1").state).toBe("running");
    });
  });

  describe("the host paths Harbor writes into its own record of a trial (#5266)", () => {
    /** The real record's agent trial that ended in `AgentTimeoutError`, and so has a stack trace. */
    const TIMED_OUT_TRIAL = join("terminus-2", "chess-best-move__gs92yNg");
    /** An install path of the kind a Harbor stack trace is made of. */
    const INSTALL_PATH = "/opt/harbor-install/lib/python3.12/site-packages/harbor/trial/trial.py";

    /** Every trial directory of a jobs directory, relative to it. */
    function trialDirs(jobs: string): readonly string[] {
      return readdirSync(jobs).flatMap((job) =>
        readdirSync(join(jobs, job), { withFileTypes: true })
          .filter((entry) => entry.isDirectory())
          .map((entry) => join(job, entry.name)));
    }

    /** Puts `line` on its own line after the first line of `path` that holds `after`. */
    function insertLine(path: string, after: string, line: string): void {
      const text = readFileSync(path, "utf8");
      const at = text.indexOf(after);
      expect(at, `${path} holds ${after}`).toBeGreaterThan(-1);
      const end = text.indexOf("\n", at) + 1;
      writeFileSync(path, `${text.slice(0, end)}${line}\n${text.slice(end)}`);
    }

    /**
     * The real jobs directory with the two lines `prune.mjs` deleted from each trial result put
     * back where Harbor 0.21.0 writes them: `trial_uri`, the trial directory as an absolute
     * `file:` URI, and on the timed-out trial `exception_info.exception_traceback`.
     */
    function jobsAsHarborWroteThem(): string {
      const jobs = copyOfRealJobs();
      for (const trial of trialDirs(jobs)) {
        const dir = join(jobs, trial);
        insertLine(
          join(dir, "result.json"),
          `"trial_name": "${basename(trial)}",`,
          `    "trial_uri": ${JSON.stringify(pathToFileURL(realpathSync(dir)).href)},`,
        );
      }
      const traceback = "Traceback (most recent call last):\n"
        + `  File "${INSTALL_PATH}", line 512, in _execute_agent\n`
        + "    await asyncio.wait_for(\n"
        + "harbor.trial.trial.AgentTimeoutError: Agent execution timed out after 900.0 seconds\n";
      insertLine(
        join(jobs, TIMED_OUT_TRIAL, "result.json"),
        '"exception_message": ',
        `        "exception_traceback": ${JSON.stringify(traceback)},`,
      );
      return jobs;
    }

    function importJobs(jobs: string) {
      const dump = readHarborRunImport({ workspaceDir, draftId: "draft-1", jobsDir: jobs });
      return importRunRecords(context("2026-10-01T14:00:00.000Z"), {
        draftId: "draft-1",
        records: dump.records,
        source: dump.source,
        evidenceRoot: dump.evidenceRoot,
        namedReader: "harbor",
      }).then((imported) => ({ dump, imported }));
    }

    /** Each evidence file the import sealed, by its path in the jobs directory. */
    function carriedFiles(dump: HarborRunImportDump, declarationSha256: string): Map<string, Uint8Array> {
      const declaration = ExternalRunImportDeclarationSchema.parse(sealedJson(declarationSha256));
      const carried = new Map<string, Uint8Array>();
      for (const record of dump.records) {
        const row = declaration.rows.find((candidate) => candidate.cellKey === record.cellKey)!;
        (record.evidence ?? []).forEach((ref, index) => {
          expect(row.evidence![index]!.name).toBe(ref.name);
          carried.set(ref.path, getSealedBytes(workspaceDir, row.evidence![index]!.sha256));
        });
      }
      return carried;
    }

    test("an absolute trial_uri and a stack trace are neither carried nor published, and every other byte is", async () => {
      await lockedOfficialSlate();
      const jobs = jobsAsHarborWroteThem();
      const { dump, imported } = await importJobs(jobs);
      expect(imported.ok, JSON.stringify(imported)).toBe(true);
      if (!imported.ok) return;

      // What each trial carries is the file Harbor wrote less those two members. That is the
      // committed record, which prune.mjs made from the same files by deleting the same lines.
      const carried = carriedFiles(dump, imported.result.declarationSha256);
      expect(carried.size).toBe(18);
      for (const [path, bytes] of carried) {
        expect(Buffer.from(bytes).equals(readFileSync(join(REAL_JOBS, path))), path).toBe(true);
      }

      const collected = await runCollect(context("2026-10-01T14:05:00.000Z"), { draftId: "draft-1" });
      expect(collected.ok, JSON.stringify(collected)).toBe(true);
      const reported = await runReport(context("2026-10-01T14:10:00.000Z"), { draftId: "draft-1" });
      expect(reported.ok, JSON.stringify(reported)).toBe(true);
      if (!reported.ok) return;
      const bundle = materializePublicBundle({
        workspaceDir,
        draftId: "draft-1",
        benchmarkSha256: reported.result.claimPackage.records.benchmarkSha256,
        runState: readRunState(workspaceDir, "draft-1")!,
      });
      await expect(verifyPublicBundle(bundle.bundleDir)).resolves.toMatchObject({ identity: bundle.identity });
      const published = readdirSync(bundle.bundleDir, { recursive: true, withFileTypes: true })
        .filter((entry) => entry.isFile())
        .map((entry) => readFileSync(join(entry.parentPath, entry.name), "utf8"))
        .join("\n");
      for (const hostPath of [jobs, realpathSync(jobs), pathToFileURL(realpathSync(jobs)).href, INSTALL_PATH]) {
        expect(published.includes(hostPath), hostPath).toBe(false);
      }
      expect(published).not.toContain("Traceback (most recent call last)");
    });

    test("an absolute trials_dir is carried in neither the trial config nor its copy in the trial result", async () => {
      await lockedOfficialSlate();
      const jobs = jobsAsHarborWroteThem();
      // Harbor records the jobs directory it was given, and given an absolute one, every trial
      // records it twice.
      for (const trial of trialDirs(jobs)) {
        for (const file of ["config.json", "result.json"]) {
          const path = join(jobs, trial, file);
          const job = trial.split(sep)[0]!;
          const relative = `"trials_dir": "jobs/${job}"`;
          const text = readFileSync(path, "utf8");
          expect(text, path).toContain(relative);
          writeFileSync(path, text.replace(relative, `"trials_dir": ${JSON.stringify(join(realpathSync(jobs), job))}`));
        }
      }
      const { dump, imported } = await importJobs(jobs);
      expect(imported.ok, JSON.stringify(imported)).toBe(true);
      if (!imported.ok) return;
      for (const [path, bytes] of carriedFiles(dump, imported.result.declarationSha256)) {
        const committed = readFileSync(join(REAL_JOBS, path), "utf8");
        const expected = path.endsWith("reward.txt")
          ? committed
          : committed.replace(/^ *"trials_dir": "jobs\/[a-z0-9-]+",\n/mu, "");
        expect(new TextDecoder().decode(bytes), path).toBe(expected);
      }
    });

    test.each([
      ["the jobs directory", (jobs: string) => join(realpathSync(jobs), "cache")],
      ["your home directory", () => join(homedir(), "datasets")],
    ])("a trial record that still names %s is refused at import, naming the file, and the draft stays locked", async (what, hostPath) => {
      await lockedOfficialSlate();
      const jobs = jobsAsHarborWroteThem();
      // A bind mount: a Harbor setting that can hold any path, and that the import does not remove.
      const path = join(jobs, TIMED_OUT_TRIAL, "result.json");
      const text = readFileSync(path, "utf8");
      expect(text).toContain('"mounts": null,');
      const mount = JSON.stringify([{ type: "bind", source: hostPath(jobs), target: "/data" }]);
      writeFileSync(path, text.replace('"mounts": null,', `"mounts": ${mount},`));
      const { imported } = await importJobs(jobs);
      expect(imported.ok).toBe(false);
      if (imported.ok) throw new Error("expected the import to be refused");
      expect(imported.error.code).toBe("validation");
      expect(imported.error.issues!.map((issue) => issue.path)).toEqual(["terminus-2/chess-best-move__gs92yNg/result.json"]);
      expect(imported.error.detail).toContain("terminus-2/chess-best-move__gs92yNg/result.json");
      expect(imported.error.detail).toContain("trial-result.json");
      expect(imported.error.detail).toContain(what);
      expect(readDraftDocument(workspaceDir, "draft-1").state).toBe("locked");
    });

    // #5289: a record Harbor wrote on another machine is checked against more than this
    // machine's jobs and home directories.
    test.each([
      [
        "a home directory of another machine",
        ['"mounts": null,', `"mounts": ${JSON.stringify([{ type: "bind", source: "/home/runner-7/datasets", target: "/data" }])},`],
        "config.environment.mounts[0].source",
        "/home/runner-7",
        undefined,
      ],
      [
        "a credential",
        ['"kwargs": {},', '"kwargs": {"api_key": "0123456789abcdef0123456789abcdef"},'],
        "config.agent.kwargs.api_key",
        "a value under a credential-shaped name",
        "0123456789abcdef0123456789abcdef",
      ],
    ] as const)("a trial record holding %s is refused at import, naming the file and the field, and the draft stays locked", async (_what, [from, to], field, shown, secret) => {
      await lockedOfficialSlate();
      const jobs = jobsAsHarborWroteThem();
      const path = join(jobs, TIMED_OUT_TRIAL, "result.json");
      const text = readFileSync(path, "utf8");
      expect(text).toContain(from);
      writeFileSync(path, text.replace(from, to));
      const { imported } = await importJobs(jobs);
      expect(imported.ok).toBe(false);
      if (imported.ok) throw new Error("expected the import to be refused");
      expect(imported.error.code).toBe("validation");
      expect(imported.error.issues!.map((issue) => issue.path)).toEqual(["terminus-2/chess-best-move__gs92yNg/result.json"]);
      expect(imported.error.detail).toContain("terminus-2/chess-best-move__gs92yNg/result.json");
      expect(imported.error.detail).toContain(field);
      expect(imported.error.detail).toContain(shown);
      if (secret !== undefined) expect(JSON.stringify(imported.error)).not.toContain(secret);
      expect(readDraftDocument(workspaceDir, "draft-1").state).toBe("locked");
    });

    // #5302: Harbor given an absolute -o outside any home directory on a CI runner, and the
    // trial's exception message naming a file under it.
    test("a trial record naming the jobs directory Harbor wrote it to on another machine is refused at import, naming the file and the field", async () => {
      await lockedOfficialSlate();
      const jobs = jobsAsHarborWroteThem();
      const trialsDir = "/scratch/ci-builder/jobs/terminus-2";
      const trialDir = `${trialsDir}/${basename(TIMED_OUT_TRIAL)}`;
      rewriteJson(join(jobs, TIMED_OUT_TRIAL, "config.json"), (config) => {
        config["trials_dir"] = trialsDir;
      });
      rewriteJson(join(jobs, TIMED_OUT_TRIAL, "result.json"), (result) => {
        result["trial_uri"] = `file://${trialDir}`;
        result["config"].trials_dir = trialsDir;
        result["exception_info"].exception_message = `[Errno 2] No such file or directory: '${trialDir}/agent/trajectory.json'`;
      });
      const { imported } = await importJobs(jobs);
      expect(imported.ok).toBe(false);
      if (imported.ok) throw new Error("expected the import to be refused");
      expect(imported.error.code).toBe("validation");
      expect(imported.error.issues!.map((issue) => issue.path)).toEqual(["terminus-2/chess-best-move__gs92yNg/result.json"]);
      expect(imported.error.detail).toContain(
        "at exception_info.exception_message, names the jobs directory of the machine that ran Harbor",
      );
      expect(readDraftDocument(workspaceDir, "draft-1").state).toBe("locked");
    });

    test.each([
      ["on this machine", (jobs: string) => realpathSync(jobs)],
      ["on another machine", () => "/home/ci-runner/work/jobs"],
    ])("an ungradeable trial of a run Harbor was given an absolute -o %s imports, and its reward path is not published", async (_where, root) => {
      await lockedOfficialSlate();
      const jobs = jobsAsHarborWroteThem();
      const trial = join("oracle", "chess-best-move__5FuHvzp");
      const trialsDir = `${root(jobs)}/oracle`;
      const verifierDir = `${trialsDir}/chess-best-move__5FuHvzp/verifier`;
      // What Harbor 0.21.0 writes given `-o <absolute>` for a trial whose verifier wrote no reward
      // file: the absolute trials_dir in both records, and a RewardFileNotFoundError whose message
      // names the reward file paths under it (`harbor/verifier/verifier.py`).
      rewriteJson(join(jobs, trial, "config.json"), (config) => {
        config["trials_dir"] = trialsDir;
      });
      rewriteJson(join(jobs, trial, "result.json"), (result) => {
        result["config"].trials_dir = trialsDir;
        result["verifier_result"] = null;
        result["exception_info"] = {
          exception_type: "RewardFileNotFoundError",
          exception_message: `No reward file found at ${verifierDir}/reward.txt or ${verifierDir}/reward.json`,
          occurred_at: "2026-10-01T13:39:25.828481Z",
        };
      });
      rmSync(join(jobs, trial, "verifier", "reward.txt"));

      const { dump, imported } = await importJobs(jobs);
      expect(imported.ok, JSON.stringify(imported)).toBe(true);
      if (!imported.ok) return;
      expect(recordOf(dump, "oracle: chess-best-move #1")).toMatchObject({
        outcome: "ungradeable",
        reason: "RewardFileNotFoundError",
      });
      const carried = carriedFiles(dump, imported.result.declarationSha256);
      const carriedResult = new TextDecoder().decode(carried.get("oracle/chess-best-move__5FuHvzp/result.json")!);
      expect(JSON.parse(carriedResult).exception_info).toEqual({
        exception_type: "RewardFileNotFoundError",
        occurred_at: "2026-10-01T13:39:25.828481Z",
      });
      for (const bytes of carried.values()) expect(new TextDecoder().decode(bytes)).not.toContain(root(jobs));

      const collected = await runCollect(context("2026-10-01T14:05:00.000Z"), { draftId: "draft-1" });
      expect(collected.ok, JSON.stringify(collected)).toBe(true);
      const reported = await runReport(context("2026-10-01T14:10:00.000Z"), { draftId: "draft-1" });
      expect(reported.ok, JSON.stringify(reported)).toBe(true);
      if (!reported.ok) return;
      const bundle = materializePublicBundle({
        workspaceDir,
        draftId: "draft-1",
        benchmarkSha256: reported.result.claimPackage.records.benchmarkSha256,
        runState: readRunState(workspaceDir, "draft-1")!,
      });
      await expect(verifyPublicBundle(bundle.bundleDir)).resolves.toMatchObject({ identity: bundle.identity });
      const published = readdirSync(bundle.bundleDir, { recursive: true, withFileTypes: true })
        .filter((entry) => entry.isFile())
        .map((entry) => readFileSync(join(entry.parentPath, entry.name), "utf8"))
        .join("\n");
      expect(published).toContain("RewardFileNotFoundError");
      expect(published).not.toContain(root(jobs));
    });
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
