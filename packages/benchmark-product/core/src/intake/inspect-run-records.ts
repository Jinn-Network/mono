// SPDX-License-Identifier: Apache-2.0

/**
 * Inspect eval-log reader for `run import --from inspect` (#3992).
 *
 * This is a named harness reader, not a second scorer mapper. Sample identity is the suite
 * name table already used by the orchestrated Inspect eval path (`digestBySampleIdFromSuite` /
 * `sampleIdByDigestFromSuite` in `from-inspect.ts`). Scorer outputs are projected into the
 * pre-registered measurements the Inspect adapter already uses for orchestrated cells
 * (`observe_native_log` in `runtime/inspect/worker.py`: type-strict `passValue` comparison,
 * one Boolean per sealed projection). One sample becomes one per-attempt record.
 *
 * The in-process shape is Inspect's official `read_eval_log` dump (JSON EvalLog). A zip `.eval`
 * container is refused rather than unpacked — that would be a second parser of Inspect's
 * on-disk zip layout.
 */

import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative as relativePath, sep } from "node:path";
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
import { INSPECT_ADAPTER_ID, isInspectMultiScorerSelection, type InspectSelectionManifest } from "../runtime/inspect/manifest.js";
import { InspectEvalSelectionManifestSchema } from "../runtime/inspect-eval/manifest.js";
import { digestBySampleIdFromSuite } from "../runtime/suite-protocol/from-inspect.js";
import type { ExternalRunImportSource } from "../run/external-import.js";
import { requireRunState } from "../run/state.js";
import { getSealedBytes } from "../workspace/sealed-store.js";
import type { ExternalRunEvidenceRef, ExternalRunRecord } from "./external-run-records.js";

export interface InspectImportArm {
  readonly armId: string;
  readonly model?: string;
}

export interface ReadInspectRunRecordsInput {
  readonly evalLogOrDir: string;
  readonly digestBySampleId: Readonly<Record<string, string>>;
  readonly arms: readonly InspectImportArm[];
  readonly expected: readonly CellCoord[];
  /** Sealed Inspect scoring policy — the same projections the orchestrated adapter uses. */
  readonly scoring: InspectSelectionManifest;
}

export interface InspectRunImportDump {
  readonly records: readonly ExternalRunRecord[];
  readonly source: ExternalRunImportSource;
  readonly evidenceRoot: string;
}

const UTF8 = new TextDecoder("utf8", { fatal: true });
const EXTRA_ARM = "extra";
const EVIDENCE_NAME = "inspect-log.eval";
const INSPECT_STATUSES = new Set(["started", "success", "cancelled", "error"]);

interface EvalSampleShape {
  readonly id: string | number;
  readonly epoch: number;
  readonly errorType?: string;
  readonly scores: Readonly<Record<string, { readonly value: unknown }>>;
}

