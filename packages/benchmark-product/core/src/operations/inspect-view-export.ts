/** Derived Inspect View bundle from correlated per-cell .eval logs. Not Hub. Not the claim of record. */
import { parseCellKey, parseMatrix, parseRun, type MatrixRecord } from "@jinn-network/benchmarking-records";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { refuse } from "../errors.js";
import { isInspectRuntimeAdapterId } from "../runtime/adapter.js";
import { INSPECT_BINARY_JUDGE_ADAPTER_ID } from "../runtime/inspect/binary-judge-manifest.js";
import {
  readInspectBinaryJudgeSelectionManifest,
  readInspectEvalSelectionManifest,
} from "../runtime/inspect/host.js";
import {
  exportCompletenessCertification,
  INSPECT_EVAL_SUBMIT_CLOSED_SENTENCE,
  type SuiteCoverage,
} from "../runtime/suite-protocol/comparability.js";
import { suiteComparabilityForInspectArm } from "../runtime/suite-protocol/from-inspect.js";
import { readRunJournalEntries } from "../run/journal.js";
import { artifactsDir } from "../workspace/layout.js";
import { getSealedBytes } from "../workspace/sealed-store.js";
import type { OperationContext } from "./context.js";
import { readDraftDocument } from "./drafts.js";
import { operate } from "./operate.js";
import type { OperationResult } from "./result.js";
import { requireRunState, type RunState } from "../run/state.js";

export type InspectViewExportMode = "suite-named" | "inspection-upload";

/**
 * A lane discriminant, not a mode: the judge lane's mode is unconditionally
 * "inspection-upload" (§8.2 rule 7), so a third `InspectViewExportMode` member would both be
 * wrong (the mode is stated, not derived, on this lane) and would leak into the CLI's
 * `exported inspect-view (<mode>)` line as a mode name that is really a lane name.
 */
export type InspectViewExportLane = "inspect-eval" | "inspect-binary-judge";

export interface ExportInspectViewBundleInput {
  readonly draftId: string;
  readonly armId: string;
}

export interface ExportInspectViewBundleResult {
  readonly mode: InspectViewExportMode;
  readonly instructions: string;
  readonly exportDir: string;
  readonly logCount: number;
}

export function decideInspectViewExportMode(input: {
  readonly executionConformance: boolean;
  readonly coverage: SuiteCoverage;
  readonly leaderboardSubmitReady: boolean;
}): InspectViewExportMode | "refused" {
  if (!input.executionConformance || input.coverage === "custom") return "refused";
  if (input.leaderboardSubmitReady && input.coverage === "full") return "suite-named";
  return "inspection-upload";
}

export function inspectViewExportInstructions(
  certification: string,
  mode: InspectViewExportMode,
  exportDir: string,
  lane: InspectViewExportLane,
): string {
  if (mode === "suite-named") {
    return [
      certification,
      "The locked Inspect eval method produced correlated per-cell .eval logs.",
      `inspect view --log-dir ${exportDir}`,
      "inspect view bundle --bundle-dir <out> can wrap this log dir for Inspect View.",
      INSPECT_EVAL_SUBMIT_CLOSED_SENTENCE,
    ].join("\n");
  }
  if (lane === "inspect-binary-judge") {
    return [
      certification,
      "This run's method is a custom judge binding, not an Inspect eval selection, so this package wears no suite name.",
      `You may open the logs for inspection: inspect view --log-dir ${exportDir}`,
      "Do not treat this package as an Inspect Hub row or as the Colophon claim of record.",
      "These .eval logs carry the judge's transcripts, not its verdicts; the verdicts are in the sealed Report and the published bundle.",
      INSPECT_EVAL_SUBMIT_CLOSED_SENTENCE,
    ].join("\n");
  }
  return [
    certification,
    "This run matches Inspect eval execution settings for the selected named slice, but it is not eval complete for the sealed catalog.",
    `You may open the logs for inspection: inspect view --log-dir ${exportDir}`,
    "Do not treat this package as an Inspect Hub row or as the Colophon claim of record.",
    INSPECT_EVAL_SUBMIT_CLOSED_SENTENCE,
  ].join("\n");
}

export function exportInspectViewBundle(
  context: OperationContext,
  input: ExportInspectViewBundleInput,
): OperationResult<ExportInspectViewBundleResult> {
  return operate({
    context,
    action: "runtime.inspect.eval.export",
    subject: input.draftId,
    inputs: input,
    run: () => executeExportInspectViewBundle(context, input),
  });
}

