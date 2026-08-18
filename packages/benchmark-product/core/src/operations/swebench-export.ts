/** Package predictions.jsonl + harness reports for SWE-bench Verified. Never places the swebench.com row. */
import { parseMatrix } from "@jinn-network/benchmarking-records";
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { refuse } from "../errors.js";
import { resolveSwebenchHarnessRunId, swebenchModelNameOrPath, swebenchPredictionsPath } from "../runtime/swe-bench-verified/launcher.js";
import {
  SWE_BENCH_HARNESS_ADAPTER_ID,
  SwebenchVerifiedSelectionManifestSchema,
} from "../runtime/swe-bench-verified/manifest.js";
import {
  SWE_BENCH_VERIFIED_SUBMIT_CLOSED_SENTENCE,
  type SuiteCoverage,
} from "../runtime/suite-protocol/comparability.js";
import { suiteComparabilityForSwebenchArm } from "../runtime/suite-protocol/from-swebench.js";
import { artifactsDir } from "../workspace/layout.js";
import { getSealedBytes } from "../workspace/sealed-store.js";
import type { OperationContext } from "./context.js";
import { readDraftDocument } from "./drafts.js";
import { operate } from "./operate.js";
import type { OperationResult } from "./result.js";
import { requireRunState } from "../run/state.js";

export type SwebenchPredictionsExportMode = "leaderboard-submit" | "inspection-upload";

export interface ExportSwebenchPredictionsInput {
  readonly draftId: string;
  readonly armId: string;
}

export interface ExportSwebenchPredictionsResult {
  readonly mode: SwebenchPredictionsExportMode;
  readonly instructions: string;
  readonly exportDir: string;
}

export function decideSwebenchPredictionsExportMode(input: {
  readonly executionConformance: boolean;
  readonly coverage: SuiteCoverage;
  readonly leaderboardSubmitReady: boolean;
}): SwebenchPredictionsExportMode | "refused" {
  if (!input.executionConformance || input.coverage === "custom") return "refused";
  if (input.leaderboardSubmitReady) return "leaderboard-submit";
  return "inspection-upload";
}

export function swebenchPredictionsExportInstructions(mode: SwebenchPredictionsExportMode, exportDir: string): string {
  if (mode === "leaderboard-submit") {
    return [
      "The locked SWE-bench Verified method produced predictions that can be submitted.",
      `python -m swebench.harness.run_evaluation --predictions_path ${join(exportDir, "predictions.jsonl")}`,
      "Then, if you use sb-cli:",
      `sb submit ${join(exportDir, "predictions.jsonl")}`,
      SWE_BENCH_VERIFIED_SUBMIT_CLOSED_SENTENCE,
    ].join("\n");
  }
  return [
    "This run matches SWE-bench Verified execution settings for the selected named slice, but it is not a leaderboard submission.",
    `You may inspect the predictions and harness reports in ${exportDir}`,
    "Do not run `sb submit` for this package; it is not leaderboard_submit_ready.",
    SWE_BENCH_VERIFIED_SUBMIT_CLOSED_SENTENCE,
  ].join("\n");
}

export function exportSwebenchPredictions(
  context: OperationContext,
  input: ExportSwebenchPredictionsInput,
): OperationResult<ExportSwebenchPredictionsResult> {
  return operate({
    context,
    action: "runtime.swebench.predictions-export",
    subject: input.draftId,
    inputs: input,
    run: () => {
      const document = readDraftDocument(context.workspaceDir, input.draftId);
      if (!document.spec.arms.some((arm) => arm.armId === input.armId)) {
        refuse("not-found", `drafts.${input.draftId}.spec.arms.${input.armId}`, "draft has no such arm");
      }
      if (document.spec.evaluationRuntime?.adapterId !== SWE_BENCH_HARNESS_ADAPTER_ID) {
        refuse("conflict", `drafts.${input.draftId}.evaluationRuntime`, "SWE-bench Verified export requires a locked swebench-harness runtime");
      }
      const runState = requireRunState(context.workspaceDir, input.draftId);
      if (runState.runSha256 === undefined) {
        refuse("conflict", `runs.${input.draftId}`, "SWE-bench Verified predictions export requires a sealed Run");
      }
      const quote = runState.suiteQuote;
      if (quote === undefined) {
        refuse("conflict", `runs.${input.draftId}.suiteQuote`, "suite-named predictions export requires a SWE-bench Verified protocol selection");
      }
      const manifest = SwebenchVerifiedSelectionManifestSchema.parse(
        JSON.parse(new TextDecoder("utf8", { fatal: true }).decode(getSealedBytes(context.workspaceDir, document.spec.evaluationRuntime.selectionManifestSha256))),
      );
      const reportRoot = join(artifactsDir(context.workspaceDir), "swebench-harness", input.draftId);
      const runId = resolveSwebenchHarnessRunId(reportRoot, runState.runSha256);
      const arm = document.spec.arms.find((candidate) => candidate.armId === input.armId)!;
      const modelNameOrPath = swebenchModelNameOrPath(arm);
      const bits = runState.matrixSha256 === undefined
        ? { executionConformance: quote.executionConformance, coverage: quote.coverage, leaderboardSubmitReady: false }
        : suiteComparabilityForSwebenchArm({
          manifest,
          matrix: parseMatrix(getSealedBytes(context.workspaceDir, runState.matrixSha256)),
          armId: input.armId,
          reportRoot,
          runId,
          modelNameOrPath,
        });
      const mode = decideSwebenchPredictionsExportMode(bits);
      if (mode === "refused") {
        refuse(
          "conflict",
          `runs.${input.draftId}.suiteQuote`,
          quote.coverage === "custom"
            ? "custom coverage cannot wear the SWE-bench Verified suite name"
            : "execution was not protocol-conforming; suite-named predictions export is refused",
        );
      }
      const exportDir = join(artifactsDir(context.workspaceDir), "swebench-export", input.draftId, input.armId);
      rmSync(exportDir, { recursive: true, force: true });
      mkdirSync(exportDir, { recursive: true });
      const predictionsPath = swebenchPredictionsPath(reportRoot);
      if (existsSync(predictionsPath)) {
        writeFileSync(join(exportDir, "predictions.jsonl"), readFileSync(predictionsPath));
      }
      const logs = join(reportRoot, "logs");
      if (existsSync(logs)) cpSync(logs, join(exportDir, "logs"), { recursive: true });
      const instructions = swebenchPredictionsExportInstructions(mode, exportDir);
      writeFileSync(join(exportDir, "INSTRUCTIONS.txt"), `${instructions}\n`, { mode: 0o600 });
      return { mode, instructions, exportDir };
    },
  });
}
