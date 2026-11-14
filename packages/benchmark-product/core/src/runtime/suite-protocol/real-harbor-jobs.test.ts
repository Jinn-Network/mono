// SPDX-License-Identifier: Apache-2.0

/**
 * The suite flag on the real Harbor 0.21.0 jobs directories (#5245).
 *
 * `leaderboardSubmitReady` for Terminal-Bench 2.1 and 3.0 and DeepSWE v1.1 finds each judged cell's
 * trial in the arm's retained job by its task name and attempt. Harbor 0.21.0 names a task with its
 * dataset prefix (`terminal-bench/<name>`) and numbers no attempt, so unless the flag places a trial
 * the way `run import --from harbor` places it, no judged cell finds its trial and the flag is never
 * true. The records are the committed ones under `test/fixtures/harbor-0.21-jobs-terminal-bench-2-1`.
 */

import { cpSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, test } from "vitest";
import { harborTrialDirectory } from "@colophon-claims/check";
import { cellKey } from "@jinn-network/benchmarking-records";
import { readHarborRunRecords, type HarborOfficialTaskPin } from "../../intake/harbor-run-records.js";
import { TERMINAL_BENCH_21_OFFICIAL_TASKS } from "../../intake/terminal-bench-2-1-slate.js";
import { TERMINAL_BENCH_2_1_DATASET_ID, TERMINAL_BENCH_2_1_DATASET_REF } from "../terminal-bench-2-1/manifest.js";
import type { SuiteProtocolSelection } from "./manifest.js";
import { assessArmRunComplete, suiteEvidenceTreeFromDirectory } from "./run-complete.js";

const RECORDS = fileURLToPath(new URL("../../../test/fixtures/harbor-0.21-jobs-terminal-bench-2-1", import.meta.url));
const MODEL = "openrouter/deepseek/deepseek-v4.1-flash";
/** Each arm, and the job directory Harbor wrote its trials into. */
const ARMS = [
  { armId: "oracle", job: "oracle" },
  { armId: "deepseek-flash", job: "terminus-2", agentName: "terminus-2", modelName: MODEL },
] as const;
const REWARD = [{ name: "reward", type: "number", required: true }] as const;

const RECORD_SHAPES = [
  { record: "jobs", tasks: ["adaptive-rejection-sampler", "cancel-async-tasks", "chess-best-move"], replicates: 1 },
  { record: "jobs-two-attempts", tasks: ["adaptive-rejection-sampler", "cancel-async-tasks"], replicates: 2 },
  { record: "jobs-resumed", tasks: ["adaptive-rejection-sampler", "cancel-async-tasks", "circuit-fibsqrt"], replicates: 1 },
] as const;

const digestOf = (task: string): string => Buffer.from(task.padEnd(32, "-").slice(0, 32)).toString("hex");

/** The record imported with every task pinned and graded, so every trial carries its own files. */
function imported(shape: (typeof RECORD_SHAPES)[number]) {
  const digestByTaskName = Object.fromEntries(shape.tasks.map((task) => [task, digestOf(task)]));
  const officialPins: Record<string, HarborOfficialTaskPin> = Object.fromEntries(shape.tasks.map((task) => [digestOf(task), {
    datasetId: TERMINAL_BENCH_2_1_DATASET_ID,
    datasetRevision: TERMINAL_BENCH_2_1_DATASET_REF,
    packageRef: TERMINAL_BENCH_21_OFFICIAL_TASKS.find((official) => official.name === task)!.ref,
    measurements: REWARD,
  }]));
  const expected = ARMS.flatMap((arm) => shape.tasks.flatMap((task) => Array.from({ length: shape.replicates }, (_, index) => ({
    cellKey: cellKey(digestOf(task), arm.armId, index + 1),
    taskDigest: digestOf(task),
    armId: arm.armId,
    replicate: index + 1,
  }))));
  const jobsDir = join(RECORDS, shape.record);
  const records = readHarborRunRecords({
    jobsDir,
    digestByTaskName,
    arms: ARMS.map(({ job: _job, ...arm }) => arm),
    expected,
    officialPins,
  });
  const cells = new Map(ARMS.flatMap((arm) => shape.tasks.flatMap((task) => Array.from({ length: shape.replicates }, (_, index) => [
    cellKey(digestOf(task), arm.armId, index + 1),
    { arm, task, attempt: index + 1 },
  ] as const))));
  return { jobsDir, records, cells };
}

function trialDirectories(jobDir: string): string[] {
  return readdirSync(jobDir, { withFileTypes: true }).filter((entry) => entry.isDirectory()).map((entry) => entry.name);
}

