/** Post-collect suite completeness: Matrix cells + ATIF bytes on the retained Harbor job. */
import { cellKey } from "@jinn-network/benchmarking-records";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { SuiteProtocolSelection } from "./manifest.js";

const ACCOUNTED_OUTCOMES = new Set(["judged", "unscorable"]);

export interface MatrixCellAccount {
  readonly cellKey: string;
  readonly taskDigest: string;
  readonly armId: string;
  readonly replicate: number;
  readonly outcome: string;
}

function trialTaskName(trial: Readonly<Record<string, unknown>>): string {
  const task = trial.task;
  if (typeof task === "object" && task !== null && "name" in task && typeof task.name === "string") return task.name;
  if (typeof trial.task_name === "string") return trial.task_name;
  return "";
}

function trialAttempt(trial: Readonly<Record<string, unknown>>): number {
  const value = trial.attempt_number ?? trial.attempt;
  return typeof value === "number" && Number.isInteger(value) && value >= 1 ? value : 1;
}

function listFiles(root: string, current = ""): readonly string[] {
  const directory = join(root, current);
  let entries;
  try { entries = readdirSync(directory, { withFileTypes: true }); }
  catch { return []; }
  const files: string[] = [];
  for (const entry of entries) {
    const relative = current === "" ? entry.name : `${current}/${entry.name}`;
    if (entry.isDirectory()) files.push(...listFiles(root, relative));
    else if (entry.isFile()) files.push(relative);
  }
  return files;
}

function trialHasAtif(trialDir: string): boolean {
  return listFiles(trialDir).some((relative) => (
    relative === "agent/recording.cast" || /trajectory|atif/iu.test(relative)
  ));
}

function trialHasRewardJson(trialDir: string): boolean {
  return existsSync(join(trialDir, "verifier", "reward.json")) || existsSync(join(trialDir, "reward.json"));
}

function uniqueTrialDir(jobDir: string, taskName: string, attempt: number): string | undefined {
  let entries;
  try { entries = readdirSync(jobDir, { withFileTypes: true }); }
  catch { return undefined; }
  const matched: string[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const configPath = join(jobDir, entry.name, "config.json");
    if (!existsSync(configPath)) continue;
    let trial: Record<string, unknown>;
    try {
      trial = JSON.parse(new TextDecoder("utf8", { fatal: true }).decode(readFileSync(configPath))) as Record<string, unknown>;
    } catch {
      continue;
    }
    if (trialAttempt(trial) === attempt && trialTaskName(trial) === taskName) matched.push(join(jobDir, entry.name));
  }
  return matched.length === 1 ? matched[0] : undefined;
}

export function accountSuiteArmCells(
  matrix: { readonly cells: readonly MatrixCellAccount[] },
  suite: SuiteProtocolSelection,
  armId: string,
): boolean {
  if (suite.items.length === 0) return false;
  const byKey = new Map(matrix.cells.map((cell) => [cell.cellKey, cell]));
  for (const item of suite.items) {
    for (let replicate = 1; replicate <= suite.replicates; replicate += 1) {
      const cell = byKey.get(cellKey(item.taskSha256, armId, replicate));
      if (cell === undefined || !ACCOUNTED_OUTCOMES.has(cell.outcome)) return false;
    }
  }
  return true;
}

export function atifOnRetainedJob(
  jobDir: string,
  suite: SuiteProtocolSelection,
  matrix: { readonly cells: readonly MatrixCellAccount[] },
  armId: string,
): boolean {
  const byKey = new Map(matrix.cells.map((cell) => [cell.cellKey, cell]));
  for (const item of suite.items) {
    for (let replicate = 1; replicate <= suite.replicates; replicate += 1) {
      const cell = byKey.get(cellKey(item.taskSha256, armId, replicate));
      if (cell === undefined || cell.outcome !== "judged") continue;
      const trialDir = uniqueTrialDir(jobDir, item.taskName, replicate);
      if (trialDir === undefined || !trialHasAtif(trialDir)) return false;
    }
  }
  return true;
}

export function rewardJsonOnRetainedJob(
  jobDir: string,
  suite: SuiteProtocolSelection,
  matrix: { readonly cells: readonly MatrixCellAccount[] },
  armId: string,
): boolean {
  const byKey = new Map(matrix.cells.map((cell) => [cell.cellKey, cell]));
  for (const item of suite.items) {
    for (let replicate = 1; replicate <= suite.replicates; replicate += 1) {
      const cell = byKey.get(cellKey(item.taskSha256, armId, replicate));
      if (cell === undefined || cell.outcome !== "judged") continue;
      const trialDir = uniqueTrialDir(jobDir, item.taskName, replicate);
      if (trialDir === undefined || !trialHasRewardJson(trialDir)) return false;
    }
  }
  return true;
}

export interface ArmRunComplete {
  readonly cellsAccounted: boolean;
  readonly atifOnRetainedJob: boolean;
  readonly rewardOnRetainedJob: boolean;
}

export function assessArmRunComplete(input: {
  readonly matrix: { readonly cells: readonly MatrixCellAccount[] };
  readonly suite: SuiteProtocolSelection;
  readonly armId: string;
  readonly jobDir: string;
}): ArmRunComplete {
  const cellsAccounted = accountSuiteArmCells(input.matrix, input.suite, input.armId);
  if (!cellsAccounted) return { cellsAccounted: false, atifOnRetainedJob: false, rewardOnRetainedJob: false };
  return {
    cellsAccounted: true,
    atifOnRetainedJob: atifOnRetainedJob(input.jobDir, input.suite, input.matrix, input.armId),
    rewardOnRetainedJob: input.suite.protocol === "deep-swe-v1.1"
      ? rewardJsonOnRetainedJob(input.jobDir, input.suite, input.matrix, input.armId)
      : true,
  };
}

export function allArmsRunComplete(
  arms: readonly ArmRunComplete[],
): { readonly cellsAccounted: boolean; readonly atifOnRetainedJob: boolean; readonly rewardOnRetainedJob: boolean } {
  if (arms.length === 0) return { cellsAccounted: false, atifOnRetainedJob: false, rewardOnRetainedJob: false };
  return {
    cellsAccounted: arms.every((arm) => arm.cellsAccounted),
    atifOnRetainedJob: arms.every((arm) => arm.atifOnRetainedJob),
    rewardOnRetainedJob: arms.every((arm) => arm.rewardOnRetainedJob),
  };
}
