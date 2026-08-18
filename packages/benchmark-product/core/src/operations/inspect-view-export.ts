/** Derived Inspect View bundle from correlated per-cell .eval logs. Not Hub. Not the claim of record. */
import { parseCellKey, parseMatrix } from "@jinn-network/benchmarking-records";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { refuse } from "../errors.js";
import { readInspectEvalSelectionManifest } from "../runtime/inspect/host.js";
import {
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
import { requireRunState } from "../run/state.js";

export type InspectViewExportMode = "suite-named" | "inspection-upload";

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

export function inspectViewExportInstructions(mode: InspectViewExportMode, exportDir: string): string {
  if (mode === "suite-named") {
    return [
      "The locked Inspect eval method produced correlated per-cell .eval logs.",
      `inspect view --log-dir ${exportDir}`,
      "inspect view bundle --bundle-dir <out> can wrap this log dir for Inspect View.",
      INSPECT_EVAL_SUBMIT_CLOSED_SENTENCE,
    ].join("\n");
  }
  return [
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
    run: () => {
      const document = readDraftDocument(context.workspaceDir, input.draftId);
      if (!document.spec.arms.some((arm) => arm.armId === input.armId)) {
        refuse("not-found", `drafts.${input.draftId}.spec.arms.${input.armId}`, "draft has no such arm");
      }
      if (document.spec.evaluationRuntime?.adapterId !== "inspect") {
        refuse("conflict", `drafts.${input.draftId}.evaluationRuntime`, "Inspect View export requires a locked Inspect runtime");
      }
      const manifest = readInspectEvalSelectionManifest(
        context.workspaceDir,
        document.spec.evaluationRuntime.selectionManifestSha256,
      );
      if (manifest === undefined) {
        refuse(
          "conflict",
          `runs.${input.draftId}.suiteQuote`,
          "Inspect task select cannot wear the Inspect eval suite name",
        );
      }
      const runState = requireRunState(context.workspaceDir, input.draftId);
      if (runState.runSha256 === undefined) {
        refuse("conflict", `runs.${input.draftId}`, "Inspect View export requires a sealed Run");
      }
      const quote = runState.suiteQuote;
      if (quote === undefined) {
        refuse("conflict", `runs.${input.draftId}.suiteQuote`, "suite-named Inspect View export requires an Inspect eval protocol selection");
      }
      const assessed = runState.matrixSha256 === undefined
        ? { executionConformance: quote.executionConformance, coverage: quote.coverage, leaderboardSubmitReady: false }
        : suiteComparabilityForInspectArm({
          manifest,
          matrix: parseMatrix(getSealedBytes(context.workspaceDir, runState.matrixSha256)),
          armId: input.armId,
        });
      const mode = decideInspectViewExportMode(assessed);
      if (mode === "refused") {
        refuse(
          "conflict",
          `runs.${input.draftId}.suiteQuote`,
          quote.coverage === "custom"
            ? "custom coverage cannot wear the Inspect eval suite name"
            : "execution was not protocol-conforming; suite-named Inspect View export is refused",
        );
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
      const instructions = inspectViewExportInstructions(mode, exportDir);
      writeFileSync(join(exportDir, "INSTRUCTIONS.txt"), `${instructions}\n`, { mode: 0o600 });
      return { mode, instructions, exportDir, logCount: logs.length };
    },
  });
}