describe("the suite flag places a real Harbor 0.21.0 trial as the Harbor import does (#5245)", () => {
  test.each(RECORD_SHAPES)("$record: each cell resolves to exactly one trial by its slate task name and attempt", (shape) => {
    const { jobsDir, records, cells } = imported(shape);
    let placed = 0;
    for (const record of records) {
      if (record.outcome === "unrun") continue;
      expect(record.outcome, record.cellKey).toBe("graded");
      // `<job>/<trial directory>/config.json`: where the import read this cell's trial.
      const [job, trialDirectory] = record.evidence!.find((file) => file.name === "trial-config.json")!.path.split("/");
      const cell = cells.get(record.cellKey)!;
      expect(job).toBe(cell.arm.job);
      const tree = suiteEvidenceTreeFromDirectory(join(jobsDir, job!));
      expect(harborTrialDirectory(tree, cell.task, cell.attempt), `${job} ${cell.task} #${cell.attempt}`).toBe(trialDirectory);
      placed += 1;
    }
    // Every trial directory the record holds is the trial of exactly one cell.
    const held = ARMS.flatMap((arm) => {
      try { return trialDirectories(join(jobsDir, arm.job)); } catch { return []; }
    });
    expect(placed).toBe(held.length);
  });

  describe("an arm's retained job with ATIF on every judged trial is ready", () => {
    let root: string | undefined;
    afterEach(() => {
      if (root !== undefined) rmSync(root, { recursive: true, force: true });
      root = undefined;
    });

    const shape = RECORD_SHAPES[1];
    // The record holds two attempts of each task, where the Terminal-Bench grammar seals five. The
    // run-complete half of the flag reads only the items and the replicate count.
    const suite = {
      schema: "jinn.network/benchmark-product/suite-protocol-selection/1",
      protocol: "terminal-bench-2.1",
      coverage: "full",
      datasetId: TERMINAL_BENCH_2_1_DATASET_ID,
      datasetRevision: TERMINAL_BENCH_2_1_DATASET_REF,
      selectedTaskNames: [...shape.tasks],
      datasetTaskCount: shape.tasks.length,
      replicates: shape.replicates,
      atifRequired: true,
      items: shape.tasks.map((taskName) => ({ taskName, taskSha256: digestOf(taskName) })),
    } as unknown as SuiteProtocolSelection;
    const judged = (armId: string) => ({
      cells: suite.items.flatMap((item) => [1, 2].map((replicate) => ({
        cellKey: cellKey(item.taskSha256, armId, replicate),
        taskDigest: item.taskSha256,
        armId,
        replicate,
        outcome: "judged",
      }))),
    });

    /** A copy of the two-attempt record with an ATIF trajectory in each trial directory but `without`. */
    function withAtif(without?: string): string {
      root = mkdtempSync(join(tmpdir(), "bp-real-harbor-jobs-"));
      cpSync(join(RECORDS, shape.record), root, { recursive: true });
      for (const arm of ARMS) {
        for (const directory of trialDirectories(join(root, arm.job))) {
          if (`${arm.job}/${directory}` === without) continue;
          mkdirSync(join(root, arm.job, directory, "agent"), { recursive: true });
          writeFileSync(join(root, arm.job, directory, "agent", "trajectory.json"), JSON.stringify({ schema_version: "ATIF-v1.4" }));
        }
      }
      return root;
    }

    test("every cell judged, every trial with ATIF", () => {
      const jobs = withAtif();
      for (const arm of ARMS) {
        expect(assessArmRunComplete({ matrix: judged(arm.armId), suite, armId: arm.armId, jobDir: join(jobs, arm.job) }), arm.armId)
          .toEqual({ cellsAccounted: true, atifOnRetainedJob: true, rewardOnRetainedJob: true });
      }
    });

    test("the trial the import numbers attempt 2 of a task has no ATIF, so that arm is not ready", () => {
      // `__EZiYZgD` sorts before `__eiRCBED` by code point, so the second is attempt 2.
      const jobs = withAtif("oracle/cancel-async-tasks__eiRCBED");
      expect(assessArmRunComplete({ matrix: judged("oracle"), suite, armId: "oracle", jobDir: join(jobs, "oracle") }).atifOnRetainedJob)
        .toBe(false);
      const secondUnscorable = {
        cells: judged("oracle").cells.map((cell) => cell.taskDigest === digestOf("cancel-async-tasks") && cell.replicate === 2
          ? { ...cell, outcome: "unscorable" }
          : cell),
      };
      expect(assessArmRunComplete({ matrix: secondUnscorable, suite, armId: "oracle", jobDir: join(jobs, "oracle") }).atifOnRetainedJob)
        .toBe(true);
    });
  });
});
