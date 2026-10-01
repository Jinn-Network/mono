// SPDX-License-Identifier: Apache-2.0

/**
 * Harbor 0.21 jobs/trials reader for `run import --from harbor` (#3991).
 *
 * This is a named harness reader, not a second interpretation of Harbor output. Trial identity
 * (task name, attempt) is the same mapping the orchestrated path already uses:
 * `harborTrialTaskName` / `assignHarborTrialAttempt` (Harbor 0.21 omits `attempt_number`) and
 * `taskNameByDigestFromSuite` / `digestByTaskNameFromSuite` from `from-harbor.ts`. Outcomes are
 * the closed import vocabulary. One finished trial becomes one per-attempt record; timings and
 * evidence paths are carried. Missing expected slots are written as `unrun` with a reason so the
 * denominator does not shrink. Extra or duplicate trials are left for the sealed-slate validator
 * (#2979) to refuse.
 *
 * On a draft bound by `method terminal-bench-2.1` the task names are the ones the official slate
 * seals, and a name is not enough to place a trial (#4937): the trial must carry the package ref
 * the Task seals, and its job must not name another dataset revision. The agent is resolved per
 * trial, because Harbor 0.21 leaves its default agent out of the job `config.json`.
 */

import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { basename, join, relative as relativePath, sep } from "node:path";
import {
  cellKey,
  expectedCellSet,
  itemTaskDigest,
  parseBenchmark,
  parseRun,
  type CellCoord,
} from "@jinn-network/benchmarking-records";
import type { DraftDocument } from "../domain/draft.js";
import { refuse } from "../errors.js";
import { readDraftDocument } from "../operations/drafts.js";
import {
  assignHarborTrialAttempt,
  harborTrialTaskName,
  HarborSelectionManifestSchema,
  isHarborCompatibleEvaluationRuntime,
  type HarborSelectionManifest,
} from "../runtime/harbor/manifest.js";
import { harborTrialExceptionType } from "../runtime/harbor/retry-bind.js";
import { harborTrialResultTerminal } from "../runtime/harbor/launcher.js";
import {
  digestByTaskNameFromSuite,
  suiteSelectionFromHarbor,
  taskNameByDigestFromSuite,
} from "../runtime/suite-protocol/from-harbor.js";
import type { ExternalRunImportSource } from "../run/external-import.js";
import { requireRunState } from "../run/state.js";
import { getSealedBytes } from "../workspace/sealed-store.js";
import type { ExternalRunEvidenceRef, ExternalRunRecord } from "./external-run-records.js";
import { TERMINAL_BENCH_21_ITEM_PROFILE_URI } from "./terminal-bench-2-1.js";

export interface HarborImportArm {
  readonly armId: string;
  readonly agentName?: string;
  readonly modelName?: string;
}

/** What the official Terminal-Bench 2.1 slate seals about one task (`sealOfficialItem`). */
export interface HarborOfficialTaskPin {
  readonly datasetId: string;
  readonly datasetRevision: string;
  readonly packageRef: string;
}

export interface ReadHarborRunRecordsInput {
  readonly jobsDir: string;
  /** Suite protocol `taskName → taskSha256`. Prefer `digestByTaskNameFromSuite`. */
  readonly digestByTaskName: Readonly<Record<string, string>>;
  readonly arms: readonly HarborImportArm[];
  readonly expected: readonly CellCoord[];
  /**
   * Official-slate pins by task digest. A trial that lands on a pinned task must carry the sealed
   * package ref, and its job must not name another dataset revision.
   */
  readonly officialPins?: Readonly<Record<string, HarborOfficialTaskPin>>;
}

export interface HarborRunImportDump {
  readonly records: readonly ExternalRunRecord[];
  readonly source: ExternalRunImportSource;
  readonly evidenceRoot: string;
}

const UTF8 = new TextDecoder("utf8", { fatal: true });
const SHIM_MARKET_PREFIX = "terminal-bench-2-1/";
const EXTRA_ARM = "extra";

function readJsonObject(path: string): Record<string, unknown> | undefined {
  try {
    const parsed: unknown = JSON.parse(UTF8.decode(readFileSync(path)));
    if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    return undefined;
  }
  return undefined;
}

