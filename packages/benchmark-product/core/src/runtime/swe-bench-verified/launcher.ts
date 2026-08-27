import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { refuse } from "../../errors.js";
import { SWE_BENCH_VERIFIED_DATASET_ID, SWE_BENCH_VERIFIED_DEFAULT_TIMEOUT_SECONDS, type SwebenchVerifiedSelectionManifest } from "./manifest.js";
import { harnessReportPath, readHarnessReport } from "./reports.js";
import { readSwebenchModuleVersion, type SwebenchVerifiedHostBinding } from "./host.js";
import { inheritedTempEnv } from "../child-temp-env.js";

export interface SwebenchPredictionRow {
  readonly instance_id: string;
  readonly model_name_or_path: string;
  readonly model_patch: string;
}

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

export function swebenchModelNameOrPathByArm(
  arms: readonly { readonly armId: string; readonly pinning: Readonly<Record<string, unknown>> }[],
): Record<string, string> {
  return Object.fromEntries(arms.map((arm) => [arm.armId, swebenchModelNameOrPath(arm)]));
}

export function swebenchHarnessRunIdPath(reportRoot: string): string {
  return join(reportRoot, "run_id");
}

/** The one location the derived run_id is computed from, and the one the export packages. */
export function swebenchPredictionsPath(reportRoot: string): string {
  return join(reportRoot, "predictions.jsonl");
}

/**
 * DR-2026-08-17-e decision 4: the run_id is derived from the sealed Run and the predictions
 * bytes, never read from the operator. An absent predictions file digests as the empty body
 * `writePredictionsJsonl` writes for zero rows — no harness report tree can exist under that
 * id either way. A sidecar is accepted only when it equals the derivation.
 */
export function resolveSwebenchHarnessRunId(reportRoot: string, runSha256: string): string {
  const predictionsPath = swebenchPredictionsPath(reportRoot);
  const predictionsBytes = existsSync(predictionsPath) ? readFileSync(predictionsPath) : Buffer.alloc(0);
  const derived = swebenchRunId(runSha256, createHash("sha256").update(predictionsBytes).digest("hex"));
  const sidecar = swebenchHarnessRunIdPath(reportRoot);
  if (existsSync(sidecar) && readFileSync(sidecar, "utf8").trim() !== derived) {
    refuse(
      "record-integrity",
      "swebench.harness.run_id",
      "harness run_id sidecar does not equal the run_id derived from the sealed Run and predictions",
    );
  }
  return derived;
}

export function writePredictionsJsonl(path: string, rows: readonly SwebenchPredictionRow[]): string {
  mkdirSync(dirname(path), { recursive: true });
  const body = rows.map((row) => JSON.stringify({
    instance_id: row.instance_id,
    model_name_or_path: row.model_name_or_path,
    model_patch: row.model_patch,
  })).join("\n") + (rows.length > 0 ? "\n" : "");
  writeFileSync(path, body);
  return createHash("sha256").update(body).digest("hex");
}

export function launchSwebenchHarness(input: {
  readonly manifest: SwebenchVerifiedSelectionManifest;
  readonly binding: SwebenchVerifiedHostBinding;
  readonly reportRoot: string;
  readonly predictionsPath: string;
  readonly runId: string;
  readonly instanceIds: readonly string[];
}): void {
  const executable = realpathSync(input.binding.executable);
  const executableDigest = createHash("sha256").update(readFileSync(executable)).digest("hex");
  if (executableDigest !== input.manifest.harness.executableSha256) {
    refuse("record-integrity", "swebench.harness.executable", "harness executable bytes drifted from the sealed selection");
  }
  const version = readSwebenchModuleVersion(executable);
  if (version !== input.manifest.harness.version) {
    refuse("record-integrity", "swebench.harness.version", "harness version drifted from the sealed selection");
  }
  mkdirSync(input.reportRoot, { recursive: true });
  const args = [
    "-m",
    "swebench.harness.run_evaluation",
    "--dataset_name",
    SWE_BENCH_VERIFIED_DATASET_ID,
    "--predictions_path",
    input.predictionsPath,
    "--instance_ids",
    ...input.instanceIds,
    "--run_id",
    input.runId,
    "--timeout",
    String(SWE_BENCH_VERIFIED_DEFAULT_TIMEOUT_SECONDS),
  ];
  const spawned = spawnSync(executable, args, {
    cwd: input.reportRoot,
    encoding: "utf8",
    env: { ...inheritedTempEnv(), PATH: process.env.PATH ?? "", COLOPHON_SWEBENCH_REPORT_ROOT: input.reportRoot },
  });
  if (spawned.status !== 0) {
    refuse(
      "execution",
      "swebench.harness.run_evaluation",
      spawned.stderr?.trim() || spawned.stdout?.trim() || `harness exited ${spawned.status ?? "null"}`,
    );
  }
  writeFileSync(swebenchHarnessRunIdPath(input.reportRoot), `${input.runId}\n`);
}

export function collectSwebenchHarnessCells(input: {
  readonly reportRoot: string;
  readonly runId: string;
  readonly modelNameOrPath: string;
  readonly instanceIds: readonly string[];
}): readonly { readonly instanceId: string; readonly resolved: boolean | undefined; readonly outcome: "judged" | "unscorable" }[] {
  return input.instanceIds.map((instanceId) => {
    const path = harnessReportPath({
      reportRoot: input.reportRoot,
      runId: input.runId,
      modelNameOrPath: input.modelNameOrPath,
      instanceId,
    });
    const report = readHarnessReport(path);
    if (report === undefined) return { instanceId, resolved: undefined, outcome: "unscorable" as const };
    return { instanceId, resolved: report.resolved, outcome: "judged" as const };
  });
}