export function executeExportInspectViewBundle(
  context: OperationContext,
  input: ExportInspectViewBundleInput,
): ExportInspectViewBundleResult {
      const document = readDraftDocument(context.workspaceDir, input.draftId);
      if (!document.spec.arms.some((arm) => arm.armId === input.armId)) {
        refuse("not-found", `drafts.${input.draftId}.spec.arms.${input.armId}`, "draft has no such arm");
      }
      const evaluationRuntime = document.spec.evaluationRuntime;
      if (evaluationRuntime === undefined || !isInspectRuntimeAdapterId(evaluationRuntime.adapterId)) {
        refuse("conflict", `drafts.${input.draftId}.evaluationRuntime`, "Inspect View export requires a locked Inspect runtime");
      }
      const lane: InspectViewExportLane = evaluationRuntime.adapterId === INSPECT_BINARY_JUDGE_ADAPTER_ID
        ? "inspect-binary-judge"
        : "inspect-eval";
      let mode: InspectViewExportMode;
      let runState: RunState;
      let runSha256: string;
      let matrix: MatrixRecord | undefined;
      if (lane === "inspect-binary-judge") {
        // No suite quote is ever consulted on this lane (§8.2 rule 7): a judge run has no
        // `runState.suiteQuote` — `run-quote.ts` produces one for five adapter ids and
        // `inspect-binary-judge` is not one of them — and a judge method names no suite
        // protocol, so its mode is stated as `inspection-upload` unconditionally rather than
        // derived from a quote it does not have.
        const manifest = readInspectBinaryJudgeSelectionManifest(
          context.workspaceDir,
          evaluationRuntime.selectionManifestSha256,
        );
        if (manifest === undefined) {
          refuse(
            "conflict",
            `runs.${input.draftId}.evaluationRuntime`,
            "the sealed judge binding manifest does not match the pinned binary-judge selection schema",
          );
        }
        runState = requireRunState(context.workspaceDir, input.draftId);
        if (runState.runSha256 === undefined) {
          refuse("conflict", `runs.${input.draftId}`, "Inspect View export requires a sealed Run");
        }
        runSha256 = runState.runSha256;
        matrix = runState.matrixSha256 === undefined
          ? undefined
          : parseMatrix(getSealedBytes(context.workspaceDir, runState.matrixSha256));
        mode = "inspection-upload";
      } else {
        const manifest = readInspectEvalSelectionManifest(
          context.workspaceDir,
          evaluationRuntime.selectionManifestSha256,
        );
        if (manifest === undefined) {
          refuse(
            "conflict",
            `runs.${input.draftId}.suiteQuote`,
            "Inspect task select cannot wear the Inspect eval suite name",
          );
        }
        runState = requireRunState(context.workspaceDir, input.draftId);
        if (runState.runSha256 === undefined) {
          refuse("conflict", `runs.${input.draftId}`, "Inspect View export requires a sealed Run");
        }
        runSha256 = runState.runSha256;
        const quote = runState.suiteQuote;
        if (quote === undefined) {
          refuse("conflict", `runs.${input.draftId}.suiteQuote`, "Inspect View export requires a quoted run; this draft carries no suite quote");
        }
        // The PLANNED k of the sealed Run, not the sealed selection's `suite.replicates` — an
        // over- or under-run must not be judged against its own replicate count (see
        // methodBitsFromInspect).
        const runRecord = parseRun(getSealedBytes(context.workspaceDir, runSha256));
        matrix = runState.matrixSha256 === undefined
          ? undefined
          : parseMatrix(getSealedBytes(context.workspaceDir, runState.matrixSha256));
        const assessed = matrix === undefined
          ? { executionConformance: quote.executionConformance, coverage: quote.coverage, leaderboardSubmitReady: false }
          : suiteComparabilityForInspectArm({
            manifest,
            replicates: runRecord.replicates,
            matrix,
            armId: input.armId,
          });
        const decided = decideInspectViewExportMode(assessed);
        if (decided === "refused") {
          refuse(
            "conflict",
            `runs.${input.draftId}.suiteQuote`,
            quote.coverage === "custom"
              ? "custom coverage cannot wear the Inspect eval suite name"
              : "execution was not protocol-conforming; suite-named Inspect View export is refused",
          );
        }
        mode = decided;
      }
      const logs: Array<{ readonly sha256: string; readonly bytes: Uint8Array }> = [];
      for (const entry of readRunJournalEntries(context.workspaceDir, input.draftId)) {
        if (entry.kind !== "delivery") continue;
        if (parseCellKey(entry.cellKey).armId !== input.armId) continue;
        for (const output of entry.outputs) {
          if (output.name !== "inspect-log") continue;
          logs.push({ sha256: output.sha256, bytes: getSealedBytes(context.workspaceDir, output.sha256) });
        }
      }
      if (logs.length === 0) {
        refuse("not-found", `runs.${input.draftId}.inspect.logs.${input.armId}`, "no sealed Inspect .eval logs were retained for this arm");
      }
      const exportDir = join(artifactsDir(context.workspaceDir), "inspect", "view-bundle", input.draftId, input.armId);
      rmSync(exportDir, { recursive: true, force: true });
      mkdirSync(exportDir, { recursive: true });
      for (const log of logs) {
        writeFileSync(join(exportDir, `${log.sha256}.eval`), log.bytes);
      }
      const certification = exportCompletenessCertification({
        runSha256,
        completeness: matrix?.completeness,
      });
      const instructions = inspectViewExportInstructions(certification, mode, exportDir, lane);
      writeFileSync(join(exportDir, "INSTRUCTIONS.txt"), `${instructions}\n`, { mode: 0o600 });
      return { mode, instructions, exportDir, logCount: logs.length };
}