function childDirectories(root: string): readonly string[] {
  try {
    return readdirSync(root, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && !entry.name.startsWith("."))
      .map((entry) => entry.name)
      .sort((left, right) => left.localeCompare(right));
  } catch {
    return [];
  }
}

function isHarborTrialConfig(config: Record<string, unknown> | undefined): config is Record<string, unknown> {
  return config !== undefined && harborTrialTaskName(config).length > 0;
}

function trialDirectoryNames(jobDir: string): readonly string[] {
  return childDirectories(jobDir).filter((name) =>
    isHarborTrialConfig(readJsonObject(join(jobDir, name, "config.json"))),
  );
}

function isHarborJobRoot(dir: string): boolean {
  return trialDirectoryNames(dir).length > 0;
}

function harborJobRoots(jobsDir: string): readonly string[] {
  if (!existsSync(jobsDir) || !statSync(jobsDir).isDirectory()) {
    refuse("validation", "jobs-dir", `Harbor jobs directory ${jobsDir} does not exist`);
  }
  if (isHarborJobRoot(jobsDir)) return [jobsDir];
  const nested = childDirectories(jobsDir)
    .map((name) => join(jobsDir, name))
    .filter((dir) => isHarborJobRoot(dir));
  return nested;
}

interface HarborAgent {
  readonly name?: string;
  readonly modelName?: string;
}

function harborAgent(value: unknown): HarborAgent | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const record = value as Record<string, unknown>;
  const agent = {
    ...(typeof record["name"] === "string" ? { name: record["name"] } : {}),
    ...(typeof record["model_name"] === "string" ? { modelName: record["model_name"] } : {}),
  };
  return agent.name === undefined && agent.modelName === undefined ? undefined : agent;
}

/** The job `config.json` agent speaks for a trial only when the job names exactly one. */
function jobAgent(config: Record<string, unknown> | undefined): HarborAgent | undefined {
  const agents = config?.["agents"];
  return Array.isArray(agents) && agents.length === 1 ? harborAgent(agents[0]) : undefined;
}

/** The job `lock.json` lists each planned trial with its agent, keyed by task and not by trial. */
function lockAgent(lock: Record<string, unknown> | undefined, taskName: string): HarborAgent | undefined {
  const trials = lock?.["trials"];
  if (!Array.isArray(trials)) return undefined;
  const agents = new Map<string, HarborAgent>();
  for (const entry of trials) {
    if (typeof entry !== "object" || entry === null) continue;
    const planned = entry as Record<string, unknown>;
    if (harborTrialTaskName(planned) !== taskName) continue;
    const agent = harborAgent(planned["agent"]);
    if (agent !== undefined) agents.set(JSON.stringify([agent.name, agent.modelName]), agent);
  }
  return agents.size === 1 ? [...agents.values()][0] : undefined;
}

/**
 * The agent that ran one trial. Harbor 0.21 omits defaults from what it saves, so a job run with
 * the default agent has no `agents` in its `config.json` and no `agent` in a trial `config.json`.
 * The trial `result.json` echoes the full trial config, and the job `lock.json` lists the agent
 * of every planned trial, so those are read before the job-level agent.
 */
function trialAgent(input: {
  readonly trial: Record<string, unknown>;
  readonly result: Record<string, unknown> | undefined;
  readonly lock: Record<string, unknown> | undefined;
  readonly jobConfig: Record<string, unknown> | undefined;
  readonly taskName: string;
}): HarborAgent {
  const echoed = input.result?.["config"];
  return (typeof echoed === "object" && echoed !== null
    ? harborAgent((echoed as Record<string, unknown>)["agent"])
    : undefined)
    ?? harborAgent(input.trial["agent"])
    ?? lockAgent(input.lock, input.taskName)
    ?? jobAgent(input.jobConfig)
    ?? {};
}

