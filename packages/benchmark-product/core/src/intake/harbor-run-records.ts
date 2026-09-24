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
 */

import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative as relativePath, sep } from "node:path";
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

export interface HarborImportArm {
  readonly armId: string;
  readonly agentName?: string;
  readonly modelName?: string;
}

export interface ReadHarborRunRecordsInput {
  readonly jobsDir: string;
  /** Suite protocol `taskName → taskSha256`. Prefer `digestByTaskNameFromSuite`. */
  readonly digestByTaskName: Readonly<Record<string, string>>;
  readonly arms: readonly HarborImportArm[];
  readonly expected: readonly CellCoord[];
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

function jobAgent(config: Record<string, unknown> | undefined): { name?: string; modelName?: string } {
  const agents = config?.["agents"];
  if (!Array.isArray(agents) || agents.length === 0) return {};
  const agent = agents[0];
  if (typeof agent !== "object" || agent === null) return {};
  const record = agent as Record<string, unknown>;
  return {
    ...(typeof record["name"] === "string" ? { name: record["name"] } : {}),
    ...(typeof record["model_name"] === "string" ? { modelName: record["model_name"] } : {}),
  };
}

function resolveArmId(
  agent: { name?: string; modelName?: string },
  arms: readonly HarborImportArm[],
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
  refuse(
    "validation",
    "harbor-arm",
    "Harbor job agent does not match exactly one locked arm — name the arm on the Harbor AgentConfig",
  );
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
  const { jobsDir, digestByTaskName, arms, expected } = input;
  if (arms.length === 0) refuse("validation", "harbor-arm", "Harbor import requires at least one locked arm");
  const nextAttemptByArmTask = new Map<string, Map<string, number>>();
  const directoryAttempt = new Map<string, number>();
  const records: ExternalRunRecord[] = [];
  let row = 0;

  for (const jobRoot of harborJobRoots(jobsDir)) {
    const jobConfig = readJsonObject(join(jobRoot, "config.json"));
    const armId = resolveArmId(jobAgent(jobConfig), arms);
    let nextAttemptByTask = nextAttemptByArmTask.get(armId);
    if (nextAttemptByTask === undefined) {
      nextAttemptByTask = new Map<string, number>();
      nextAttemptByArmTask.set(armId, nextAttemptByTask);
    }
    for (const directory of trialDirectoryNames(jobRoot)) {
      const trialDir = join(jobRoot, directory);
      const trial = readJsonObject(join(trialDir, "config.json"));
      if (!isHarborTrialConfig(trial)) {
        refuse("validation", trialDir, `Harbor trial config at ${join(trialDir, "config.json")} is missing or not a JSON object`);
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
      const mappedKey = digest === undefined
        ? extraCellKey(assigned.taskName, assigned.attempt)
        : cellKey(digest, armId, assigned.attempt);
      const result = readJsonObject(join(trialDir, "result.json"));
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

/**
 * Task names for a locked run. Prefers the suite-protocol mapping already used by the
 * orchestrated Harbor path (`from-harbor.ts`). Until the official Terminal-Bench 2.1 pin
 * (#4678) lands, intake shims encode the Harbor task name in `payload.forecast.marketId`.
 */
export function taskNameByDigestForHarborImport(
  workspaceDir: string,
  document: DraftDocument,
): Readonly<Record<string, string>> {
  const runtime = document.spec.evaluationRuntime;
  if (isHarborCompatibleEvaluationRuntime(runtime)) {
    const manifest = HarborSelectionManifestSchema.parse(
      JSON.parse(UTF8.decode(getSealedBytes(workspaceDir, runtime.selectionManifestSha256))),
    );
    const suite = suiteSelectionFromHarbor(manifest);
    if (suite !== undefined) return taskNameByDigestFromSuite(suite);
  }
  if (document.spec.taskSet.kind !== "benchmark") {
    refuse("conflict", `drafts.${document.draftId}.taskSet`, `draft ${document.draftId} has no attached benchmark`);
  }
  const benchmark = parseBenchmark(getSealedBytes(workspaceDir, document.spec.taskSet.benchmarkSha256));
  const names: Record<string, string> = {};
  for (const item of benchmark.items) {
    const digest = itemTaskDigest(item);
    const task = JSON.parse(UTF8.decode(getSealedBytes(workspaceDir, digest))) as Record<string, unknown>;
    const name = marketIdTaskName(task);
    if (name !== undefined) names[digest] = name;
  }
  if (Object.keys(names).length !== benchmark.items.length) {
    refuse(
      "conflict",
      `drafts.${document.draftId}.harbor`,
      "Harbor import needs suite-protocol task names on the locked run (Harbor selection profile), "
        + "or Terminal-Bench 2.1 intake that encodes each Harbor task name. Full official 89-name "
        + "coverage is issue #4678.",
    );
  }
  return names;
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

function harborVersionFromJobs(jobsDir: string): string {
  for (const jobRoot of harborJobRoots(jobsDir)) {
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
  const taskNameByDigest = taskNameByDigestForHarborImport(workspaceDir, document);
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
    }),
    source: { harness: "harbor", version: harborVersionFromJobs(jobsDir) },
    evidenceRoot: jobsDir,
  };
}
