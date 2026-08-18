/** Package a retained Pier Job for DeepSWE v1.1 Datacurve email. Never places the row. */
import { parseMatrix } from "@jinn-network/benchmarking-records";
import { cpSync, existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { refuse } from "../errors.js";
import { harborArmJobName } from "../runtime/harbor/launcher.js";
import { HarborSelectionManifestSchema, PIER_ADAPTER_ID } from "../runtime/harbor/manifest.js";
import { harborArmJobsDir } from "../runtime/harbor/arm-job.js";
import {
  DEEPSWE_CLOSED_SUBMIT_SENTENCE,
  type SuiteCoverage,
} from "../runtime/suite-protocol/comparability.js";
import { suiteComparabilityForArm, suiteSelectionFromHarbor } from "../runtime/suite-protocol/from-harbor.js";
import { artifactsDir } from "../workspace/layout.js";
import { getSealedBytes } from "../workspace/sealed-store.js";
import type { OperationContext } from "./context.js";
import { readDraftDocument } from "./drafts.js";
import { operate } from "./operate.js";
import type { OperationResult } from "./result.js";
import { requireRunState } from "../run/state.js";

export type DeepSweExportMode = "ready" | "inspection";

export interface ExportDeepSwePackageInput {
  readonly draftId: string;
  readonly armId: string;
}

export interface ExportDeepSwePackageResult {
  readonly mode: DeepSweExportMode;
  readonly instructions: string;
  readonly jobDir: string;
  readonly exportDir: string;
}

export function decideDeepSweExportMode(input: {
  readonly executionConformance: boolean;
  readonly coverage: SuiteCoverage;
  readonly leaderboardSubmitReady: boolean;
}): DeepSweExportMode | "refused" {
  if (!input.executionConformance || input.coverage === "custom") return "refused";
  if (input.leaderboardSubmitReady) return "ready";
  return "inspection";
}

export function deepSweExportInstructions(mode: DeepSweExportMode, jobDir: string): string {
  if (mode === "ready") {
    return [
      "The locked DeepSWE v1.1 method produced a Pier job that can be emailed to Datacurve.",
      `Retain this job tree: ${jobDir}`,
      "Email serena@datacurve.ai with the derived Pier inspection artifact.",
      DEEPSWE_CLOSED_SUBMIT_SENTENCE,
    ].join("\n");
  }
  return [
    "This run matches DeepSWE v1.1 execution settings for the selected named slice, but it is not a leaderboard submission.",
    `You may retain the Pier job for inspection: ${jobDir}`,
    "Do not email this package as a Datacurve leaderboard submission; it is not leaderboard_submit_ready.",
    DEEPSWE_CLOSED_SUBMIT_SENTENCE,
  ].join("\n");
}

export function exportDeepSwePackage(
  context: OperationContext,
  input: ExportDeepSwePackageInput,
): OperationResult<ExportDeepSwePackageResult> {
  return operate({
    context,
    action: "runtime.deep-swe-v1.1.export",
    subject: input.draftId,
    inputs: input,
    run: () => {
      const document = readDraftDocument(context.workspaceDir, input.draftId);
      if (!document.spec.arms.some((arm) => arm.armId === input.armId)) {
        refuse("not-found", `drafts.${input.draftId}.spec.arms.${input.armId}`, "draft has no such arm");
      }
      if (document.spec.evaluationRuntime?.adapterId !== PIER_ADAPTER_ID) {
        refuse("conflict", `drafts.${input.draftId}.evaluationRuntime`, "DeepSWE export requires a locked Pier runtime");
      }
      const runState = requireRunState(context.workspaceDir, input.draftId);
      if (runState.runSha256 === undefined) {
        refuse("conflict", `runs.${input.draftId}`, "DeepSWE export requires a sealed Run");
      }
      const quote = runState.suiteQuote;
      if (quote === undefined) {
        refuse("conflict", `runs.${input.draftId}.suiteQuote`, "suite-named DeepSWE export requires a DeepSWE v1.1 protocol selection");
      }
      const manifest = HarborSelectionManifestSchema.parse(
        JSON.parse(new TextDecoder("utf8", { fatal: true }).decode(getSealedBytes(context.workspaceDir, document.spec.evaluationRuntime.selectionManifestSha256))),
      );
      const suite = suiteSelectionFromHarbor(manifest);
      if (suite === undefined || suite.protocol !== "deep-swe-v1.1") {
        refuse("conflict", `runs.${input.draftId}.suiteQuote`, "suite-named DeepSWE export requires a DeepSWE v1.1 protocol selection");
      }
      const jobDir = join(harborArmJobsDir(context.workspaceDir, runState.runSha256), harborArmJobName(runState.runSha256, input.armId));
      const assessed = runState.matrixSha256 === undefined
        ? { executionConformance: quote.executionConformance, coverage: quote.coverage, leaderboardSubmitReady: false }
        : suiteComparabilityForArm({
          manifest,
          matrix: parseMatrix(getSealedBytes(context.workspaceDir, runState.matrixSha256)),
          armId: input.armId,
          jobDir,
        }) ?? { executionConformance: quote.executionConformance, coverage: quote.coverage, leaderboardSubmitReady: false };
      const mode = decideDeepSweExportMode(assessed);
      if (mode === "refused") {
        refuse(
          "conflict",
          `runs.${input.draftId}.suiteQuote`,
          quote.coverage === "custom"
            ? "custom coverage cannot wear the DeepSWE v1.1 suite name"
            : "execution was not protocol-conforming; suite-named DeepSWE export is refused",
        );
      }
      if (!existsSync(join(jobDir, "result.json"))) {
        refuse("not-found", `runs.${input.draftId}.pier.jobs.${input.armId}`, "Pier Job for this arm was not retained");
      }
      const exportDir = join(artifactsDir(context.workspaceDir), "pier", "deepswe-export", input.draftId, input.armId);
      rmSync(exportDir, { recursive: true, force: true });
      mkdirSync(exportDir, { recursive: true });
      cpSync(jobDir, join(exportDir, "job"), { recursive: true });
      const instructions = deepSweExportInstructions(mode, join(exportDir, "job"));
      writeFileSync(join(exportDir, "INSTRUCTIONS.txt"), `${instructions}\n`);
      return { mode, instructions, jobDir, exportDir };
    },
  });
}
