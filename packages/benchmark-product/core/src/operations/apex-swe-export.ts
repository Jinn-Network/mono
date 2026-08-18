/** Package Mercor harness JSON for APEX-SWE-dev. Never places a Mercor APEX-SWE leaderboard row. */
import { parseMatrix } from "@jinn-network/benchmarking-records";
import { cpSync, existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { refuse } from "../errors.js";
import { apexSweDevReportRoot } from "../runtime/apex-swe-dev/launcher.js";
import {
  APEX_SWE_DEV_ADAPTER_ID,
  ApexSweDevSelectionManifestSchema,
} from "../runtime/apex-swe-dev/manifest.js";
import {
  APEX_SWE_DEV_SUBMIT_CLOSED_SENTENCE,
  type SuiteCoverage,
} from "../runtime/suite-protocol/comparability.js";
import { suiteComparabilityForApexSweDevArm } from "../runtime/suite-protocol/from-apex.js";
import { artifactsDir } from "../workspace/layout.js";
import { getSealedBytes } from "../workspace/sealed-store.js";
import type { OperationContext } from "./context.js";
import { readDraftDocument } from "./drafts.js";
import { operate } from "./operate.js";
import type { OperationResult } from "./result.js";
import { requireRunState } from "../run/state.js";

export type ApexSweExportMode = "inspection-upload";

export interface ExportApexSwePackageInput {
  readonly draftId: string;
  readonly armId: string;
}

export interface ExportApexSwePackageResult {
  readonly mode: ApexSweExportMode;
  readonly instructions: string;
  readonly exportDir: string;
}

export function decideApexSweExportMode(input: {
  readonly executionConformance: boolean;
  readonly coverage: SuiteCoverage;
  readonly leaderboardSubmitReady: boolean;
}): ApexSweExportMode | "refused" {
  if (input.leaderboardSubmitReady) return "refused";
  if (!input.executionConformance || input.coverage === "custom") return "refused";
  return "inspection-upload";
}

export function apexSweExportInstructions(exportDir: string): string {
  return [
    "This run matches APEX-SWE-dev execution settings for the selected named slice of the public 50-task set.",
    `You may inspect the Mercor harness JSON and logs in ${exportDir}`,
    "Do not claim a Mercor APEX-SWE leaderboard row; APEX-SWE-dev cannot wear the 200-task board.",
    APEX_SWE_DEV_SUBMIT_CLOSED_SENTENCE,
  ].join("\n");
}

export function exportApexSwePackage(
  context: OperationContext,
  input: ExportApexSwePackageInput,
): OperationResult<ExportApexSwePackageResult> {
  return operate({
    context,
    action: "runtime.apex-swe.export",
    subject: input.draftId,
    inputs: input,
    run: () => {
      const document = readDraftDocument(context.workspaceDir, input.draftId);
      if (!document.spec.arms.some((arm) => arm.armId === input.armId)) {
        refuse("not-found", `drafts.${input.draftId}.spec.arms.${input.armId}`, "draft has no such arm");
      }
      if (document.spec.evaluationRuntime?.adapterId !== APEX_SWE_DEV_ADAPTER_ID) {
        refuse("conflict", `drafts.${input.draftId}.evaluationRuntime`, "APEX-SWE-dev export requires a locked apex-swe-dev runtime");
      }
      const runState = requireRunState(context.workspaceDir, input.draftId);
      const quote = runState.suiteQuote;
      if (quote === undefined) {
        refuse("conflict", `runs.${input.draftId}.suiteQuote`, "suite-named APEX-SWE-dev export requires a protocol selection");
      }
      const manifest = ApexSweDevSelectionManifestSchema.parse(
        JSON.parse(new TextDecoder("utf8", { fatal: true }).decode(getSealedBytes(context.workspaceDir, document.spec.evaluationRuntime.selectionManifestSha256))),
      );
      if (manifest.suite.protocol !== "apex-swe-dev") {
        refuse("conflict", `runs.${input.draftId}.suiteQuote`, "suite-named APEX-SWE-dev export requires protocol apex-swe-dev");
      }
      const reportRoot = apexSweDevReportRoot(artifactsDir(context.workspaceDir), input.draftId);
      const bits = runState.matrixSha256 === undefined
        ? { executionConformance: quote.executionConformance, coverage: quote.coverage, leaderboardSubmitReady: false as const }
        : suiteComparabilityForApexSweDevArm({
          manifest,
          matrix: parseMatrix(getSealedBytes(context.workspaceDir, runState.matrixSha256)),
          armId: input.armId,
          reportRoot,
        });
      const mode = decideApexSweExportMode(bits);
      if (mode === "refused") {
        refuse(
          "conflict",
          `runs.${input.draftId}.suiteQuote`,
          quote.coverage === "custom"
            ? "custom coverage cannot wear the APEX-SWE-dev suite name"
            : "execution was not protocol-conforming, or this package tried to wear APEX-SWE leaderboard-submit; suite-named export is refused",
        );
      }
      const exportDir = join(artifactsDir(context.workspaceDir), "apex-swe-export", input.draftId, input.armId);
      rmSync(exportDir, { recursive: true, force: true });
      mkdirSync(exportDir, { recursive: true });
      if (existsSync(reportRoot)) cpSync(reportRoot, join(exportDir, "harness"), { recursive: true });
      const instructions = apexSweExportInstructions(exportDir);
      writeFileSync(join(exportDir, "INSTRUCTIONS.txt"), `${instructions}\n`, { mode: 0o600 });
      return { mode, instructions, exportDir };
    },
  });
}
