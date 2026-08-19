import { basename, join, sep } from "node:path";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, realpathSync, statSync } from "node:fs";
import { z } from "zod";
import { atomicWriteFileSync, readFileIfExistsSync } from "../../fs/atomic.js";
import { runtimeHostPath } from "../../workspace/layout.js";
import { putSealedBytes, sha256Hex } from "../../workspace/sealed-store.js";
import { coverageFromSelectedNames, namedSliceTaskNames, type SuiteCoverage } from "../suite-protocol/manifest.js";
import {
  APEX_SWE_DEV_ADAPTER_ID,
  APEX_SWE_DEV_DATASET_ID,
  APEX_SWE_DEV_DATASET_REVISION,
  APEX_SWE_DEV_DEFAULT_TIMEOUT_SECONDS,
  APEX_SWE_DEV_MESSAGE_LIMIT,
  APEX_SWE_DEV_N_TRIALS,
  APEX_SWE_HARNESS_REVISION,
  ApexSweDevRegistryMetadataSchema,
  assertOfficialApexSweDevRegistry,
  type ApexSweDevSelectionManifest,
  type ApexSweDevTaskType,
} from "./manifest.js";

export interface ApexSweDevSelectionRequest {
  readonly apxExecutable: string;
  readonly pythonExecutable: string;
  readonly registryMetadataPath: string;
  readonly integrationTasksDir: string;
  readonly observabilityProjectDir: string;
  readonly coverage?: Exclude<SuiteCoverage, "custom">;
  readonly taskIds?: readonly string[];
  readonly arms: readonly { readonly armId: string; readonly modelNameOrPath: string }[];
}

export interface ApexSweDevSelectionResolution {
  readonly coverage: SuiteCoverage;
  readonly selectedTasks: readonly { readonly taskId: string; readonly taskType: ApexSweDevTaskType }[];
  readonly dataset: ApexSweDevSelectionManifest["dataset"];
  readonly harness: ApexSweDevSelectionManifest["harness"];
  readonly binding: ApexSweDevHostBinding;
}

export const ApexSweDevHostBindingSchema = z.object({
  apxExecutable: z.string().min(1),
  pythonExecutable: z.string().min(1),
  integrationTasksDir: z.string().min(1),
  observabilityProjectDir: z.string().min(1),
}).strict();
export type ApexSweDevHostBinding = z.infer<typeof ApexSweDevHostBindingSchema>;

const GIT_LFS_POINTER_PREFIX = "version https://git-lfs.github.com/spec/v1\n";

export function isGitLfsPointerBytes(bytes: Uint8Array): boolean {
  const head = new TextDecoder("utf8", { fatal: false }).decode(bytes.slice(0, GIT_LFS_POINTER_PREFIX.length));
  return head === GIT_LFS_POINTER_PREFIX;
}

