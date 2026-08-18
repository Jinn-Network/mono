import { createHash } from "node:crypto";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { refuse } from "../../errors.js";
import { SWE_BENCH_VERIFIED_DATASET_ID, SWE_BENCH_VERIFIED_DEFAULT_TIMEOUT_SECONDS, type SwebenchVerifiedSelectionManifest } from "./manifest.js";
import { harnessReportPath, readHarnessReport } from "./reports.js";
import type { SwebenchVerifiedHostBinding } from "./host.js";

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

export function resolveSwebenchHarnessRunId(reportRoot: string, runSha256: string): string {
  const sidecar = swebenchHarnessRunIdPath(reportRoot);
  if (!existsSync(sidecar)) return runSha256.slice(0, 32);
  const value = readFileSync(sidecar, "utf8").trim();
  if (!/^[a-f0-9]{32}$/u.test(value)) {
    refuse("record-integrity", "swebench.harness.run_id", "harness run_id sidecar is not a 32-hex digest");
  }
  return value;
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
  const version = execFileSync(executable, ["--version"], {
    encoding: "utf8",
    env: { PATH: process.env.PATH ?? "" },
  }).trim().replace(/^swebench\s+/iu, "").replace(/^swebench\.harness\s+/iu, "");
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
    env: { PATH: process.env.PATH ?? "", COLOPHON_SWEBENCH_REPORT_ROOT: input.reportRoot },
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
