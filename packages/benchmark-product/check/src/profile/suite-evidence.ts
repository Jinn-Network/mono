// SPDX-License-Identifier: Apache-2.0

/**
 * The `suite-comparability` capability's carriage and re-derivation (issues #4759, #4761, #4762).
 *
 * A suite-bound run's Run registers its runtime selection manifest and, for six of the seven
 * official suites, its suite-protocol selection object, by digest. A bundle declaring the
 * capability carries those exact bytes, and the files core read on the producing machine to decide
 * `leaderboardSubmitReady`, so a reader re-derives the claim's `suiteComparability` section, and
 * the limitation sentence it selects, from bytes it holds rather than from the claim under test.
 *
 * Every predicate here reads a {@link SuiteEvidenceTree}: the producer hands it a tree read from
 * disk, the checker a tree of the carried files. One function decides the flag on both sides, and
 * the same function names the files the producer must carry, so what the producer decided on is
 * what the reader re-derives from.
 */

import { createHash } from "node:crypto";
import { cellKey } from "@jinn-network/benchmarking-records";
import { canonicalJsonBytes } from "@jinn-network/trust-core";
import { z } from "zod";
import { refuse } from "./errors.js";
import { INSPECT_SELECTION_CORRELATION_ROLE } from "./binary-judge-manifest.js";
import {
  deriveSuiteComparability,
  methodLeaderboardEligible,
  officialApexSweDevConformance,
  officialArchipelagoConformance,
  officialHarborExecutionConformance,
  officialInspectEvalConformance,
  officialPierExecutionConformance,
  officialSwebenchHarnessConformance,
  suiteLeaderboardLimitation,
  type DeriveSuiteComparabilityInput,
  type SuiteComparability,
  type SuiteProtocolId,
} from "./suite-comparability.js";
import {
  SUITE_PROTOCOL_PROFILE,
  SUITE_PROTOCOL_SELECTION_ROLE,
  ApexAgentsSuiteProtocolSelectionSchema,
  ApexSweDevSuiteProtocolSelectionSchema,
  InspectEvalSuiteProtocolSelectionSchema,
  SuiteProtocolSelectionSchema,
  SwebenchVerifiedSuiteProtocolSelectionSchema,
  type SuiteProtocolSelection,
} from "./suite-protocol-selection.js";

// ── The Run's registration roles a suite-bound runtime selection is registered under ──────────
//
// Restated, not imported: the product core owns the runtime adapters and depends on this package,
// so this package cannot take an edge on core. A core test holds each string equal to core's.
export const HARBOR_SELECTION_ROLE = "https://harborframework.com/artifact-roles/selection-manifest/v1" as const;
export const SWE_BENCH_VERIFIED_SELECTION_ROLE = "https://product.jinn.network/artifact-roles/swe-bench-verified/selection/v1" as const;
export const APEX_AGENTS_SELECTION_ROLE = "https://product.jinn.network/artifact-roles/apex-agents/selection/v1" as const;
export const APEX_SWE_DEV_SELECTION_ROLE = "https://product.jinn.network/artifact-roles/apex-swe-dev/selection/v1" as const;
export const INSPECT_EVAL_SELECTION_SCHEMA = "jinn.network/benchmark-product/inspect-eval-selection/1" as const;

// ── Leaderboard pins (restated from core's runtime manifests; a core test holds them equal) ────
export const TERMINAL_BENCH_2_1_LEADERBOARD_DATASET_REF = "sha256:7d7bdc1cbedad549fc1140404bd4dc45e5fd0ea7c4186773687d177ad3a0699a" as const;
export const TERMINAL_BENCH_3_0_LEADERBOARD_DATASET_REF = "sha256:a32a61879ea94eb9dc16fa1fbeb398759f0c07ca633d9d1f6aec760207036da3" as const;
export const DEEP_SWE_V11_LEADERBOARD_GIT_SHA = "435ee89ec2f2e2289f33b0da4f992f0b7b7266b9" as const;
export const DEEP_SWE_V11_LEADERBOARD_TASKS_TREE_SHA = "66df25a1b382017d0ae014d94cadb2698baaed48" as const;
export const DEEP_SWE_V11_LEADERBOARD_TASK_COUNT = 113 as const;
export const SWE_BENCH_VERIFIED_LEADERBOARD_DATASET_REVISION = "c104f840cc67f8b6eec6f759ebc8b2693d585d4a" as const;
export const SWE_BENCH_VERIFIED_LEADERBOARD_INSTANCE_COUNT = 500 as const;
export const APEX_AGENTS_LEADERBOARD_DATASET_REVISION = "92c86856cf1b11f9833a8a076b3a45a63afa3929" as const;
export const APEX_AGENTS_LEADERBOARD_TASK_COUNT = 480 as const;

// ── File trees ─────────────────────────────────────────────────────────────────────────────────

/** A directory of evidence files: relative POSIX paths, and the bytes at each. */
export interface SuiteEvidenceTree {
  /** Every regular file under the root. */
  readonly paths: () => readonly string[];
  /** The bytes at `path`, or `undefined` when no regular file is there. */
  readonly read: (path: string) => Uint8Array | undefined;
}

export function suiteEvidenceTreeFromFiles(files: ReadonlyMap<string, Uint8Array>): SuiteEvidenceTree {
  return { paths: () => [...files.keys()], read: (path) => files.get(path) };
}