function fileSha256(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function probeApxVersion(executable: string): string {
  const stdout = execFileSync(realpathSync(executable), ["--version"], {
    encoding: "utf8",
    env: { PATH: process.env.PATH ?? "" },
  }).trim();
  if (/^harbor\b/iu.test(stdout) || /\bswebench\b/iu.test(stdout) || /^inspect(?:-ai)?\b/iu.test(stdout)) {
    throw new TypeError("APEX-SWE-dev refuses Harbor, swebench, or Inspect executables as apx");
  }
  return stdout.replace(/^apx\s+/iu, "");
}

/** `python` and `observabilityProjectDir` are already realpaths (`resolveApexSweDevSelection`). */
function isContainedIn(candidate: string, root: string): boolean {
  return candidate === root || candidate.startsWith(root.endsWith(sep) ? root : `${root}${sep}`);
}

function probeInspectAiVersion(python: string, observabilityProjectDir: string): string {
  const base = basename(python);
  if (base === "inspect" || base === "inspect-ai" || base === "harbor" || base === "swebench") {
    throw new TypeError("APEX-SWE-dev observability python must be Mercor's venv interpreter, not Inspect/Harbor/swebench");
  }
  // Containment, not a version/name blocklist: Mercor's observability venv lives inside their own
  // project tree, so any interpreter resolving outside it is by construction a cousin runtime
  // (Colophon's Inspect 0.3.255, a system python, another harness's venv) whatever it is named.
  if (!isContainedIn(python, observabilityProjectDir)) {
    throw new TypeError("APEX-SWE-dev observability python must resolve inside the Mercor observability project directory");
  }
  const stdout = execFileSync(python, ["-c", "import inspect_ai; print(inspect_ai.__version__)"], {
    encoding: "utf8",
    env: { PATH: process.env.PATH ?? "" },
  }).trim();
  if (stdout.length === 0) throw new TypeError("APEX-SWE-dev observability python must import inspect_ai");
  return stdout;
}

function walkFiles(root: string, current = ""): readonly string[] {
  const directory = join(root, current);
  let entries;
  try { entries = readdirSync(directory, { withFileTypes: true }); }
  catch { return []; }
  const files: string[] = [];
  for (const entry of entries) {
    const relative = current === "" ? entry.name : `${current}/${entry.name}`;
    if (entry.isDirectory()) files.push(...walkFiles(root, relative));
    else if (entry.isFile()) files.push(relative);
  }
  return files;
}

function assertNoGitLfsPointers(root: string, label: string): void {
  if (!existsSync(root)) throw new TypeError(`APEX-SWE-dev ${label} path does not exist`);
  if (!statSync(root).isDirectory()) throw new TypeError(`APEX-SWE-dev ${label} must be a directory`);
  for (const relative of walkFiles(root)) {
    const bytes = new Uint8Array(readFileSync(join(root, relative)));
    if (isGitLfsPointerBytes(bytes)) {
      throw new TypeError(`APEX-SWE-dev refuses Git LFS pointer at ${label}/${relative}; materialize the task before select`);
    }
  }
}

export function resolveApexSweDevSelection(
  workspaceDir: string,
  input: ApexSweDevSelectionRequest,
): ApexSweDevSelectionResolution {
  const apxExecutable = realpathSync(input.apxExecutable);
  const pythonExecutable = realpathSync(input.pythonExecutable);
  const integrationTasksDir = realpathSync(input.integrationTasksDir);
  const observabilityProjectDir = realpathSync(input.observabilityProjectDir);
  const apxVersion = probeApxVersion(apxExecutable);
  const inspectAiVersion = probeInspectAiVersion(pythonExecutable, observabilityProjectDir);
  const runE2e = join(observabilityProjectDir, "run_e2e.py");
  if (!existsSync(runE2e)) {
    throw new TypeError("APEX-SWE-dev observability project must contain their run_e2e.py, not Colophon Inspect");
  }
  const registryBytes = new Uint8Array(readFileSync(realpathSync(input.registryMetadataPath)));
  let metadata: unknown;
  try { metadata = JSON.parse(new TextDecoder("utf8", { fatal: true }).decode(registryBytes)); }
  catch { throw new TypeError("APEX-SWE-dev registry snapshot must be UTF-8 JSON"); }
  const parsed = ApexSweDevRegistryMetadataSchema.parse(metadata);
  assertOfficialApexSweDevRegistry(parsed);
  const datasetNames = parsed.tasks.map((task) => task.taskId);
  if (new Set(datasetNames).size !== datasetNames.length) {
    throw new TypeError("APEX-SWE-dev registry snapshot has duplicate task ids");
  }
  const typeById = new Map(parsed.tasks.map((task) => [task.taskId, task.taskType]));
  let selectedTaskIds: string[];
  if (input.taskIds !== undefined) {
    if (input.taskIds.length === 0) throw new TypeError("APEX-SWE-dev custom task list must not be empty");
    selectedTaskIds = [...input.taskIds];
    if (new Set(selectedTaskIds).size !== selectedTaskIds.length) {
      throw new TypeError("APEX-SWE-dev custom task list has duplicate task ids; each task maps onto exactly one cell");
    }
    if (input.coverage !== undefined && coverageFromSelectedNames(datasetNames, selectedTaskIds) !== input.coverage) {
      throw new TypeError("APEX-SWE-dev task list does not match the named coverage slice");
    }
  } else if (input.coverage !== undefined) {
    selectedTaskIds = namedSliceTaskNames(datasetNames, input.coverage);
  } else {
    throw new TypeError("APEX-SWE-dev selection requires coverage or an explicit task list");
  }
  const coverage = input.taskIds === undefined && input.coverage !== undefined
    ? input.coverage
    : coverageFromSelectedNames(datasetNames, selectedTaskIds);
  const selectedTasks = selectedTaskIds.map((taskId) => {
    const taskType = typeById.get(taskId);
    if (taskType === undefined) throw new TypeError(`APEX-SWE-dev selected task ${taskId} must occur exactly once in the resolved dataset metadata`);
    return { taskId, taskType };
  });
  if (input.arms.length === 0) throw new TypeError("APEX-SWE-dev selection requires at least one arm");
  assertNoGitLfsPointers(integrationTasksDir, "integrationTasksDir");
  assertNoGitLfsPointers(observabilityProjectDir, "observabilityProjectDir");
  const registrySnapshotSha256 = putSealedBytes(workspaceDir, registryBytes);
  return {
    coverage,
    selectedTasks,
    dataset: {
      id: APEX_SWE_DEV_DATASET_ID,
      revision: APEX_SWE_DEV_DATASET_REVISION,
      registrySnapshotSha256,
      registrySnapshotBytes: registryBytes.byteLength,
      taskCount: parsed.tasks.length,
    },
    harness: {
      adapterId: APEX_SWE_DEV_ADAPTER_ID,
      revision: APEX_SWE_HARNESS_REVISION,
      apxVersion,
      apxExecutableSha256: fileSha256(apxExecutable),
      inspectAiVersion,
      pythonExecutableSha256: fileSha256(pythonExecutable),
      timeoutSeconds: APEX_SWE_DEV_DEFAULT_TIMEOUT_SECONDS,
      timeoutOverride: false,
      resourceOverride: false,
      nTrials: APEX_SWE_DEV_N_TRIALS,
      messageLimit: APEX_SWE_DEV_MESSAGE_LIMIT,
    },
    binding: {
      apxExecutable,
      pythonExecutable,
      integrationTasksDir,
      observabilityProjectDir,
    },
  };
}

export function writeApexSweDevHostBinding(
  workspaceDir: string,
  selectionManifestSha256: string,
  binding: ApexSweDevHostBinding,
): void {
  atomicWriteFileSync(
    runtimeHostPath(workspaceDir, selectionManifestSha256),
    JSON.stringify(ApexSweDevHostBindingSchema.parse(binding), null, 2),
  );
}

export function readApexSweDevHostBinding(
  workspaceDir: string,
  selectionManifestSha256: string,
): ApexSweDevHostBinding {
  const bytes = readFileIfExistsSync(runtimeHostPath(workspaceDir, selectionManifestSha256));
  if (bytes === undefined) throw new TypeError("APEX-SWE-dev host binding is missing");
  return ApexSweDevHostBindingSchema.parse(JSON.parse(new TextDecoder("utf8", { fatal: true }).decode(bytes)));
}

export function sealApexSweDevSelectionDependencies(
  workspaceDir: string,
  resolution: ApexSweDevSelectionResolution,
): void {
  const apxBytes = new Uint8Array(readFileSync(realpathSync(resolution.binding.apxExecutable)));
  const pythonBytes = new Uint8Array(readFileSync(realpathSync(resolution.binding.pythonExecutable)));
  if (sha256Hex(apxBytes) !== resolution.harness.apxExecutableSha256
    || putSealedBytes(workspaceDir, apxBytes) !== resolution.harness.apxExecutableSha256) {
    throw new TypeError("APEX-SWE-dev apx executable bytes do not match the sealed selection");
  }
  if (sha256Hex(pythonBytes) !== resolution.harness.pythonExecutableSha256
    || putSealedBytes(workspaceDir, pythonBytes) !== resolution.harness.pythonExecutableSha256) {
    throw new TypeError("APEX-SWE-dev python executable bytes do not match the sealed selection");
  }
}
