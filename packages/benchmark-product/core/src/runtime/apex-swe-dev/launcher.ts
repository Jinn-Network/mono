import { createHash } from "node:crypto";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, realpathSync } from "node:fs";
import { dirname, join } from "node:path";
import { refuse } from "../../errors.js";
import type { ApexSweDevHostBinding } from "./host.js";
import {
  APEX_SWE_DEV_DEFAULT_TIMEOUT_SECONDS,
  APEX_SWE_DEV_MESSAGE_LIMIT,
  APEX_SWE_DEV_N_TRIALS,
  type ApexSweDevSelectionManifest,
  type ApexSweDevTaskType,
} from "./manifest.js";
import { harnessReportPath, readHarnessReport } from "./reports.js";
import { inheritedTempEnv } from "../child-temp-env.js";

export function apexSweDevReportRoot(artifactsRoot: string, draftId: string): string {
  return join(artifactsRoot, "apex-swe-dev", draftId);
}

function fileSha256(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function assertSealedHosts(manifest: ApexSweDevSelectionManifest, binding: ApexSweDevHostBinding): void {
  const apx = realpathSync(binding.apxExecutable);
  const python = realpathSync(binding.pythonExecutable);
  if (fileSha256(apx) !== manifest.harness.apxExecutableSha256) {
    refuse("record-integrity", "apex-swe-dev.apx", "apx executable bytes drifted from the sealed selection");
  }
  if (fileSha256(python) !== manifest.harness.pythonExecutableSha256) {
    refuse("record-integrity", "apex-swe-dev.python", "python executable bytes drifted from the sealed selection");
  }
  const apxVersion = execFileSync(apx, ["--version"], {
    encoding: "utf8",
    env: { ...inheritedTempEnv(), PATH: process.env.PATH ?? "" },
  }).trim().replace(/^apx\s+/iu, "");
  if (apxVersion !== manifest.harness.apxVersion) {
    refuse("record-integrity", "apex-swe-dev.apx.version", "apx version drifted from the sealed selection");
  }
  const inspectAiVersion = execFileSync(python, ["-c", "import inspect_ai; print(inspect_ai.__version__)"], {
    encoding: "utf8",
    env: { ...inheritedTempEnv(), PATH: process.env.PATH ?? "" },
  }).trim();
  if (inspectAiVersion !== manifest.harness.inspectAiVersion) {
    refuse("record-integrity", "apex-swe-dev.inspect_ai.version", "inspect_ai version drifted from the sealed selection");
  }
}

function launchIntegration(input: {
  readonly binding: ApexSweDevHostBinding;
  readonly reportRoot: string;
  readonly taskId: string;
  readonly modelNameOrPath: string;
}): void {
  const outputDir = dirname(harnessReportPath({ reportRoot: input.reportRoot, taskId: input.taskId, taskType: "integration" }));
  mkdirSync(outputDir, { recursive: true });
  const args = [
    "run",
    input.taskId,
    "--tasks",
    input.taskId,
    "--n-trials",
    String(APEX_SWE_DEV_N_TRIALS),
    "--timeout",
    String(APEX_SWE_DEV_DEFAULT_TIMEOUT_SECONDS),
    "--tasks-dir",
    input.binding.integrationTasksDir,
    "--runs-dir",
    outputDir,
    "--models",
    input.modelNameOrPath,
  ];
  const spawned = spawnSync(realpathSync(input.binding.apxExecutable), args, {
    cwd: outputDir,
    encoding: "utf8",
    env: { ...inheritedTempEnv(), PATH: process.env.PATH ?? "", COLOPHON_APEX_SWE_DEV_REPORT_ROOT: input.reportRoot },
  });
  if (spawned.status !== 0) {
    refuse(
      "execution",
      "apex-swe-dev.apx.run",
      spawned.stderr?.trim() || spawned.stdout?.trim() || `apx exited ${spawned.status ?? "null"}`,
    );
  }
}

function launchObservability(input: {
  readonly binding: ApexSweDevHostBinding;
  readonly reportRoot: string;
  readonly taskId: string;
  readonly modelNameOrPath: string;
}): void {
  const outputPath = harnessReportPath({ reportRoot: input.reportRoot, taskId: input.taskId, taskType: "observability" });
  mkdirSync(dirname(outputPath), { recursive: true });
  const runE2e = join(input.binding.observabilityProjectDir, "run_e2e.py");
  const args = [
    runE2e,
    "--task",
    input.taskId,
    "--trial",
    String(APEX_SWE_DEV_N_TRIALS),
    "--time-limit",
    String(APEX_SWE_DEV_DEFAULT_TIMEOUT_SECONDS),
    "--message-limit",
    String(APEX_SWE_DEV_MESSAGE_LIMIT),
    "--output",
    outputPath,
    "--model",
    input.modelNameOrPath,
  ];
  const spawned = spawnSync(realpathSync(input.binding.pythonExecutable), args, {
    cwd: input.binding.observabilityProjectDir,
    encoding: "utf8",
    env: { ...inheritedTempEnv(), PATH: process.env.PATH ?? "", COLOPHON_APEX_SWE_DEV_REPORT_ROOT: input.reportRoot },
  });
  if (spawned.status !== 0) {
    refuse(
      "execution",
      "apex-swe-dev.run_e2e",
      spawned.stderr?.trim() || spawned.stdout?.trim() || `run_e2e.py exited ${spawned.status ?? "null"}`,
    );
  }
}

export function launchApexSweDev(input: {
  readonly manifest: ApexSweDevSelectionManifest;
  readonly binding: ApexSweDevHostBinding;
  readonly reportRoot: string;
  readonly modelNameOrPath: string;
  readonly tasks?: readonly { readonly taskId: string; readonly taskType: ApexSweDevTaskType }[];
}): void {
  assertSealedHosts(input.manifest, input.binding);
  mkdirSync(input.reportRoot, { recursive: true });
  const tasks = input.tasks ?? input.manifest.selectedTasks;
  for (const task of tasks) {
    if (task.taskType === "integration") {
      launchIntegration({
        binding: input.binding,
        reportRoot: input.reportRoot,
        taskId: task.taskId,
        modelNameOrPath: input.modelNameOrPath,
      });
    } else {
      launchObservability({
        binding: input.binding,
        reportRoot: input.reportRoot,
        taskId: task.taskId,
        modelNameOrPath: input.modelNameOrPath,
      });
    }
  }
}

export function collectApexSweDevCells(input: {
  readonly reportRoot: string;
  readonly tasks: readonly { readonly taskId: string; readonly taskType: ApexSweDevTaskType }[];
}): readonly { readonly taskId: string; readonly passed: boolean | undefined; readonly outcome: "judged" | "unscorable" }[] {
  return input.tasks.map((task) => {
    const path = harnessReportPath({ reportRoot: input.reportRoot, taskId: task.taskId, taskType: task.taskType });
    const report = readHarnessReport(path, task.taskId, task.taskType);
    if (report === undefined) return { taskId: task.taskId, passed: undefined, outcome: "unscorable" as const };
    return { taskId: task.taskId, passed: report.passed, outcome: "judged" as const };
  });
}