function resolveArmId(
  agent: HarborAgent,
  arms: readonly HarborImportArm[],
  where: string,
): string {
  if (arms.length === 1) return arms[0]!.armId;
  const matched = arms.filter((arm) => {
    if (agent.name !== undefined && arm.agentName !== undefined && agent.name !== arm.agentName) return false;
    if (agent.modelName !== undefined && arm.modelName !== undefined && agent.modelName !== arm.modelName) {
      return false;
    }
    if (agent.name !== undefined && arm.agentName === undefined && agent.name !== arm.armId) return false;
    return arm.agentName !== undefined || agent.name === arm.armId || agent.name === undefined;
  });
  if (matched.length === 1) return matched[0]!.armId;
  if (agent.name !== undefined) {
    const byId = arms.filter((arm) => arm.armId === agent.name);
    if (byId.length === 1) return byId[0]!.armId;
  }
  const who = agent.name === undefined
    ? "An unnamed Harbor agent"
    : `Harbor agent "${agent.name}"${agent.modelName === undefined ? "" : ` with model "${agent.modelName}"`}`;
  refuse(
    "validation",
    "harbor-arm",
    `${who} in trial ${where} does not match exactly one locked arm (locked arms: `
      + `${arms.map((arm) => arm.armId).join(", ")}). A trial is placed on the arm whose id is the `
      + "Harbor agent name, or whose pinning carries agent.id and model.id equal to the Harbor "
      + "agent name and model_name.",
  );
}

