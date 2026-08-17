/** Package a retained Harbor Job for Terminal-Bench 2.1 Hub upload. Never places the row. */
import { parseMatrix } from "@jinn-network/benchmarking-records";
import { cpSync, existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { refuse } from "../errors.js";
import { harborArmJobName } from "../runtime/harbor/launcher.js";
import { HarborSelectionManifestSchema } from "../runtime/harbor/manifest.js";
import { harborArmJobsDir } from "../runtime/harbor/arm-job.js";
import {
  COMMUNITY_SUBMISSIONS_CLOSED_SENTENCE,
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

export type HarborHubExportMode = "leaderboard-submit" | "inspection-upload";

export interface ExportHarborHubPackageInput {
  readonly draftId: string;
  readonly armId: string;
}

export interface ExportHarborHubPackageResult {
  readonly mode: HarborHubExportMode;
  readonly instructions: string;
  readonly jobDir: string;
  readonly exportDir: string;
}

export function decideHarborHubExportMode(input: {
  readonly executionConformance: boolean;
  readonly coverage: SuiteCoverage;
  readonly leaderboardSubmitReady: boolean;
}): HarborHubExportMode | "refused" {
  if (!input.executionConformance || input.coverage === "custom") return "refused";
  if (input.leaderboardSubmitReady) return "leaderboard-submit";
  return "inspection-upload";
}

export function harborHubExportInstructions(mode: HarborHubExportMode, jobDir: string): string {
  if (mode === "leaderboard-submit") {
    return [
      "The locked Terminal-Bench 2.1 method produced a Harbor job that can be uploaded.",
      `harbor upload --public ${jobDir}`,
      "Then, from the Terminal-Bench 2.1 leaderboard/ tree:",
      "uv run lb submit <hub-url>",
      COMMUNITY_SUBMISSIONS_CLOSED_SENTENCE,
    ].join("\n");
  }
  return [
    "This run matches Terminal-Bench 2.1 execution settings for the selected named slice, but it is not a leaderboard submission.",
    `You may upload the job for inspection: harbor upload --public ${jobDir}`,
    "Do not run `uv run lb submit` for this package; it is not leaderboard_submit_ready.",
    COMMUNITY_SUBMISSIONS_CLOSED_SENTENCE,
  ].join("\n");
}

export function exportHarborHubPackage(
  context: OperationContext,
  input: ExportHarborHubPackageInput,
): OperationResult<ExportHarborHubPackageResult> {
  return operate({
    context,
    action: "runtime.harbor.hub-export",
    subject: input.draftId,
    inputs: input,
    run: () => {
      const document = readDraftDocument(context.workspaceDir, input.draftId);
      if (!document.spec.arms.some((arm) => arm.armId === input.armId)) {
        refuse("not-found", `drafts.${input.draftId}.spec.arms.${input.armId}`, "draft has no such arm");
      }
      if (document.spec.evaluationRuntime?.adapterId !== "harbor") {
        refuse("conflict", `drafts.${input.draftId}.evaluationRuntime`, "Hub export requires a locked Harbor runtime");
      }
      const runState = requireRunState(context.workspaceDir, input.draftId);
      if (runState.runSha256 === undefined) {
        refuse("conflict", `runs.${input.draftId}`, "Hub export requires a sealed Run");
      }
      const quote = runState.suiteQuote;
      if (quote === undefined) {
        refuse("conflict", `runs.${input.draftId}.suiteQuote`, "suite-named Hub export requires a Terminal-Bench 2.1 protocol selection");
      }
      const manifest = HarborSelectionManifestSchema.parse(
        JSON.parse(new TextDecoder("utf8", { fatal: true }).decode(getSealedBytes(context.workspaceDir, document.spec.evaluationRuntime.selectionManifestSha256))),
      );
      if (suiteSelectionFromHarbor(manifest) === undefined) {
        refuse("conflict", `runs.${input.draftId}.suiteQuote`, "suite-named Hub export requires a Terminal-Bench 2.1 protocol selection");
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
      const mode = decideHarborHubExportMode(assessed);
      if (mode === "refused") {
        refuse(
          "conflict",
          `runs.${input.draftId}.suiteQuote`,
          quote.coverage === "custom"
            ? "custom coverage cannot wear the Terminal-Bench 2.1 Hub suite name"
            : "execution was not protocol-conforming; suite-named Hub export is refused",
        );
      }
      if (!existsSync(join(jobDir, "result.json"))) {
        refuse("not-found", `runs.${input.draftId}.harbor.jobs.${input.armId}`, "Harbor Job for this arm was not retained");
      }
      const exportDir = join(artifactsDir(context.workspaceDir), "harbor", "hub-export", input.draftId, input.armId);
      rmSync(exportDir, { recursive: true, force: true });
      mkdirSync(exportDir, { recursive: true });
      cpSync(jobDir, join(exportDir, "job"), { recursive: true });
      const instructions = harborHubExportInstructions(mode, join(exportDir, "job"));
      writeFileSync(join(exportDir, "INSTRUCTIONS.txt"), `${instructions}\n`, { mode: 0o600 });
      return { mode, instructions, jobDir, exportDir };
    },
  });
}