function parseJsonObject(bytes: Uint8Array | undefined): Record<string, unknown> | undefined {
  if (bytes === undefined) return undefined;
  let value: unknown;
  try {
    value = JSON.parse(new TextDecoder("utf8", { fatal: true }).decode(bytes));
  } catch {
    return undefined;
  }
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

// ── Matrix accounting ──────────────────────────────────────────────────────────────────────────

const ACCOUNTED_OUTCOMES = new Set(["judged", "unscorable"]);

export interface MatrixCellAccount {
  readonly cellKey: string;
  readonly taskDigest: string;
  readonly armId: string;
  readonly replicate: number;
  readonly outcome: string;
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

// ── Harbor and Pier jobs ───────────────────────────────────────────────────────────────────────

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

/** Each trial directory's `config.json`: a `config.json` one directory below the job root. */
function trialConfigPaths(tree: SuiteEvidenceTree): readonly string[] {
  return tree.paths().filter((path) => {
    const parts = path.split("/");
    return parts.length === 2 && parts[1] === "config.json";
  });
}

/** Each trial directory by the task and attempt its `config.json` names, read once per tree. */
const trialIndexes = new WeakMap<SuiteEvidenceTree, ReadonlyMap<string, readonly string[]>>();

function trialIndex(tree: SuiteEvidenceTree): ReadonlyMap<string, readonly string[]> {
  let index = trialIndexes.get(tree);
  if (index === undefined) {
    const built = new Map<string, string[]>();
    for (const path of trialConfigPaths(tree)) {
      const trial = parseJsonObject(tree.read(path));
      if (trial === undefined) continue;
      const key = `${trialTaskName(trial)}\u0000${trialAttempt(trial)}`;
      const directories = built.get(key) ?? [];
      directories.push(path.split("/")[0]!);
      built.set(key, directories);
    }
    index = built;
    trialIndexes.set(tree, index);
  }
  return index;
}

/** The one trial directory whose `config.json` names this task and attempt, or `undefined` when
 * none or more than one does. Core requires exactly one trial per task and attempt. */
export function harborTrialDirectory(tree: SuiteEvidenceTree, taskName: string, attempt: number): string | undefined {
  const matched = trialIndex(tree).get(`${taskName}\u0000${attempt}`) ?? [];
  return matched.length === 1 ? matched[0] : undefined;
}

/** The files under a trial directory that core counts as ATIF: `agent/recording.cast`, or any path
 * naming `trajectory` or `atif`. */
const pathsByTrial = new WeakMap<SuiteEvidenceTree, ReadonlyMap<string, readonly string[]>>();

function trialAtifPaths(tree: SuiteEvidenceTree, trialDir: string): readonly string[] {
  let byTrial = pathsByTrial.get(tree);
  if (byTrial === undefined) {
    const built = new Map<string, string[]>();
    for (const path of tree.paths()) {
      const slash = path.indexOf("/");
      if (slash <= 0) continue;
      const directory = path.slice(0, slash);
      const paths = built.get(directory) ?? [];
      paths.push(path);
      built.set(directory, paths);
    }
    byTrial = built;
    pathsByTrial.set(tree, byTrial);
  }
  const prefix = `${trialDir}/`;
  return (byTrial.get(trialDir) ?? []).filter((path) => {
    const relative = path.slice(prefix.length);
    return relative === "agent/recording.cast" || /trajectory|atif/iu.test(relative);
  });
}

/** `reward.json` only. Pier trials that scored into `reward.txt` are still judged and still
 * collected; they are deliberately never DeepSWE-leaderboard-ready, because the Datacurve package
 * requires the structured per-trial reward. */
function trialRewardJsonPaths(tree: SuiteEvidenceTree, trialDir: string): readonly string[] {
  return [`${trialDir}/verifier/reward.json`, `${trialDir}/reward.json`].filter((path) => tree.read(path) !== undefined);
}

function judgedTrialDirectories(
  tree: SuiteEvidenceTree,
  suite: SuiteProtocolSelection,
  matrix: { readonly cells: readonly MatrixCellAccount[] },
  armId: string,
): (string | undefined)[] {
  const byKey = new Map(matrix.cells.map((cell) => [cell.cellKey, cell]));
  const directories: (string | undefined)[] = [];
  for (const item of suite.items) {
    for (let replicate = 1; replicate <= suite.replicates; replicate += 1) {
      const cell = byKey.get(cellKey(item.taskSha256, armId, replicate));
      if (cell === undefined || cell.outcome !== "judged") continue;
      directories.push(harborTrialDirectory(tree, item.taskName, replicate));
    }
  }
  return directories;
}

export function atifOnRetainedJob(
  tree: SuiteEvidenceTree,
  suite: SuiteProtocolSelection,
  matrix: { readonly cells: readonly MatrixCellAccount[] },
  armId: string,
): boolean {
  return judgedTrialDirectories(tree, suite, matrix, armId)
    .every((trialDir) => trialDir !== undefined && trialAtifPaths(tree, trialDir).length > 0);
}

export function rewardJsonOnRetainedJob(
  tree: SuiteEvidenceTree,
  suite: SuiteProtocolSelection,
  matrix: { readonly cells: readonly MatrixCellAccount[] },
  armId: string,
): boolean {
  return judgedTrialDirectories(tree, suite, matrix, armId)
    .every((trialDir) => trialDir !== undefined && trialRewardJsonPaths(tree, trialDir).length > 0);
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
  readonly tree: SuiteEvidenceTree;
}): ArmRunComplete {
  const cellsAccounted = accountSuiteArmCells(input.matrix, input.suite, input.armId);
  if (!cellsAccounted) return { cellsAccounted: false, atifOnRetainedJob: false, rewardOnRetainedJob: false };
  return {
    cellsAccounted: true,
    atifOnRetainedJob: atifOnRetainedJob(input.tree, input.suite, input.matrix, input.armId),
    rewardOnRetainedJob: input.suite.protocol === "deep-swe-v1.1"
      ? rewardJsonOnRetainedJob(input.tree, input.suite, input.matrix, input.armId)
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

/** What a reader needs from an arm's job to re-derive the flag: every trial's `config.json`, and
 * each judged cell's trial's ATIF files (and, for DeepSWE, its `reward.json`). */
function harborArmEvidencePaths(
  tree: SuiteEvidenceTree,
  suite: SuiteProtocolSelection,
  matrix: { readonly cells: readonly MatrixCellAccount[] },
  armId: string,
): readonly string[] {
  const paths = new Set(trialConfigPaths(tree));
  for (const trialDir of judgedTrialDirectories(tree, suite, matrix, armId)) {
    if (trialDir === undefined) continue;
    for (const path of trialAtifPaths(tree, trialDir)) paths.add(path);
    if (suite.protocol === "deep-swe-v1.1") for (const path of trialRewardJsonPaths(tree, trialDir)) paths.add(path);
  }
  return [...paths];
}

// ── SWE-bench Verified harness reports ────────────────────────────────────────────────────────

/** The official harness layout, relative to the harness report root. */
export function swebenchHarnessReportRelativePath(input: {
  readonly runId: string;
  readonly modelNameOrPath: string;
  readonly instanceId: string;
}): string {
  return `logs/run_evaluation/${input.runId}/${input.modelNameOrPath}/${input.instanceId}/report.json`;
}

export const SWE_BENCH_PREDICTIONS_PATH = "predictions.jsonl" as const;

export function swebenchRunId(runSha256: string, predictionsSha256: string): string {
  return createHash("sha256").update(`${runSha256}:${predictionsSha256}`).digest("hex").slice(0, 32);
}

export function swebenchModelNameOrPath(arm: { readonly armId: string; readonly pinning: Readonly<Record<string, unknown>> }): string {
  const model = arm.pinning.model;
  if (model !== null && typeof model === "object" && "id" in model && typeof model.id === "string" && model.id.length > 0) {
    return model.id;
  }
  return arm.armId;
}

function harnessReportPresent(tree: SuiteEvidenceTree, path: string, id: string, idKey: "instance_id" | "task_id"): boolean {
  const report = parseJsonObject(tree.read(path));
  return report !== undefined && typeof report[idKey] === "string" && report[idKey] === id;
}

export function swebenchHarnessReportsPresent(input: {
  readonly tree: SuiteEvidenceTree;
  readonly runId: string;
  readonly modelNameOrPath: string;
  readonly instanceIds: readonly string[];
}): boolean {
  if (input.instanceIds.length === 0) return false;
  return input.instanceIds.every((instanceId) => harnessReportPresent(
    input.tree,
    swebenchHarnessReportRelativePath({ runId: input.runId, modelNameOrPath: input.modelNameOrPath, instanceId }),
    instanceId,
    "instance_id",
  ));
}

// ── APEX-Agents Archipelago grades ────────────────────────────────────────────────────────────

/** The official layout, relative to the Archipelago report root. */
export function archipelagoGradeRelativePath(taskId: string): string {
  return `output/${taskId}/grades.json`;
}

export function archipelagoGradesPresent(input: { readonly tree: SuiteEvidenceTree; readonly taskIds: readonly string[] }): boolean {
  if (input.taskIds.length === 0) return false;
  return input.taskIds.every((taskId) => harnessReportPresent(input.tree, archipelagoGradeRelativePath(taskId), taskId, "task_id"));
}

// ── Each protocol's method facts, over the fields of its manifest that decide them ─────────────

/** The method half of {@link DeriveSuiteComparabilityInput}: what the sealed selection decides
 * before a single cell runs. */
export type SuiteMethodFacts = Omit<
  DeriveSuiteComparabilityInput,
  "cellsAccounted" | "atifOnRetainedJob" | "rewardOnRetainedJob" | "harnessReportsPresent" | "archipelagoGradesPresent"
> & { readonly protocol: SuiteProtocolId };

export interface HarborSuiteManifestFacts {
  readonly adapter: { readonly id: string };
  readonly harbor: { readonly version: string };
  readonly environment: { readonly type: string; readonly configuration: Readonly<Record<string, unknown>> };
  readonly retryPolicy: { readonly nAttempts: number; readonly maxRetries: number };
  readonly jobGrain?: "per-dispatch" | "per-arm" | undefined;
  readonly arms: readonly { readonly jobAgent: { readonly name: string } }[];
}

export function harborSuiteMethodFacts(manifest: HarborSuiteManifestFacts, suite: SuiteProtocolSelection): SuiteMethodFacts {
  // `tasksTreeSha` is recomputed from the operator's task material at select, so this compares
  // sealed bytes against the official pin rather than a constant against itself.
  const pin = suite.protocol === "deep-swe-v1.1"
    ? suite.datasetRevision === DEEP_SWE_V11_LEADERBOARD_GIT_SHA
      && suite.tasksTreeSha === DEEP_SWE_V11_LEADERBOARD_TASKS_TREE_SHA
      && suite.datasetTaskCount === DEEP_SWE_V11_LEADERBOARD_TASK_COUNT
    : suite.datasetRevision === (suite.protocol === "terminal-bench-3.0"
      ? TERMINAL_BENCH_3_0_LEADERBOARD_DATASET_REF
      : TERMINAL_BENCH_2_1_LEADERBOARD_DATASET_REF);
  const executionConformance = suite.protocol === "deep-swe-v1.1"
    ? officialPierExecutionConformance({
      k: manifest.retryPolicy.nAttempts,
      maxRetries: manifest.retryPolicy.maxRetries,
      jobGrain: manifest.jobGrain ?? "per-dispatch",
      environmentConfiguration: manifest.environment.configuration,
      pierVersion: manifest.harbor.version,
      adapterId: manifest.adapter.id,
      environmentType: manifest.environment.type,
      agentNames: manifest.arms.map((arm) => arm.jobAgent.name),
    })
    : officialHarborExecutionConformance({
      k: manifest.retryPolicy.nAttempts,
      maxRetries: manifest.retryPolicy.maxRetries,
      jobGrain: manifest.jobGrain ?? "per-dispatch",
      environmentConfiguration: manifest.environment.configuration,
      harborVersion: manifest.harbor.version,
    });
  return {
    protocol: suite.protocol,
    coverage: suite.coverage,
    executionConformance,
    k: suite.replicates,
    selectedCount: suite.selectedTaskNames.length,
    datasetCount: suite.datasetTaskCount,
    atifPresent: suite.atifRequired,
    datasetRevisionMatchesLeaderboardPin: pin,
  };
}

export interface SwebenchSuiteManifestFacts {
  readonly harness: {
    readonly adapterId: string;
    readonly version: string;
    readonly timeoutSeconds: number;
    readonly timeoutOverride: boolean;
    readonly resourceOverride: boolean;
  };
  readonly suite: SuiteProtocolSelection;
}

/** `officialDatasetInstanceCount` is a test seam only; production leaves it unset so the sealed
 * 500-instance size applies. A reader never passes it. */
export function swebenchSuiteMethodFacts(
  manifest: SwebenchSuiteManifestFacts,
  officialDatasetInstanceCount: number = SWE_BENCH_VERIFIED_LEADERBOARD_INSTANCE_COUNT,
): SuiteMethodFacts {
  const suite = manifest.suite;
  return {
    protocol: "swe-bench-verified",
    coverage: suite.coverage,
    executionConformance: officialSwebenchHarnessConformance({
      k: suite.replicates,
      harnessVersion: manifest.harness.version,
      timeoutSeconds: manifest.harness.timeoutSeconds,
      timeoutOverride: manifest.harness.timeoutOverride,
      resourceOverride: manifest.harness.resourceOverride,
      evaluatorId: manifest.harness.adapterId,
    }),
    k: suite.replicates,
    selectedCount: suite.selectedTaskNames.length,
    datasetCount: suite.datasetTaskCount,
    atifPresent: suite.atifRequired,
    datasetRevisionMatchesLeaderboardPin: suite.datasetRevision === SWE_BENCH_VERIFIED_LEADERBOARD_DATASET_REVISION,
    datasetCountMatchesLeaderboardPin: suite.datasetTaskCount === officialDatasetInstanceCount,
  };
}

export interface ApexAgentsSuiteManifestFacts {
  readonly archipelago: {
    readonly adapterId: string;
    readonly commit: string;
    readonly agentId: string;
    readonly maxSteps: number;
    readonly timeoutSeconds: number;
    readonly judgeModel: string;
    readonly judgeThinking: string;
    readonly webSearch: boolean;
    readonly timeoutOverride: boolean;
    readonly resourceOverride: boolean;
  };
  readonly suite: SuiteProtocolSelection;
}

/** `officialDatasetTaskCount` is a test seam only; production leaves it unset so the sealed
 * 480-task size applies. A reader never passes it. */
export function apexAgentsSuiteMethodFacts(
  manifest: ApexAgentsSuiteManifestFacts,
  officialDatasetTaskCount: number = APEX_AGENTS_LEADERBOARD_TASK_COUNT,
): SuiteMethodFacts {
  const suite = manifest.suite;
  return {
    protocol: "apex-agents",
    coverage: suite.coverage,
    executionConformance: officialArchipelagoConformance({
      k: suite.replicates,
      archipelagoCommit: manifest.archipelago.commit,
      agentId: manifest.archipelago.agentId,
      maxSteps: manifest.archipelago.maxSteps,
      timeoutSeconds: manifest.archipelago.timeoutSeconds,
      judgeModel: manifest.archipelago.judgeModel,
      judgeThinking: manifest.archipelago.judgeThinking,
      webSearch: manifest.archipelago.webSearch,
      timeoutOverride: manifest.archipelago.timeoutOverride,
      resourceOverride: manifest.archipelago.resourceOverride,
      evaluatorId: manifest.archipelago.adapterId,
    }),
    k: suite.replicates,
    selectedCount: suite.selectedTaskNames.length,
    datasetCount: suite.datasetTaskCount,
    atifPresent: suite.atifRequired,
    datasetRevisionMatchesLeaderboardPin: suite.datasetRevision === APEX_AGENTS_LEADERBOARD_DATASET_REVISION,
    datasetCountMatchesLeaderboardPin: suite.datasetTaskCount === officialDatasetTaskCount,
  };
}

export interface ApexSweDevSuiteManifestFacts {
  readonly dataset: { readonly revision: string };
  readonly harness: {
    readonly adapterId: string;
    readonly nTrials: number;
    readonly timeoutSeconds: number;
    readonly timeoutOverride: boolean;
    readonly resourceOverride: boolean;
    readonly messageLimit?: number | undefined;
  };
  readonly suite: SuiteProtocolSelection;
}

export function apexSweDevSuiteMethodFacts(manifest: ApexSweDevSuiteManifestFacts): SuiteMethodFacts {
  const suite = manifest.suite;
  return {
    protocol: "apex-swe-dev",
    coverage: suite.coverage,
    // Defense in depth, not a runtime check: every input below is already a `z.literal` in core's
    // `ApexSweDevSelectionManifestSchema`, so a parsed manifest cannot reach here non-conforming.
    // Re-deriving the bit keeps the published conformance claim independent of the schema pins.
    executionConformance: officialApexSweDevConformance({
      k: suite.replicates,
      nTrials: manifest.harness.nTrials,
      timeoutSeconds: manifest.harness.timeoutSeconds,
      timeoutOverride: manifest.harness.timeoutOverride,
      resourceOverride: manifest.harness.resourceOverride,
      evaluatorId: manifest.harness.adapterId,
      ...(manifest.harness.messageLimit === undefined ? {} : { messageLimit: manifest.harness.messageLimit }),
    }),
    k: suite.replicates,
    selectedCount: suite.selectedTaskNames.length,
    datasetCount: suite.datasetTaskCount,
    atifPresent: suite.atifRequired,
    datasetRevisionMatchesLeaderboardPin: suite.datasetRevision === manifest.dataset.revision,
  };
}

export interface InspectEvalSuiteManifestFacts {
  readonly inspect: {
    readonly runtime: { readonly inspectVersion: string };
    readonly runOptions: Readonly<Record<string, unknown>>;
  };
  readonly catalog: { readonly specifiedEpochs: number; readonly snapshotSha256: string };
  readonly solver: string;
  readonly sampleLimit: number | null;
  readonly suite: SuiteProtocolSelection;
}

/**
 * `replicates` is the PLANNED k of the run being judged, never the sealed `suite.replicates`.
 * The manifest's own superRefine forces `suite.replicates === catalog.specifiedEpochs`, so
 * feeding the sealed value back into the conformance predicate would make its
 * `k === specifiedEpochs` check tautological — and `draft update` can move the planned
 * `replicates` after select. Planned k is what actually ran; that is what must be judged.
 */
export function inspectEvalSuiteMethodFacts(manifest: InspectEvalSuiteManifestFacts, replicates: number): SuiteMethodFacts {
  const suite = manifest.suite;
  return {
    protocol: "inspect-eval",
    coverage: suite.coverage,
    executionConformance: officialInspectEvalConformance({
      k: replicates,
      specifiedEpochs: manifest.catalog.specifiedEpochs,
      inspectVersion: manifest.inspect.runtime.inspectVersion,
      adapterId: "inspect",
      solver: manifest.solver,
      sampleLimit: manifest.sampleLimit,
      epochsInRunOptions: Object.prototype.hasOwnProperty.call(manifest.inspect.runOptions, "epochs"),
    }),
    k: replicates,
    selectedCount: suite.selectedTaskNames.length,
    datasetCount: suite.datasetTaskCount,
    atifPresent: false,
    datasetRevisionMatchesLeaderboardPin: suite.datasetRevision === manifest.catalog.snapshotSha256
      && suite.replicates === manifest.catalog.specifiedEpochs,
  };
}

// ── Reading a Run's registered suite selection ────────────────────────────────────────────────

const JsonRecord = z.record(z.string(), z.unknown());

const HarborSuiteManifestFactsSchema = z.object({
  adapter: z.object({ id: z.string() }),
  harbor: z.object({ version: z.string() }),
  environment: z.object({ type: z.string(), configuration: JsonRecord }),
  retryPolicy: z.object({ nAttempts: z.number(), maxRetries: z.number() }),
  jobGrain: z.enum(["per-dispatch", "per-arm"]).optional(),
  arms: z.array(z.object({ jobAgent: z.object({ name: z.string() }) })),
  profiles: JsonRecord.optional(),
});

const SwebenchSuiteManifestFactsSchema = z.object({
  harness: z.object({
    adapterId: z.string(),
    version: z.string(),
    timeoutSeconds: z.number(),
    timeoutOverride: z.boolean(),
    resourceOverride: z.boolean(),
  }),
  suite: SwebenchVerifiedSuiteProtocolSelectionSchema,
});

const ApexAgentsSuiteManifestFactsSchema = z.object({
  archipelago: z.object({
    adapterId: z.string(),
    commit: z.string(),
    agentId: z.string(),
    maxSteps: z.number(),
    timeoutSeconds: z.number(),
    judgeModel: z.string(),
    judgeThinking: z.string(),
    webSearch: z.boolean(),
    timeoutOverride: z.boolean(),
    resourceOverride: z.boolean(),
  }),
  suite: ApexAgentsSuiteProtocolSelectionSchema,
});

const ApexSweDevSuiteManifestFactsSchema = z.object({
  dataset: z.object({ revision: z.string() }),
  harness: z.object({
    adapterId: z.string(),
    nTrials: z.number(),
    timeoutSeconds: z.number(),
    timeoutOverride: z.boolean(),
    resourceOverride: z.boolean(),
    messageLimit: z.number().optional(),
  }),
  suite: ApexSweDevSuiteProtocolSelectionSchema,
});

const InspectEvalSuiteManifestFactsSchema = z.object({
  schema: z.literal(INSPECT_EVAL_SELECTION_SCHEMA),
  inspect: z.object({ runtime: z.object({ inspectVersion: z.string() }), runOptions: JsonRecord }),
  catalog: z.object({ specifiedEpochs: z.number(), snapshotSha256: z.string() }),
  selectedSamples: z.array(z.object({ sampleId: z.union([z.string().min(1), z.number().int()]) })).min(1),
  solver: z.string(),
  sampleLimit: z.number().nullable(),
  suite: InspectEvalSuiteProtocolSelectionSchema,
});

/** A Run's suite-bound runtime selection, read from the bytes it registered. */
export type RegisteredSuiteSelection =
  | { readonly kind: "harbor"; readonly manifest: HarborSuiteManifestFacts; readonly suite: SuiteProtocolSelection }
  | { readonly kind: "swe-bench-verified"; readonly manifest: SwebenchSuiteManifestFacts; readonly suite: SuiteProtocolSelection }
  | { readonly kind: "apex-agents"; readonly manifest: ApexAgentsSuiteManifestFacts; readonly suite: SuiteProtocolSelection }
  | { readonly kind: "apex-swe-dev"; readonly manifest: ApexSweDevSuiteManifestFacts; readonly suite: SuiteProtocolSelection }
  | {
    readonly kind: "inspect-eval";
    readonly manifest: InspectEvalSuiteManifestFacts;
    readonly suite: SuiteProtocolSelection;
    /** The selected sample ids, as the Task payloads carry them. */
    readonly selectedSampleIds: readonly (string | number)[];
  };

const RUNTIME_SELECTION_ROLES: ReadonlySet<string> = new Set([
  HARBOR_SELECTION_ROLE,
  SWE_BENCH_VERIFIED_SELECTION_ROLE,
  APEX_AGENTS_SELECTION_ROLE,
  APEX_SWE_DEV_SELECTION_ROLE,
  INSPECT_SELECTION_CORRELATION_ROLE,
]);

interface RegistrationArtifactRow {
  readonly role: string;
  readonly artifact: { readonly digest: { readonly sha256: string }; readonly mediaType?: string };
}

/** The Run's runtime-selection and suite-protocol-selection registration rows. */
export function registeredSuiteRows(registrationArtifacts: readonly RegistrationArtifactRow[]): {
  readonly runtimeSelection: readonly RegistrationArtifactRow[];
  readonly suiteSelection: readonly RegistrationArtifactRow[];
} {
  return {
    runtimeSelection: registrationArtifacts.filter((row) => RUNTIME_SELECTION_ROLES.has(row.role)),
    suiteSelection: registrationArtifacts.filter((row) => row.role === SUITE_PROTOCOL_SELECTION_ROLE),
  };
}

function parseExactJson(bytes: Uint8Array, path: string): unknown {
  let value: unknown;
  try {
    value = JSON.parse(new TextDecoder("utf8", { fatal: true }).decode(bytes));
  } catch {
    refuse("record-integrity", path, `${path} is not valid UTF-8 JSON`);
  }
  const canonical = canonicalJsonBytes(value as never);
  if (canonical.length !== bytes.length || canonical.some((byte, index) => byte !== bytes[index])) {
    refuse("record-integrity", path, `${path} is not the exact canonical encoding`);
  }
  return value;
}

function parseFacts<T>(schema: { safeParse(value: unknown): { success: true; data: T } | { success: false } }, value: unknown, path: string, what: string): T {
  const parsed = schema.safeParse(value);
  if (!parsed.success) refuse("record-integrity", path, `${path} is not a ${what}`);
  return parsed.data;
}

function parseJsonValue(bytes: Uint8Array): { readonly ok: true; readonly value: unknown } | { readonly ok: false } {
  try {
    return { ok: true, value: JSON.parse(new TextDecoder("utf8", { fatal: true }).decode(bytes)) };
  } catch {
    return { ok: false };
  }
}

/**
 * Whether a runtime selection registered under `role` binds an official suite, read without
 * holding the rest of the manifest to any grammar: a Harbor or Pier selection binds one exactly when
 * it carries a suite-protocol profile, an Inspect selection exactly when it is an Inspect eval, and
 * the SWE-bench Verified, APEX-Agents and APEX-SWE-dev selections always do. A run that binds none
 * is read no further, so its bundle is exactly what it was before this capability existed.
 */
function bindsSuite(role: string, bytes: Uint8Array): boolean {
  if (role === SWE_BENCH_VERIFIED_SELECTION_ROLE || role === APEX_AGENTS_SELECTION_ROLE || role === APEX_SWE_DEV_SELECTION_ROLE) {
    return true;
  }
  if (role !== HARBOR_SELECTION_ROLE && role !== INSPECT_SELECTION_CORRELATION_ROLE) return false;
  const parsed = parseJsonValue(bytes);
  if (!parsed.ok || typeof parsed.value !== "object" || parsed.value === null) return false;
  const value = parsed.value as { readonly schema?: unknown; readonly profiles?: unknown };
  if (role === INSPECT_SELECTION_CORRELATION_ROLE) return value.schema === INSPECT_EVAL_SELECTION_SCHEMA;
  return typeof value.profiles === "object" && value.profiles !== null
    && Object.prototype.hasOwnProperty.call(value.profiles, SUITE_PROTOCOL_PROFILE);
}

/**
 * Reads the suite selection a runtime selection manifest carries, under the grammar of the role
 * the Run registered it with. `undefined` when the manifest binds no official suite: a Harbor
 * selection with no suite profile, or an Inspect selection that is not an Inspect eval.
 */
export function readRegisteredSuiteSelection(role: string, bytes: Uint8Array, path: string): RegisteredSuiteSelection | undefined {
  if (!bindsSuite(role, bytes)) return undefined;
  const value = parseExactJson(bytes, path);
  if (role === HARBOR_SELECTION_ROLE) {
    const manifest = parseFacts(HarborSuiteManifestFactsSchema, value, path, "Harbor selection manifest");
    const suite = parseFacts(SuiteProtocolSelectionSchema, manifest.profiles?.[SUITE_PROTOCOL_PROFILE], path, "suite-protocol selection");
    // Only the Terminal-Bench protocols and DeepSWE v1.1 bind through a Harbor or Pier profile.
    if (suite.protocol !== "terminal-bench-2.1" && suite.protocol !== "terminal-bench-3.0" && suite.protocol !== "deep-swe-v1.1") {
      return undefined;
    }
    return { kind: "harbor", manifest, suite };
  }
  if (role === SWE_BENCH_VERIFIED_SELECTION_ROLE) {
    const manifest = parseFacts(SwebenchSuiteManifestFactsSchema, value, path, "SWE-bench Verified selection manifest");
    return { kind: "swe-bench-verified", manifest, suite: manifest.suite };
  }
  if (role === APEX_AGENTS_SELECTION_ROLE) {
    const manifest = parseFacts(ApexAgentsSuiteManifestFactsSchema, value, path, "APEX-Agents selection manifest");
    return { kind: "apex-agents", manifest, suite: manifest.suite };
  }
  if (role === APEX_SWE_DEV_SELECTION_ROLE) {
    const manifest = parseFacts(ApexSweDevSuiteManifestFactsSchema, value, path, "APEX-SWE-dev selection manifest");
    return { kind: "apex-swe-dev", manifest, suite: manifest.suite };
  }
  const manifest = parseFacts(InspectEvalSuiteManifestFactsSchema, value, path, "Inspect eval selection manifest");
  const names = manifest.selectedSamples.map((sample) => String(sample.sampleId));
  if (names.join("\0") !== manifest.suite.selectedTaskNames.join("\0")) {
    refuse("record-integrity", path, "Inspect eval selected samples differ from its suite's selected task names");
  }
  return {
    kind: "inspect-eval",
    manifest,
    suite: manifest.suite,
    selectedSampleIds: manifest.selectedSamples.map((sample) => sample.sampleId),
  };
}

/** The suite object as it is sealed on its own, the bytes the Run's suite row names. */
export function suiteSelectionBytes(suite: SuiteProtocolSelection): Uint8Array {
  return canonicalJsonBytes(SuiteProtocolSelectionSchema.parse(suite) as never);
}

// ── The evidence member ───────────────────────────────────────────────────────────────────────

export const SUITE_EVIDENCE_BUNDLE_MEMBER = "suite-evidence.json" as const;
export const SUITE_EVIDENCE_FORMAT = "benchmark-product-suite-evidence/1" as const;
export const SUITE_EVIDENCE_ROLE = "suite-evidence" as const;
export const SUITE_PROTOCOL_SELECTION_BUNDLE_ROLE = "suite-protocol-selection" as const;
export const SWE_BENCH_HARNESS_EVIDENCE_ROOT = "swebench-harness" as const;
export const ARCHIPELAGO_EVIDENCE_ROOT = "archipelago" as const;

/** An arm's retained Harbor or Pier job. */
export function harborJobEvidenceRoot(armId: string): string {
  return `harbor-job/${armId}`;
}

function isSafeRelativePath(path: string): boolean {
  return path !== ""
    && !path.startsWith("/")
    && !path.includes("\\")
    && !path.includes("\u0000")
    && path.split("/").every((part) => part !== "" && part !== "." && part !== "..");
}

const SuiteEvidenceFileSchema = z.strictObject({
  root: z.string().min(1),
  path: z.string().min(1).refine(isSafeRelativePath, "a relative path with no empty, dot or parent segment"),
  sha256: z.string().regex(/^[a-f0-9]{64}$/u),
});

function compareEvidenceFiles(left: { readonly root: string; readonly path: string }, right: { readonly root: string; readonly path: string }): number {
  if (left.root !== right.root) return left.root < right.root ? -1 : 1;
  if (left.path !== right.path) return left.path < right.path ? -1 : 1;
  return 0;
}

export const SuiteEvidenceIndexSchema = z.strictObject({
  format: z.literal(SUITE_EVIDENCE_FORMAT),
  files: z.array(SuiteEvidenceFileSchema),
}).superRefine((index, ctx) => {
  for (let position = 1; position < index.files.length; position += 1) {
    if (compareEvidenceFiles(index.files[position - 1]!, index.files[position]!) >= 0) {
      ctx.addIssue({ code: "custom", path: ["files", position], message: "files must be unique and sorted by root, then path" });
    }
  }
});
export type SuiteEvidenceIndex = z.infer<typeof SuiteEvidenceIndexSchema>;

export function buildSuiteEvidenceIndex(files: readonly { readonly root: string; readonly path: string; readonly sha256: string }[]): Uint8Array {
  return canonicalJsonBytes(SuiteEvidenceIndexSchema.parse({
    format: SUITE_EVIDENCE_FORMAT,
    files: [...files].sort(compareEvidenceFiles).map((file) => ({ root: file.root, path: file.path, sha256: file.sha256 })),
  }) as never);
}

// ── The derivation both sides run ─────────────────────────────────────────────────────────────

export interface SuiteDerivation {
  readonly protocol: SuiteProtocolId;
  readonly comparability: SuiteComparability;
  /** The sentence `suiteLeaderboardLimitation` selects, sealed in the Report's limitations. */
  readonly limitation: string | undefined;
  /** The files that decided the flag, by root: what a declaring bundle carries. */
  readonly evidence: readonly { readonly root: string; readonly path: string }[];
}

/**
 * Derives `suiteComparability` from a registered suite selection, the Run's arms and planned
 * replicates, the Matrix, and the evidence trees, and names the files that decided it.
 *
 * Files are named only where they decide the flag: when the method is leaderboard-eligible and
 * every arm's cells are accounted. Otherwise the flag is false whatever the files say, so a reader
 * needs none of them.
 */
export function deriveSuiteComparabilityFromEvidence(input: {
  readonly selection: RegisteredSuiteSelection;
  readonly arms: readonly { readonly armId: string; readonly pinning: Readonly<Record<string, unknown>> }[];
  readonly replicates: number;
  readonly runSha256: string;
  readonly matrix: { readonly cells: readonly MatrixCellAccount[] };
  readonly tree: (root: string) => SuiteEvidenceTree;
}): SuiteDerivation {
  const { selection, matrix } = input;
  const suite = selection.suite;
  const armIds = input.arms.map((arm) => arm.armId);
  const cellsAccounted = armIds.length > 0 && armIds.every((armId) => accountSuiteArmCells(matrix, suite, armId));
  const evidence: { root: string; path: string }[] = [];
  let derivationInput: DeriveSuiteComparabilityInput;
  if (selection.kind === "harbor") {
    const method = harborSuiteMethodFacts(selection.manifest, suite);
    const arms = armIds.map((armId) => {
      const tree = input.tree(harborJobEvidenceRoot(armId));
      return { armId, tree, complete: assessArmRunComplete({ matrix, suite, armId, tree }) };
    });
    if (methodLeaderboardEligible(method) && cellsAccounted) {
      for (const arm of arms) {
        for (const path of harborArmEvidencePaths(arm.tree, suite, matrix, arm.armId)) {
          evidence.push({ root: harborJobEvidenceRoot(arm.armId), path });
        }
      }
    }
    derivationInput = { ...method, ...allArmsRunComplete(arms.map((arm) => arm.complete)) };
  } else if (selection.kind === "swe-bench-verified") {
    const method = swebenchSuiteMethodFacts(selection.manifest);
    const tree = input.tree(SWE_BENCH_HARNESS_EVIDENCE_ROOT);
    const predictions = tree.read(SWE_BENCH_PREDICTIONS_PATH) ?? new Uint8Array();
    const runId = swebenchRunId(input.runSha256, createHash("sha256").update(predictions).digest("hex"));
    const reportPaths = input.arms.flatMap((arm) => suite.selectedTaskNames.map((instanceId) => swebenchHarnessReportRelativePath({
      runId,
      modelNameOrPath: swebenchModelNameOrPath(arm),
      instanceId,
    })));
    const harnessReportsPresent = input.arms.length > 0 && input.arms.every((arm) => swebenchHarnessReportsPresent({
      tree,
      runId,
      modelNameOrPath: swebenchModelNameOrPath(arm),
      instanceIds: suite.selectedTaskNames,
    }));
    if (methodLeaderboardEligible(method) && cellsAccounted) {
      for (const path of [SWE_BENCH_PREDICTIONS_PATH, ...reportPaths]) {
        if (tree.read(path) !== undefined) evidence.push({ root: SWE_BENCH_HARNESS_EVIDENCE_ROOT, path });
      }
    }
    derivationInput = { ...method, cellsAccounted, harnessReportsPresent };
  } else if (selection.kind === "apex-agents") {
    const method = apexAgentsSuiteMethodFacts(selection.manifest);
    const tree = input.tree(ARCHIPELAGO_EVIDENCE_ROOT);
    if (methodLeaderboardEligible(method) && cellsAccounted) {
      for (const taskId of suite.selectedTaskNames) {
        const path = archipelagoGradeRelativePath(taskId);
        if (tree.read(path) !== undefined) evidence.push({ root: ARCHIPELAGO_EVIDENCE_ROOT, path });
      }
    }
    derivationInput = {
      ...method,
      cellsAccounted,
      archipelagoGradesPresent: archipelagoGradesPresent({ tree, taskIds: suite.selectedTaskNames }),
    };
  } else if (selection.kind === "apex-swe-dev") {
    // Never leaderboard-ready (`methodLeaderboardEligible`), so no file decides the flag.
    derivationInput = { ...apexSweDevSuiteMethodFacts(selection.manifest), cellsAccounted, harnessReportsPresent: false };
  } else {
    // Inspect eval's readiness reads the selection, the planned replicates and the Matrix alone.
    derivationInput = { ...inspectEvalSuiteMethodFacts(selection.manifest, input.replicates), cellsAccounted };
  }
  const comparability = deriveSuiteComparability(derivationInput);
  return {
    protocol: suite.protocol,
    comparability,
    limitation: suiteLeaderboardLimitation(comparability, suite.protocol),
    evidence,
  };
}

// ── The reader's half ─────────────────────────────────────────────────────────────────────────

/** What a declaring bundle carries, resolved and re-derived. */
export interface CarriedSuite extends SuiteDerivation {
  readonly selection: RegisteredSuiteSelection;
  readonly runtimeSelectionSha256: string;
  /** The separately carried suite-protocol object. Absent for Inspect eval, whose Run registers
   * none: its suite object is read from the manifest it is nested in. */
  readonly suiteSelectionSha256: string | undefined;
  /** Every carried evidence file's digest. */
  readonly evidenceSha256s: readonly string[];
}

function sameEvidence(
  left: readonly { readonly root: string; readonly path: string }[],
  right: readonly { readonly root: string; readonly path: string }[],
): boolean {
  const key = (file: { readonly root: string; readonly path: string }): string => `${file.root}\u0000${file.path}`;
  const leftKeys = left.map(key).sort();
  const rightKeys = right.map(key).sort();
  return leftKeys.length === rightKeys.length && leftKeys.every((value, index) => value === rightKeys[index]);
}

/**
 * Binds the `suite-comparability` declaration to the sealed Run both ways, and on a declaring
 * bundle resolves and re-derives everything the capability carries.
 *
 * - A `/10` Run that registers a suite-protocol selection must declare the capability, so no
 *   suite-bound bundle passes without the section a board keys and checks it on.
 * - A declaring bundle must carry the runtime selection its Run registered, under the grammar of
 *   the role it registered it with, and that selection must bind an official suite.
 * - The separately registered suite object must be carried, and must be the exact canonical bytes
 *   of the object nested in the runtime selection.
 * - The carried evidence must be exactly the files that decide the flag, each under a root the
 *   suite has and with the bytes its index names.
 */
export function resolveCarriedSuite(input: {
  readonly declared: boolean;
  readonly runRecord: {
    readonly arms: readonly { readonly armId: string; readonly pinning: Readonly<Record<string, unknown>> }[];
    readonly replicates: number;
  };
  readonly registrationArtifacts: readonly RegistrationArtifactRow[];
  readonly runSha256: string;
  readonly matrix: { readonly cells: readonly MatrixCellAccount[] };
  readonly records: ReadonlyMap<string, Uint8Array>;
  readonly readMember: (path: string) => Uint8Array;
}): CarriedSuite | undefined {
  const rows = registeredSuiteRows(input.registrationArtifacts);
  if (!input.declared) {
    if (rows.suiteSelection.length > 0) {
      refuse(
        "record-integrity",
        "bundle.manifest.capabilities",
        "the sealed Run registers a suite-protocol selection, so its bundle must declare \"suite-comparability\"",
      );
    }
    return undefined;
  }
  if (rows.runtimeSelection.length !== 1) {
    refuse("record-integrity", "suite-comparability", "a bundle declaring suite-comparability needs a Run that registers exactly one runtime selection");
  }
  const runtimeRow = rows.runtimeSelection[0]!;
  const runtimeSelectionSha256 = runtimeRow.artifact.digest.sha256;
  const runtimePath = `records/${runtimeSelectionSha256}.bin`;
  const runtimeBytes = input.records.get(runtimeSelectionSha256);
  if (runtimeBytes === undefined) {
    refuse("record-integrity", runtimePath, "the bundle does not carry the runtime selection its Run registered");
  }
  const selection = readRegisteredSuiteSelection(runtimeRow.role, runtimeBytes, runtimePath);
  if (selection === undefined) {
    refuse("record-integrity", runtimePath, "the runtime selection the Run registered binds no official suite, but the bundle declares suite-comparability");
  }
  let suiteSelectionSha256: string | undefined;
  if (selection.kind === "inspect-eval") {
    if (rows.suiteSelection.length !== 0) {
      refuse("record-integrity", "suite-comparability", "an Inspect eval Run registers its suite inside its selection manifest, never on its own");
    }
  } else {
    if (rows.suiteSelection.length !== 1) {
      refuse("record-integrity", "suite-comparability", "the Run must register exactly one suite-protocol selection");
    }
    suiteSelectionSha256 = rows.suiteSelection[0]!.artifact.digest.sha256;
    const suitePath = `records/${suiteSelectionSha256}.bin`;
    const suiteBytes = input.records.get(suiteSelectionSha256);
    if (suiteBytes === undefined) {
      refuse("record-integrity", suitePath, "the bundle does not carry the suite-protocol selection its Run registered");
    }
    const nested = suiteSelectionBytes(selection.suite);
    if (nested.length !== suiteBytes.length || nested.some((byte, index) => byte !== suiteBytes[index])) {
      refuse("record-integrity", suitePath, "the carried suite-protocol selection is not the suite object its runtime selection seals");
    }
  }

  const indexBytes = input.readMember(SUITE_EVIDENCE_BUNDLE_MEMBER);
  const indexValue = parseExactJson(indexBytes, SUITE_EVIDENCE_BUNDLE_MEMBER);
  const index = parseFacts(SuiteEvidenceIndexSchema, indexValue, SUITE_EVIDENCE_BUNDLE_MEMBER, "suite evidence index");
  const roots = selection.kind === "harbor"
    ? new Set(input.runRecord.arms.map((arm) => harborJobEvidenceRoot(arm.armId)))
    : selection.kind === "swe-bench-verified"
      ? new Set<string>([SWE_BENCH_HARNESS_EVIDENCE_ROOT])
      : selection.kind === "apex-agents"
        ? new Set<string>([ARCHIPELAGO_EVIDENCE_ROOT])
        : new Set<string>();
  const trees = new Map<string, Map<string, Uint8Array>>();
  for (const file of index.files) {
    if (!roots.has(file.root)) {
      refuse("record-integrity", SUITE_EVIDENCE_BUNDLE_MEMBER, `evidence root "${file.root}" is not one this ${selection.suite.protocol} run has`);
    }
    const bytes = input.records.get(file.sha256);
    if (bytes === undefined) {
      refuse("record-integrity", SUITE_EVIDENCE_BUNDLE_MEMBER, `evidence file ${file.root}/${file.path} names a record the bundle does not carry`);
    }
    const tree = trees.get(file.root) ?? new Map<string, Uint8Array>();
    tree.set(file.path, bytes);
    trees.set(file.root, tree);
  }
  const derivation = deriveSuiteComparabilityFromEvidence({
    selection,
    arms: input.runRecord.arms,
    replicates: input.runRecord.replicates,
    runSha256: input.runSha256,
    matrix: input.matrix,
    tree: (root) => suiteEvidenceTreeFromFiles(trees.get(root) ?? new Map()),
  });
  if (!sameEvidence(index.files, derivation.evidence)) {
    refuse(
      "record-integrity",
      SUITE_EVIDENCE_BUNDLE_MEMBER,
      "the carried suite evidence is not exactly the set of files that decides leaderboardSubmitReady",
    );
  }
  return {
    ...derivation,
    selection,
    runtimeSelectionSha256,
    suiteSelectionSha256,
    evidenceSha256s: [...new Set(index.files.map((file) => file.sha256))],
  };
}

/**
 * An Inspect eval Task carries only `sampleId`. It belongs to the run exactly when its sample is one
 * the registered selection names, and the suite object binds that sample's name to this Task's
 * digest.
 */
export function assertInspectEvalTask(input: {
  readonly selection: Extract<RegisteredSuiteSelection, { readonly kind: "inspect-eval" }>;
  readonly payload: unknown;
  readonly taskDigest: string;
  readonly cellKey: string;
}): void {
  const payload = typeof input.payload === "object" && input.payload !== null && !Array.isArray(input.payload)
    ? input.payload as Readonly<Record<string, unknown>>
    : {};
  const sampleId = payload.sampleId;
  const item = input.selection.suite.items.find((candidate) => candidate.taskName === String(sampleId));
  if (
    Object.keys(payload).length !== 1
    || (typeof sampleId !== "string" && typeof sampleId !== "number")
    || !input.selection.selectedSampleIds.includes(sampleId)
    || item?.taskSha256 !== input.taskDigest
  ) {
    refuse("record-integrity", "evidence-closure", `${input.cellKey} Inspect eval Task is not a sample its sealed selection names`);
  }
}
