import { createHash } from "node:crypto";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { refuse } from "../../errors.js";
import { ARCHIPELAGO_COMMIT_PIN, type ApexAgentsSelectionManifest } from "./manifest.js";
import { archipelagoGradePath, readArchipelagoGrade } from "./grades.js";
import type { ApexAgentsHostBinding } from "./host.js";

export function archipelagoRunId(runSha256: string, taskIdsSha256: string): string {
  return createHash("sha256").update(`${runSha256}:${taskIdsSha256}`).digest("hex").slice(0, 32);
}

export function archipelagoModelId(arm: { readonly armId: string; readonly pinning: Readonly<Record<string, unknown>> }): string {
  const model = arm.pinning.model;
  if (model !== null && typeof model === "object" && "id" in model && typeof model.id === "string" && model.id.length > 0) {
    return model.id;
  }
  return arm.armId;
}

export function archipelagoModelIdByArm(
  arms: readonly { readonly armId: string; readonly pinning: Readonly<Record<string, unknown>> }[],
): Record<string, string> {
  return Object.fromEntries(arms.map((arm) => [arm.armId, archipelagoModelId(arm)]));
}

export function archipelagoRunIdPath(reportRoot: string): string {
  return join(reportRoot, "grading_run_id");
}

/** Canonical digest of the graded task ids, in the order the selection sealed them. */
export function archipelagoTaskIdsSha256(taskIds: readonly string[]): string {
  return createHash("sha256").update(taskIds.join("\n")).digest("hex");
}

/**
 * DR-2026-08-17-e decision 4: the grading_run_id is derived from the sealed Run and the graded
 * task ids, never read from the operator. A sidecar is accepted only when it equals the
 * derivation, so a pre-existing cached grade tree cannot be pointed at.
 */
export function resolveArchipelagoRunId(
  reportRoot: string,
  runSha256: string,
  taskIds: readonly string[],
): string {
  const derived = archipelagoRunId(runSha256, archipelagoTaskIdsSha256(taskIds));
  const sidecar = archipelagoRunIdPath(reportRoot);
  if (existsSync(sidecar) && readFileSync(sidecar, "utf8").trim() !== derived) {
    refuse(
      "record-integrity",
      "archipelago.grading_run_id",
      "Archipelago grading_run_id sidecar does not equal the run id derived from the sealed Run and task ids",
    );
  }
  return derived;
}

export function launchArchipelago(input: {
  readonly manifest: ApexAgentsSelectionManifest;
  readonly binding: ApexAgentsHostBinding;
  readonly reportRoot: string;
  readonly runId: string;
  readonly taskIds: readonly string[];
}): void {
  const executable = realpathSync(input.binding.executable);
  const executableDigest = createHash("sha256").update(readFileSync(executable)).digest("hex");
  if (executableDigest !== input.manifest.archipelago.executableSha256) {
    refuse("record-integrity", "archipelago.executable", "Archipelago executable bytes drifted from the sealed selection");
  }
  const version = execFileSync(executable, ["--version"], {
    encoding: "utf8",
    env: { PATH: process.env.PATH ?? "" },
  }).trim().replace(/^archipelago\s+/iu, "");
  if (version !== input.manifest.archipelago.commit || version !== ARCHIPELAGO_COMMIT_PIN) {
    refuse("record-integrity", "archipelago.commit", "Archipelago commit drifted from the sealed selection");
  }
  mkdirSync(input.reportRoot, { recursive: true });
  const spawned = spawnSync(executable, ["grade", "--grading-run-id", input.runId, "--task-ids", ...input.taskIds], {
    cwd: input.reportRoot,
    encoding: "utf8",
    env: { PATH: process.env.PATH ?? "", COLOPHON_APEX_REPORT_ROOT: input.reportRoot },
  });
  if (spawned.status !== 0) {
    refuse(
      "execution",
      "archipelago.grade",
      spawned.stderr?.trim() || spawned.stdout?.trim() || `Archipelago exited ${spawned.status ?? "null"}`,
    );
  }
  writeFileSync(archipelagoRunIdPath(input.reportRoot), `${input.runId}\n`);
}

export function collectArchipelagoCells(input: {
  readonly reportRoot: string;
  readonly taskIds: readonly string[];
}): readonly { readonly taskId: string; readonly passed: boolean | undefined; readonly outcome: "judged" | "unscorable" }[] {
  return input.taskIds.map((taskId) => {
    const report = readArchipelagoGrade(archipelagoGradePath({ reportRoot: input.reportRoot, taskId }));
    if (report === undefined) return { taskId, passed: undefined, outcome: "unscorable" as const };
    return { taskId, passed: report.passed, outcome: "judged" as const };
  });
}