interface EvalLogShape {
  readonly status: string;
  readonly invalidated: boolean;
  readonly model?: string;
  readonly armId?: string;
  readonly errorType?: string;
  readonly samples: readonly EvalSampleShape[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function extraCellKey(sampleId: string, attempt: number): string {
  const digest = createHash("sha256").update(`inspect-extra:${sampleId}`).digest("hex");
  const replicate = Number.isInteger(attempt) && attempt >= 1 ? attempt : 1;
  return cellKey(digest, EXTRA_ARM, replicate);
}

function relativeEvidencePath(root: string, absolute: string): string {
  return relativePath(root, absolute).split(sep).join("/");
}

function jsonScalarEqual(left: unknown, right: unknown): boolean {
  if (typeof left === "boolean" || typeof right === "boolean") {
    return typeof left === "boolean" && typeof right === "boolean" && left === right;
  }
  if (typeof left === "number" && typeof right === "number") return left === right;
  return typeof left === typeof right && left === right;
}

function isProjectableScalar(value: unknown): boolean {
  if (typeof value === "number") return Number.isFinite(value);
  return value === null || typeof value === "boolean" || typeof value === "string";
}

function scoreValue(sample: EvalSampleShape, scorerName: string): unknown {
  const score = sample.scores[scorerName];
  return score === undefined ? undefined : score.value;
}

function timeoutType(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  return /timeout/i.test(value) ? value : undefined;
}

/**
 * One-sample projection matching `observe_native_log` in `runtime/inspect/worker.py`.
 * A batched log is split first; each sample is scored as its own 1-sample cell.
 */
function projectSample(
  scoring: InspectSelectionManifest,
  sample: EvalSampleShape,
  log: EvalLogShape,
): { readonly outcome: string; readonly reason?: string; readonly measurements?: Readonly<Record<string, boolean>> } {
  const timedOut = timeoutType(sample.errorType) ?? timeoutType(log.errorType);
  if (timedOut !== undefined) {
    return { outcome: "timeout", reason: timedOut };
  }
  if (isInspectMultiScorerSelection(scoring)) {
    const measurements: Record<string, boolean> = {};
    let unscorable = log.status !== "success" || log.invalidated || sample.errorType !== undefined;
    for (const projection of scoring.scoring.projections) {
      let value = scoreValue(sample, projection.scorerName);
      if (value === undefined) {
        unscorable = true;
        continue;
      }
      if (projection.subScoreKey !== undefined) {
        if (!isRecord(value) || !(projection.subScoreKey in value)) {
          unscorable = true;
          continue;
        }
        value = value[projection.subScoreKey];
      }
      if (!isProjectableScalar(value) || Array.isArray(value)) {
        unscorable = true;
        continue;
      }
      measurements[projection.measurementName] = jsonScalarEqual(value, projection.passValue);
    }
    if (unscorable || Object.keys(measurements).length !== scoring.scoring.projections.length) {
      return { outcome: "ungradeable", reason: "Inspect scorer outputs were missing, non-scalar, or the log was not a success" };
    }
    return { outcome: "graded", measurements };
  }
  const value = scoreValue(sample, scoring.scorer.name);
  const missing = value === undefined || Array.isArray(value) || isRecord(value);
  const unscorable = log.status !== "success" || log.invalidated || sample.errorType !== undefined || missing;
  if (unscorable) {
    return { outcome: "ungradeable", reason: "Inspect selected score was missing, non-scalar, or the log was not a success" };
  }
  return {
    outcome: "graded",
    measurements: { "inspect-score-pass": jsonScalarEqual(value, scoring.scorer.passValue) },
  };
}

function parseScoreMap(value: unknown): Readonly<Record<string, { readonly value: unknown }>> {
  if (!isRecord(value)) return {};
  const scores: Record<string, { readonly value: unknown }> = {};
  for (const [name, score] of Object.entries(value)) {
    if (isRecord(score) && "value" in score) {
      scores[name] = { value: score["value"] };
    }
  }
  return scores;
}

function parseSample(value: unknown): EvalSampleShape | undefined {
  if (!isRecord(value)) return undefined;
  const id = value["id"];
  if (!((typeof id === "string" && id.length > 0) || (typeof id === "number" && Number.isInteger(id)))) {
    return undefined;
  }
  const epochRaw = value["epoch"];
  const epoch = typeof epochRaw === "number" && Number.isInteger(epochRaw) && epochRaw >= 1 ? epochRaw : 1;
  const error = isRecord(value["error"]) && typeof value["error"]["type"] === "string"
    ? value["error"]["type"]
    : undefined;
  return {
    id,
    epoch,
    ...(error === undefined ? {} : { errorType: error }),
    scores: parseScoreMap(value["scores"]),
  };
}

function parseEvalLog(value: unknown): EvalLogShape | undefined {
  if (!isRecord(value)) return undefined;
  const status = value["status"];
  if (typeof status !== "string" || !INSPECT_STATUSES.has(status)) return undefined;
  const evalField = isRecord(value["eval"]) ? value["eval"] : {};
  const metadata = isRecord(evalField["metadata"]) ? evalField["metadata"] : {};
  const armId = typeof metadata["jinn.arm_id"] === "string" ? metadata["jinn.arm_id"] : undefined;
  const model = typeof evalField["model"] === "string" ? evalField["model"] : undefined;
  const errorType = isRecord(value["error"]) && typeof value["error"]["type"] === "string"
    ? value["error"]["type"]
    : undefined;
  const rawSamples = value["samples"];
  const samples = Array.isArray(rawSamples)
    ? rawSamples.flatMap((sample) => {
      const parsed = parseSample(sample);
      return parsed === undefined ? [] : [parsed];
    })
    : [];
  return {
    status,
    invalidated: value["invalidated"] === true,
    ...(model === undefined ? {} : { model }),
    ...(armId === undefined ? {} : { armId }),
    ...(errorType === undefined ? {} : { errorType }),
    samples,
  };
}

function isZipEvalContainer(bytes: Buffer): boolean {
  return bytes.length >= 2 && bytes[0] === 0x50 && bytes[1] === 0x4b;
}

function readEvalLogShape(path: string, required: boolean): EvalLogShape | undefined {
  const bytes = readFileSync(path);
  if (isZipEvalContainer(bytes)) {
    refuse(
      "validation",
      path,
      `${path} is an Inspect zip .eval container. This reader consumes Inspect's official `
        + "read_eval_log JSON shape in-process (EvalLog dump / log_format=json) and does not "
        + "unpack the zip layout or shell out to inspect-ai.",
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(UTF8.decode(bytes));
  } catch {
    if (required) refuse("validation", path, `${path} is not JSON in Inspect's read_eval_log EvalLog shape`);
    return undefined;
  }
  const log = parseEvalLog(parsed);
  if (log === undefined && required) {
    refuse("validation", path, `${path} is not JSON in Inspect's read_eval_log EvalLog shape`);
  }
  return log;
}

function isEvalLogFileName(name: string): boolean {
  return name.endsWith(".eval") || name.endsWith(".eval.json") || name.endsWith(".json");
}

function evalLogFiles(evalLogOrDir: string): { readonly root: string; readonly files: readonly string[] } {
  if (!existsSync(evalLogOrDir)) {
    refuse("validation", "eval-log", `Inspect eval log or directory ${evalLogOrDir} does not exist`);
  }
  const info = statSync(evalLogOrDir);
  if (info.isFile()) {
    return { root: dirname(evalLogOrDir), files: [evalLogOrDir] };
  }
  if (!info.isDirectory()) {
    refuse("validation", "eval-log", `Inspect eval log or directory ${evalLogOrDir} is not a file or directory`);
  }
  const files = readdirSync(evalLogOrDir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && !entry.name.startsWith(".") && isEvalLogFileName(entry.name))
    .map((entry) => join(evalLogOrDir, entry.name))
    .sort((left, right) => left.localeCompare(right));
  if (files.length === 0) {
    refuse("validation", "eval-log", `Inspect eval directory ${evalLogOrDir} contains no .eval or EvalLog JSON files`);
  }
  return { root: evalLogOrDir, files };
}

function resolveArmId(log: EvalLogShape, arms: readonly InspectImportArm[]): string {
  if (log.armId !== undefined) {
    const byMeta = arms.filter((arm) => arm.armId === log.armId);
    if (byMeta.length === 1) return byMeta[0]!.armId;
  }
  if (arms.length === 1) return arms[0]!.armId;
  if (log.model !== undefined) {
    const byModel = arms.filter((arm) => arm.model === log.model);
    if (byModel.length === 1) return byModel[0]!.armId;
  }
  return EXTRA_ARM;
}

function sampleKey(sample: EvalSampleShape): string {
  return String(sample.id);
}

/**
 * Reads Inspect `read_eval_log` JSON logs into the #2979 per-attempt record shape.
 * Missing expected slots are emitted as `unrun` with a required reason.
 */
export function readInspectRunRecords(input: ReadInspectRunRecordsInput): ExternalRunRecord[] {
  const { evalLogOrDir, digestBySampleId, arms, expected, scoring } = input;
  if (arms.length === 0) refuse("validation", "inspect-arm", "Inspect import requires at least one locked arm");
  const { root, files } = evalLogFiles(evalLogOrDir);
  const records: ExternalRunRecord[] = [];
  let row = 0;
  let logsRead = 0;

  for (const file of files) {
    const required = file.endsWith(".eval") || file.endsWith(".eval.json");
    const log = readEvalLogShape(file, required);
    if (log === undefined) continue;
    logsRead += 1;
    const armId = resolveArmId(log, arms);
    const evidence: readonly ExternalRunEvidenceRef[] = [{
      name: EVIDENCE_NAME,
      path: relativeEvidencePath(root, file),
    }];
    for (const sample of log.samples) {
      const name = sampleKey(sample);
      const digest = digestBySampleId[name];
      const mappedKey = digest === undefined
        ? extraCellKey(name, sample.epoch)
        : cellKey(digest, armId, sample.epoch);
      const shape = projectSample(scoring, sample, log);
      row += 1;
      const carriesEvidence = shape.outcome === "graded" || shape.outcome === "ungradeable";
      records.push({
        row,
        cellKey: mappedKey,
        outcome: shape.outcome,
        ...(shape.reason === undefined ? {} : { reason: shape.reason }),
        ...(carriesEvidence ? { evidence } : {}),
        ...(shape.measurements === undefined ? {} : { measurements: shape.measurements }),
      });
    }
  }

  if (logsRead === 0) {
    refuse("validation", "eval-log", `no Inspect read_eval_log EvalLog JSON was found at ${evalLogOrDir}`);
  }

  const claimed = new Set(records.map((record) => record.cellKey));
  for (const coord of expected) {
    if (claimed.has(coord.cellKey)) continue;
    row += 1;
    records.push({
      row,
      cellKey: coord.cellKey,
      outcome: "unrun",
      reason: "Inspect eval logs contained no sample for this slot",
    });
  }
  return records;
}

function pinningModel(pinning: Readonly<Record<string, unknown>>): string | undefined {
  const model = pinning["model"];
  if (typeof model === "object" && model !== null && "id" in model && typeof (model as { id: unknown }).id === "string") {
    return (model as { id: string }).id;
  }
  return undefined;
}

function sampleIdFromTask(task: Record<string, unknown>): string | undefined {
  const payload = task["payload"];
  if (!isRecord(payload)) return undefined;
  const sampleId = payload["sampleId"];
  if (typeof sampleId === "string" && sampleId.length > 0) return sampleId;
  if (typeof sampleId === "number" && Number.isInteger(sampleId)) return String(sampleId);
  return undefined;
}

function scoringFromBytes(bytes: Uint8Array): {
  readonly scoring: InspectSelectionManifest;
  readonly digestBySampleId: Readonly<Record<string, string>>;
  readonly arms: readonly InspectImportArm[];
  readonly version: string;
} | undefined {
  const parsed: unknown = JSON.parse(UTF8.decode(bytes));
  const inspectEval = InspectEvalSelectionManifestSchema.safeParse(parsed);
  if (!inspectEval.success) return undefined;
  const manifest = inspectEval.data;
  return {
    scoring: manifest.inspect as InspectSelectionManifest,
    digestBySampleId: digestBySampleIdFromSuite(manifest.suite),
    arms: manifest.inspect.arms.map((arm) => ({ armId: arm.armId, model: arm.model })),
    version: manifest.inspect.runtime.inspectVersion,
  };
}

export function inspectImportBindingForDraft(
  workspaceDir: string,
  document: DraftDocument,
): {
  readonly scoring: InspectSelectionManifest;
  readonly digestBySampleId: Readonly<Record<string, string>>;
  readonly arms: readonly InspectImportArm[];
  readonly version: string;
} {
  const runtime = document.spec.evaluationRuntime;
  if (runtime === undefined || runtime.adapterId !== INSPECT_ADAPTER_ID) {
    refuse(
      "conflict",
      `drafts.${document.draftId}.evaluationRuntime`,
      "Inspect import requires a locked draft bound to the inspect adapter "
        + "(scorer projections come from the sealed selection). Binary-judgment stays refused.",
    );
  }
  const fromSelection = scoringFromBytes(getSealedBytes(workspaceDir, runtime.selectionManifestSha256));
  if (fromSelection !== undefined) return fromSelection;

  // Cousin Inspect-task selection: one sampleId per Task payload, scoring on the selection itself.
  const parsed: unknown = JSON.parse(UTF8.decode(getSealedBytes(workspaceDir, runtime.selectionManifestSha256)));
  if (!isRecord(parsed) || (parsed["scorer"] === undefined && parsed["scoring"] === undefined)) {
    refuse(
      "conflict",
      `drafts.${document.draftId}.evaluationRuntime`,
      "Inspect import needs the sealed Inspect selection's scorer projections",
    );
  }
  const scoring = parsed as InspectSelectionManifest;
  if (document.spec.taskSet.kind !== "benchmark") {
    refuse("conflict", `drafts.${document.draftId}.taskSet`, `draft ${document.draftId} has no attached benchmark`);
  }
  const benchmark = parseBenchmark(getSealedBytes(workspaceDir, document.spec.taskSet.benchmarkSha256));
  const names: Record<string, string> = {};
  for (const item of benchmark.items) {
    const digest = itemTaskDigest(item);
    const task = JSON.parse(UTF8.decode(getSealedBytes(workspaceDir, digest))) as Record<string, unknown>;
    const name = sampleIdFromTask(task);
    if (name !== undefined) names[name] = digest;
  }
  if (Object.keys(names).length !== benchmark.items.length) {
    refuse(
      "conflict",
      `drafts.${document.draftId}.inspect`,
      "Inspect import needs suite-protocol sample ids on the locked run, or Task payloads that carry sampleId",
    );
  }
  const arms = isRecord(parsed) && Array.isArray(parsed["arms"])
    ? (parsed["arms"] as readonly { readonly armId: string; readonly model?: string }[])
      .filter((arm) => typeof arm.armId === "string")
      .map((arm) => ({ armId: arm.armId, ...(typeof arm.model === "string" ? { model: arm.model } : {}) }))
    : document.spec.arms.map((arm) => ({
      armId: arm.armId,
      ...(pinningModel(arm.pinning) === undefined ? {} : { model: pinningModel(arm.pinning) }),
    }));
  const version = isRecord(parsed)
    && isRecord(parsed["runtime"])
    && typeof parsed["runtime"]["inspectVersion"] === "string"
    ? parsed["runtime"]["inspectVersion"]
    : "0.3.255";
  return { scoring, digestBySampleId: names, arms, version };
}

/** Loads the locked slate and reads Inspect `read_eval_log` JSON into import records. */
export function readInspectRunImport(input: {
  readonly workspaceDir: string;
  readonly draftId: string;
  readonly evalLogOrDir: string;
}): InspectRunImportDump {
  const { workspaceDir, draftId, evalLogOrDir } = input;
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
  const binding = inspectImportBindingForDraft(workspaceDir, document);
  return {
    records: readInspectRunRecords({
      evalLogOrDir,
      digestBySampleId: binding.digestBySampleId,
      arms: binding.arms,
      expected,
      scoring: binding.scoring,
    }),
    source: { harness: "inspect", version: binding.version },
    evidenceRoot: existsSync(evalLogOrDir) && statSync(evalLogOrDir).isDirectory()
      ? evalLogOrDir
      : dirname(evalLogOrDir),
  };
}
