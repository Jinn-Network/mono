/** Package Archipelago grades for APEX-Agents inspection. Never places the Mercor row. */
import { parseMatrix } from "@jinn-network/benchmarking-records";
import { cpSync, existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { refuse } from "../errors.js";
import { resolveArchipelagoRunId } from "../runtime/apex-agents/launcher.js";
import {
  ARCHIPELAGO_ADAPTER_ID,
  ApexAgentsSelectionManifestSchema,
} from "../runtime/apex-agents/manifest.js";
import {
  APEX_AGENTS_SUBMIT_CLOSED_SENTENCE,
  type SuiteCoverage,
} from "../runtime/suite-protocol/comparability.js";
import { suiteComparabilityForApexArm } from "../runtime/suite-protocol/from-apex.js";
import { artifactsDir } from "../workspace/layout.js";
import { getSealedBytes } from "../workspace/sealed-store.js";
import type { OperationContext } from "./context.js";
import { readDraftDocument } from "./drafts.js";
import { operate } from "./operate.js";
import type { OperationResult } from "./result.js";
import { requireRunState } from "../run/state.js";

export type ApexAgentsExportMode = "leaderboard-submit" | "inspection-upload";

export interface ExportApexAgentsInput {
  readonly draftId: string;
  readonly armId: string;
}

export interface ExportApexAgentsResult {
  readonly mode: ApexAgentsExportMode;
  readonly instructions: string;
  readonly exportDir: string;
}

export function decideApexAgentsExportMode(input: {
  readonly executionConformance: boolean;
  readonly coverage: SuiteCoverage;
  readonly leaderboardSubmitReady: boolean;
}): ApexAgentsExportMode | "refused" {
  if (!input.executionConformance || input.coverage === "custom") return "refused";
  if (input.leaderboardSubmitReady) return "leaderboard-submit";
  return "inspection-upload";
}

export function apexAgentsExportInstructions(mode: ApexAgentsExportMode, exportDir: string): string {
  if (mode === "leaderboard-submit") {
    return [
      "The locked APEX-Agents method produced a protocol-faithful full-suite bundle.",
      `Inspect trajectories, snapshots, and grades in ${exportDir}`,
      APEX_AGENTS_SUBMIT_CLOSED_SENTENCE,
    ].join("\n");
  }
  return [
    "This run matches APEX-Agents execution settings for the selected named slice, but it is not a leaderboard submission.",
    `You may inspect Archipelago grades in ${exportDir}`,
    "Do not present this package as a Mercor APEX-Agents leaderboard row; it is not leaderboard_submit_ready.",
    APEX_AGENTS_SUBMIT_CLOSED_SENTENCE,
  ].join("\n");
}

export function exportApexAgentsInspection(
  context: OperationContext,
  input: ExportApexAgentsInput,
): OperationResult<ExportApexAgentsResult> {
  return operate({
    context,
    action: "runtime.apex-agents.export",
    subject: input.draftId,
    inputs: input,
    run: () => {
      const document = readDraftDocument(context.workspaceDir, input.draftId);
      if (!document.spec.arms.some((arm) => arm.armId === input.armId)) {
        refuse("not-found", `drafts.${input.draftId}.spec.arms.${input.armId}`, "draft has no such arm");
      }
      if (document.spec.evaluationRuntime?.adapterId !== ARCHIPELAGO_ADAPTER_ID) {
        refuse("conflict", `drafts.${input.draftId}.evaluationRuntime`, "APEX-Agents export requires a locked archipelago runtime");
      }
      const runState = requireRunState(context.workspaceDir, input.draftId);
      if (runState.runSha256 === undefined) {
        refuse("conflict", `runs.${input.draftId}`, "APEX-Agents export requires a sealed Run");
      }
      const quote = runState.suiteQuote;
      if (quote === undefined) {
        refuse("conflict", `runs.${input.draftId}.suiteQuote`, "suite-named APEX-Agents export requires a protocol selection");
      }
      const manifest = ApexAgentsSelectionManifestSchema.parse(
        JSON.parse(new TextDecoder("utf8", { fatal: true }).decode(getSealedBytes(context.workspaceDir, document.spec.evaluationRuntime.selectionManifestSha256))),
      );
      const reportRoot = join(artifactsDir(context.workspaceDir), "archipelago", input.draftId);
      resolveArchipelagoRunId(reportRoot, runState.runSha256, manifest.suite.selectedTaskNames);
      const bits = runState.matrixSha256 === undefined
        ? { executionConformance: quote.executionConformance, coverage: quote.coverage, leaderboardSubmitReady: false }
        : suiteComparabilityForApexArm({
          manifest,
          matrix: parseMatrix(getSealedBytes(context.workspaceDir, runState.matrixSha256)),
          armId: input.armId,
          reportRoot,
        });
      const mode = decideApexAgentsExportMode(bits);
      if (mode === "refused") {
        refuse(
          "conflict",
          `runs.${input.draftId}.suiteQuote`,
          quote.coverage === "custom"
            ? "custom coverage cannot wear the APEX-Agents suite name"
            : "execution was not protocol-conforming; suite-named APEX-Agents export is refused",
        );
      }
      const exportDir = join(artifactsDir(context.workspaceDir), "apex-agents-export", input.draftId, input.armId);
      rmSync(exportDir, { recursive: true, force: true });
      mkdirSync(exportDir, { recursive: true });
      const output = join(reportRoot, "output");
      if (existsSync(output)) cpSync(output, join(exportDir, "output"), { recursive: true });
      const instructions = apexAgentsExportInstructions(mode, exportDir);
      writeFileSync(join(exportDir, "INSTRUCTIONS.txt"), `${instructions}\n`, { mode: 0o600 });
      return { mode, instructions, exportDir };
    },
  });
}