function trialTaskField(trial: Record<string, unknown>, field: string): string | undefined {
  const task = trial["task"];
  if (typeof task !== "object" || task === null) return undefined;
  const value = (task as Record<string, unknown>)[field];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

/**
 * A trial placed on an official-slate task must be a trial of that task, not of one that shares
 * its name. The sealed Task names the dataset revision and the task's package ref; Harbor records
 * the dataset ref on the job and the package ref on the trial. A mismatch is refused with both
 * values. A job that records no dataset ref is accepted: the package ref still binds each trial.
 */
function assertOfficialTaskPin(input: {
  readonly pin: HarborOfficialTaskPin;
  readonly trial: Record<string, unknown>;
  readonly jobConfig: Record<string, unknown> | undefined;
  readonly jobName: string;
  readonly where: string;
  readonly taskName: string;
}): void {
  const { pin, trial, jobConfig, jobName, where } = input;
  const rerun = `Run Harbor against the sealed revision (harbor run -d '${pin.datasetId}@${pin.datasetRevision}') `
    + "and import that jobs directory.";
  const source = trialTaskField(trial, "source");
  const datasets = jobConfig?.["datasets"];
  for (const entry of Array.isArray(datasets) ? datasets : []) {
    if (typeof entry !== "object" || entry === null) continue;
    const dataset = entry as Record<string, unknown>;
    if (source !== undefined && typeof dataset["name"] === "string" && dataset["name"] !== source) continue;
    const ref = dataset["ref"];
    if (typeof ref !== "string" || ref.length === 0 || ref === pin.datasetRevision) continue;
    refuse(
      "validation",
      "harbor-dataset-ref",
      `Harbor job ${jobName} ran dataset ${typeof dataset["name"] === "string" ? dataset["name"] : "(unnamed)"} at ${ref}, `
        + `but the locked slate seals ${pin.datasetId} at ${pin.datasetRevision}. ${rerun}`,
    );
  }
  const name = trialTaskField(trial, "name") ?? input.taskName;
  const ref = trialTaskField(trial, "ref");
  if (ref === undefined) {
    refuse(
      "validation",
      "harbor-task-ref",
      `Harbor trial ${where} records no package ref for task ${name}, and the locked slate seals `
        + `${pin.packageRef} for it: a task name alone does not say which task ran. ${rerun}`,
    );
  }
  if (ref !== pin.packageRef) {
    refuse(
      "validation",
      "harbor-task-ref",
      `Harbor trial ${where} ran task ${name} at package ref ${ref}, but the locked slate seals `
        + `${pin.packageRef} for that task. ${rerun}`,
    );
  }
}

function extraCellKey(taskName: string, attempt: number): string {
  const digest = createHash("sha256").update(`harbor-extra:${taskName}`).digest("hex");
  const replicate = Number.isInteger(attempt) && attempt >= 1 ? attempt : 1;
  return cellKey(digest, EXTRA_ARM, replicate);
}

function relativeEvidencePath(jobsDir: string, absolute: string): string {
  return relativePath(jobsDir, absolute).split(sep).join("/");
}

function evidenceIfPresent(jobsDir: string, absolute: string, name: string): ExternalRunEvidenceRef | undefined {
  if (!existsSync(absolute) || !statSync(absolute).isFile()) return undefined;
  return { name, path: relativeEvidencePath(jobsDir, absolute) };
}

function trialEvidence(jobsDir: string, trialDir: string): readonly ExternalRunEvidenceRef[] {
  const refs = [
    evidenceIfPresent(jobsDir, join(trialDir, "result.json"), "trial-result.json"),
    evidenceIfPresent(jobsDir, join(trialDir, "config.json"), "trial-config.json"),
    evidenceIfPresent(jobsDir, join(trialDir, "verifier", "reward.txt"), "reward.txt"),
    evidenceIfPresent(jobsDir, join(trialDir, "verifier", "reward.json"), "reward.json"),
    evidenceIfPresent(jobsDir, join(trialDir, "reward.json"), "reward-root.json"),
    evidenceIfPresent(jobsDir, join(trialDir, "artifacts", "prediction.json"), "prediction.json"),
    evidenceIfPresent(jobsDir, join(trialDir, "agent", "recording.cast"), "recording.cast"),
    evidenceIfPresent(jobsDir, join(trialDir, "agent", "trajectory.json"), "trajectory.json"),
  ].filter((ref): ref is ExternalRunEvidenceRef => ref !== undefined);
  return refs;
}

function hasExecutionEvidence(evidence: readonly ExternalRunEvidenceRef[]): boolean {
  return evidence.some((ref) => ref.name === "reward.txt" || ref.name === "reward.json" || ref.name === "prediction.json");
}

function optionalRfc3339(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function durationMs(startedAt: string | undefined, endedAt: string | undefined): number | undefined {
  if (startedAt === undefined || endedAt === undefined) return undefined;
  const start = Date.parse(startedAt);
  const end = Date.parse(endedAt);
  if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) return undefined;
  return Math.round(end - start);
}

function harborTrialRecordShape(
  result: Record<string, unknown> | undefined,
  evidence: readonly ExternalRunEvidenceRef[],
): { readonly outcome: string; readonly reason?: string } {
  if (result === undefined || !harborTrialResultTerminal(result)) {
    return { outcome: "unrun", reason: "Harbor trial is not finished" };
  }
  const exception = harborTrialExceptionType(result);
  if (exception === "AgentTimeoutError" || exception === "VerifierTimeoutError") {
    return { outcome: "timeout", reason: exception };
  }
  if (
    exception === "RewardFileNotFoundError"
    || exception === "RewardFileEmptyError"
    || exception === "VerifierOutputParseError"
  ) {
    return { outcome: "ungradeable", reason: exception };
  }
  if (result.status === "error" || result.status === "failed" || exception !== undefined) {
    return {
      outcome: "error",
      reason: exception ?? `Harbor trial status ${String(result.status)}`,
    };
  }
  if (!hasExecutionEvidence(evidence)) {
    return { outcome: "error", reason: "Harbor trial finished without verifier reward or prediction artifact" };
  }
  return {
    outcome: "ungradeable",
    reason: "Harbor verifier produced execution evidence; the sealed EvaluationSpec was not applied",
  };
}

function withTimings(
  record: ExternalRunRecord,
  result: Record<string, unknown> | undefined,
): ExternalRunRecord {
  const startedAt = optionalRfc3339(result?.["started_at"] ?? result?.["startedAt"]);
  const endedAt = optionalRfc3339(result?.["finished_at"] ?? result?.["ended_at"] ?? result?.["finishedAt"]);
  const duration = durationMs(startedAt, endedAt);
  return {
    ...record,
    ...(startedAt === undefined ? {} : { startedAt }),
    ...(endedAt === undefined ? {} : { endedAt }),
    ...(duration === undefined ? {} : { durationMs: duration }),
  };
}

/**
 * Reads Harbor 0.21 job and trial directories into the #2979 per-attempt record shape.
 * Missing expected slots are emitted as `unrun` with a required reason.
 */
export function readHarborRunRecords(input: ReadHarborRunRecordsInput): ExternalRunRecord[] {
  const { jobsDir, digestByTaskName, arms, expected, officialPins } = input;
  if (arms.length === 0) refuse("validation", "harbor-arm", "Harbor import requires at least one locked arm");
  const nextAttemptByArmTask = new Map<string, Map<string, number>>();
  const directoryAttempt = new Map<string, number>();
  const records: ExternalRunRecord[] = [];
  let row = 0;

  for (const jobRoot of harborJobRoots(jobsDir)) {
    const jobConfig = readJsonObject(join(jobRoot, "config.json"));
    const jobLock = readJsonObject(join(jobRoot, "lock.json"));
    const jobName = typeof jobConfig?.["job_name"] === "string" ? jobConfig["job_name"] : basename(jobRoot);
    for (const directory of trialDirectoryNames(jobRoot)) {
      const trialDir = join(jobRoot, directory);
      const where = relativeEvidencePath(jobsDir, trialDir);
      const trial = readJsonObject(join(trialDir, "config.json"));
      if (!isHarborTrialConfig(trial)) {
        refuse("validation", trialDir, `Harbor trial config at ${join(trialDir, "config.json")} is missing or not a JSON object`);
      }
      const result = readJsonObject(join(trialDir, "result.json"));
      const armId = resolveArmId(
        trialAgent({ trial, result, lock: jobLock, jobConfig, taskName: harborTrialTaskName(trial) }),
        arms,
        where,
      );
      let nextAttemptByTask = nextAttemptByArmTask.get(armId);
      if (nextAttemptByTask === undefined) {
        nextAttemptByTask = new Map<string, number>();
        nextAttemptByArmTask.set(armId, nextAttemptByTask);
      }
      const assigned = assignHarborTrialAttempt({
        trial,
        directory: `${jobRoot}\u0000${directory}`,
        nextAttemptByTask,
        directoryAttempt,
      });
      if (assigned === undefined) {
        refuse("validation", trialDir, `Harbor trial at ${trialDir} has no task name`);
      }
      const digest = digestByTaskName[assigned.taskName];
      const pin = digest === undefined ? undefined : officialPins?.[digest];
      if (pin !== undefined) {
        assertOfficialTaskPin({ pin, trial, jobConfig, jobName, where, taskName: assigned.taskName });
      }
      const mappedKey = digest === undefined
        ? extraCellKey(assigned.taskName, assigned.attempt)
        : cellKey(digest, armId, assigned.attempt);
      const evidence = trialEvidence(jobsDir, trialDir);
      const shape = harborTrialRecordShape(result, evidence);
      row += 1;
      const carriesEvidence = shape.outcome === "graded" || shape.outcome === "ungradeable";
      records.push(withTimings({
        row,
        cellKey: mappedKey,
        outcome: shape.outcome,
        ...(shape.reason === undefined ? {} : { reason: shape.reason }),
        ...(carriesEvidence && evidence.length > 0 ? { evidence } : {}),
      }, result));
    }
  }

  const claimed = new Set(records.map((record) => record.cellKey));
  for (const coord of expected) {
    if (claimed.has(coord.cellKey)) continue;
    row += 1;
    records.push({
      row,
      cellKey: coord.cellKey,
      outcome: "unrun",
      reason: "Harbor jobs directory contained no trial for this slot",
    });
  }
  return records;
}

function pinningId(pinning: Readonly<Record<string, unknown>>, key: string): string | undefined {
  const value = pinning[key];
  if (typeof value === "object" && value !== null && "id" in value && typeof (value as { id: unknown }).id === "string") {
    return (value as { id: string }).id;
  }
  return undefined;
}

function armsFromHarborManifest(manifest: HarborSelectionManifest): HarborImportArm[] {
  return manifest.arms.map((arm) => ({
    armId: arm.armId,
    agentName: arm.jobAgent.name,
    modelName: arm.jobAgent.model_name,
  }));
}

function armsFromDraft(document: DraftDocument): HarborImportArm[] {
  return document.spec.arms.map((arm) => ({
    armId: arm.armId,
    ...(pinningId(arm.pinning, "agent") === undefined ? {} : { agentName: pinningId(arm.pinning, "agent") }),
    ...(pinningId(arm.pinning, "model") === undefined ? {} : { modelName: pinningId(arm.pinning, "model") }),
  }));
}

function marketIdTaskName(task: Record<string, unknown>): string | undefined {
  const payload = task["payload"];
  if (typeof payload !== "object" || payload === null) return undefined;
  const forecast = (payload as Record<string, unknown>)["forecast"];
  if (typeof forecast !== "object" || forecast === null) return undefined;
  const marketId = (forecast as Record<string, unknown>)["marketId"];
  if (typeof marketId !== "string" || marketId.length === 0) return undefined;
  if (marketId.startsWith(SHIM_MARKET_PREFIX)) {
    const name = marketId.slice(SHIM_MARKET_PREFIX.length);
    return name.length > 0 ? name : undefined;
  }
  return marketId;
}

/** The task name and pins an official Terminal-Bench 2.1 item seals in its payload. */
function officialSlateTask(
  task: Record<string, unknown>,
): { readonly taskName: string; readonly pin: HarborOfficialTaskPin } | undefined {
  const profile = task["profile"];
  if (typeof profile !== "object" || profile === null) return undefined;
  if ((profile as Record<string, unknown>)["uri"] !== TERMINAL_BENCH_21_ITEM_PROFILE_URI) return undefined;
  const payload = task["payload"];
  if (typeof payload !== "object" || payload === null) return undefined;
  const { taskName, packageRef, datasetId, datasetRevision } = payload as Record<string, unknown>;
  if (
    typeof taskName !== "string" || taskName.length === 0
    || typeof packageRef !== "string" || typeof datasetId !== "string" || typeof datasetRevision !== "string"
  ) return undefined;
  return { taskName, pin: { datasetId, datasetRevision, packageRef } };
}

interface HarborImportSlate {
  readonly taskNameByDigest: Readonly<Record<string, string>>;
  readonly officialPins: Readonly<Record<string, HarborOfficialTaskPin>>;
}

/**
 * Task names for a locked run. Prefers the suite-protocol mapping already used by the
 * orchestrated Harbor path (`from-harbor.ts`). Otherwise the names come from the sealed Tasks:
 * the official Terminal-Bench 2.1 slate (`method terminal-bench-2.1`) seals `payload.taskName`,
 * which is Harbor's `terminal-bench/<taskName>`, beside the package ref and dataset revision a
 * trial is then held to. Prediction-shaped intake encodes the name in `payload.forecast.marketId`.
 */
function harborImportSlate(workspaceDir: string, document: DraftDocument): HarborImportSlate {
  const runtime = document.spec.evaluationRuntime;
  if (isHarborCompatibleEvaluationRuntime(runtime)) {
    const manifest = HarborSelectionManifestSchema.parse(
      JSON.parse(UTF8.decode(getSealedBytes(workspaceDir, runtime.selectionManifestSha256))),
    );
    const suite = suiteSelectionFromHarbor(manifest);
    if (suite !== undefined) return { taskNameByDigest: taskNameByDigestFromSuite(suite), officialPins: {} };
  }
  if (document.spec.taskSet.kind !== "benchmark") {
    refuse("conflict", `drafts.${document.draftId}.taskSet`, `draft ${document.draftId} has no attached benchmark`);
  }
  const benchmark = parseBenchmark(getSealedBytes(workspaceDir, document.spec.taskSet.benchmarkSha256));
  const names: Record<string, string> = {};
  const pins: Record<string, HarborOfficialTaskPin> = {};
  for (const item of benchmark.items) {
    const digest = itemTaskDigest(item);
    const task = JSON.parse(UTF8.decode(getSealedBytes(workspaceDir, digest))) as Record<string, unknown>;
    const official = officialSlateTask(task);
    if (official !== undefined) {
      names[digest] = official.taskName;
      pins[digest] = official.pin;
      continue;
    }
    const name = marketIdTaskName(task);
    if (name !== undefined) names[digest] = name;
  }
  const named = Object.keys(names).length;
  if (named !== benchmark.items.length) {
    refuse(
      "conflict",
      `drafts.${document.draftId}.harbor`,
      `Harbor import cannot name ${benchmark.items.length - named} of the ${benchmark.items.length} tasks `
        + `on draft ${document.draftId}, so it cannot tell which Harbor trial belongs to which cell. `
        + "`run import --from harbor` reads a draft bound with `method terminal-bench-2.1`, whose tasks "
        + "seal their Harbor task names. Bind a draft that way before running Harbor, or bring this run "
        + "as a generic dump with `run import --file <records.jsonl> --source harbor` "
        + "(`run import --template` prints the slate to fill in).",
    );
  }
  return { taskNameByDigest: names, officialPins: pins };
}

export function taskNameByDigestForHarborImport(
  workspaceDir: string,
  document: DraftDocument,
): Readonly<Record<string, string>> {
  return harborImportSlate(workspaceDir, document).taskNameByDigest;
}

export function harborImportArmsForDraft(workspaceDir: string, document: DraftDocument): HarborImportArm[] {
  const runtime = document.spec.evaluationRuntime;
  if (isHarborCompatibleEvaluationRuntime(runtime)) {
    const manifest = HarborSelectionManifestSchema.parse(
      JSON.parse(UTF8.decode(getSealedBytes(workspaceDir, runtime.selectionManifestSha256))),
    );
    return armsFromHarborManifest(manifest);
  }
  return armsFromDraft(document);
}

/** Harbor records its own version in the job `lock.json`; the job `config.json` does not carry it. */
function harborVersionFromJobs(jobsDir: string): string {
  for (const jobRoot of harborJobRoots(jobsDir)) {
    const harbor = readJsonObject(join(jobRoot, "lock.json"))?.["harbor"];
    if (typeof harbor === "object" && harbor !== null) {
      const locked = (harbor as Record<string, unknown>)["version"];
      if (typeof locked === "string" && locked.length > 0) return locked;
    }
    const config = readJsonObject(join(jobRoot, "config.json"));
    const version = config?.["harbor_version"] ?? config?.["harborVersion"];
    if (typeof version === "string" && version.length > 0) return version;
  }
  return "0.21";
}

/** Loads the locked slate and reads a Harbor 0.21 jobs directory into import records. */
export function readHarborRunImport(input: {
  readonly workspaceDir: string;
  readonly draftId: string;
  readonly jobsDir: string;
}): HarborRunImportDump {
  const { workspaceDir, draftId, jobsDir } = input;
  const document = readDraftDocument(workspaceDir, draftId);
  if (document.spec.taskSet.kind !== "benchmark") {
    refuse("conflict", `drafts.${draftId}.taskSet`, `draft ${draftId} has no attached benchmark`);
  }
  const runState = requireRunState(workspaceDir, draftId);
  if (runState.runSha256 === undefined) {
    refuse("conflict", `runs.${draftId}`, `draft ${draftId} has no sealed Run record yet — lock it first`);
  }
  const benchmark = parseBenchmark(getSealedBytes(workspaceDir, document.spec.taskSet.benchmarkSha256));
  const run = parseRun(getSealedBytes(workspaceDir, runState.runSha256));
  const expected = expectedCellSet(benchmark, run);
  const { taskNameByDigest, officialPins } = harborImportSlate(workspaceDir, document);
  const digestByTaskName: Record<string, string> = {};
  for (const [digest, name] of Object.entries(taskNameByDigest)) digestByTaskName[name] = digest;
  // Keep the from-harbor inverse in the same path the orchestrated adapter uses when a suite is present.
  const runtime = document.spec.evaluationRuntime;
  if (isHarborCompatibleEvaluationRuntime(runtime)) {
    const manifest = HarborSelectionManifestSchema.parse(
      JSON.parse(UTF8.decode(getSealedBytes(workspaceDir, runtime.selectionManifestSha256))),
    );
    const suite = suiteSelectionFromHarbor(manifest);
    if (suite !== undefined) {
      Object.assign(digestByTaskName, digestByTaskNameFromSuite(suite));
    }
  }
  return {
    records: readHarborRunRecords({
      jobsDir,
      digestByTaskName,
      arms: harborImportArmsForDraft(workspaceDir, document),
      expected,
      officialPins,
    }),
    source: { harness: "harbor", version: harborVersionFromJobs(jobsDir) },
    evidenceRoot: jobsDir,
  };
}
