import { existsSync, readdirSync, readFileSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { getSealedBytes, putSealedBytes, sha256Hex } from "../../workspace/sealed-store.js";
import type { HarborSelectionManifest } from "../harbor/manifest.js";
import { PIER_ADAPTER_ID } from "../harbor/manifest.js";
import { resolveHarborMaterial, type HarborRuntimeSelectionRequest } from "../harbor/host.js";
import {
  coverageFromSelectedNames,
  namedSliceTaskNames,
  type SuiteCoverage,
} from "../suite-protocol/manifest.js";
import { computeGitTreeSha } from "./git-tree-sha.js";
import {
  DEEP_SWE_V11_AGENT_ID,
  DEEP_SWE_V11_DATASET_ID,
  DEEP_SWE_V11_DEFAULT_REPLICATES,
  DEEP_SWE_V11_GIT_SHA,
  DEEP_SWE_V11_PROFILE,
  DEEP_SWE_V11_SELECTION_SCHEMA,
  DEEP_SWE_V11_TASK_COUNT,
  DEEP_SWE_V11_TASKS_TREE_SHA,
  DeepSweV11SelectionManifestSchema,
  deepSweV11SelectionBytes,
  type DeepSweV11SelectionManifest,
} from "./manifest.js";

export interface DeepSweV11SelectionRequest {
  readonly executable: string;
  readonly gitSha: string;
  readonly taskMaterialPath: string;
  /**
   * Git tree SHA the caller claims `taskMaterialPath` carries. Selection recomputes the SHA from the
   * bytes and refuses on mismatch. Omit when supplying a sub-slice of the official tree: the computed
   * SHA is sealed as-is and, not being DEEP_SWE_V11_TASKS_TREE_SHA, never wears the leaderboard pin.
   */
  readonly expectedTasksTreeSha?: string;
  readonly coverage?: Exclude<SuiteCoverage, "custom">;
  readonly taskNames?: readonly string[];
  readonly nConcurrent?: number;
  readonly replicates?: number;
  readonly arms: HarborSelectionManifest["arms"];
  readonly environment: HarborSelectionManifest["environment"];
  readonly outputs: HarborSelectionManifest["outputs"];
}

export interface DeepSweV11SelectionResolution {
  readonly profile: DeepSweV11SelectionManifest;
  readonly profileSha256: string;
  readonly harbor: HarborRuntimeSelectionRequest;
  readonly coverage: SuiteCoverage;
  readonly selectedTaskNames: readonly string[];
}

function listTaskDirectoryNames(root: string): string[] {
  const canonical = realpathSync(root);
  const names: string[] = [];
  for (const entry of readdirSync(canonical, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    if (!existsSync(join(canonical, entry.name, "task.toml"))) continue;
    names.push(entry.name);
  }
  return namedSliceTaskNames(names, "full");
}

export function resolveDeepSweV11Selection(workspaceDir: string, input: DeepSweV11SelectionRequest): DeepSweV11SelectionResolution {
  if (input.gitSha !== DEEP_SWE_V11_GIT_SHA) {
    throw new TypeError("DeepSWE v1.1 dataset revision must be the sealed git commit pin, not @latest");
  }
  const replicates = input.replicates ?? DEEP_SWE_V11_DEFAULT_REPLICATES;
  if (!Number.isInteger(replicates) || replicates < DEEP_SWE_V11_DEFAULT_REPLICATES) {
    throw new TypeError("DeepSWE v1.1 requires k ≥ 4 planned trials");
  }
  if (input.environment.type !== "docker" && input.environment.type !== "modal") {
    throw new TypeError("DeepSWE v1.1 environment must be Pier docker or modal");
  }
  for (const arm of input.arms) {
    if (arm.jobAgent.name !== DEEP_SWE_V11_AGENT_ID || arm.agent.id !== DEEP_SWE_V11_AGENT_ID) {
      throw new TypeError("DeepSWE v1.1 arms must use mini-swe-agent; Pier+Claude Code/Codex cannot wear the name");
    }
  }
  const datasetNames = listTaskDirectoryNames(input.taskMaterialPath);
  if (datasetNames.length === 0) throw new TypeError("DeepSWE v1.1 material must contain at least one task directory with task.toml");
  const tasksTreeSha = computeGitTreeSha(input.taskMaterialPath);
  if (input.expectedTasksTreeSha !== undefined && input.expectedTasksTreeSha !== tasksTreeSha) {
    throw new TypeError(`DeepSWE v1.1 material git tree SHA is ${tasksTreeSha}, not the declared ${input.expectedTasksTreeSha}; the official tasks/ pin is ${DEEP_SWE_V11_TASKS_TREE_SHA}`);
  }
  let selectedTaskNames: string[];
  if (input.taskNames !== undefined) {
    if (input.taskNames.length === 0) throw new TypeError("DeepSWE v1.1 custom task list must not be empty");
    selectedTaskNames = [...input.taskNames];
    if (input.coverage !== undefined && coverageFromSelectedNames(datasetNames, selectedTaskNames) !== input.coverage) {
      throw new TypeError("DeepSWE v1.1 task list does not match the named coverage slice");
    }
  } else if (input.coverage !== undefined) {
    selectedTaskNames = namedSliceTaskNames(datasetNames, input.coverage);
  } else {
    throw new TypeError("DeepSWE v1.1 selection requires coverage or an explicit task list");
  }
  const coverage = input.taskNames === undefined && input.coverage !== undefined
    ? input.coverage
    : coverageFromSelectedNames(datasetNames, selectedTaskNames);
  if (coverage === "full" && datasetNames.length !== DEEP_SWE_V11_TASK_COUNT) {
    throw new TypeError(`DeepSWE v1.1 full coverage is the official ${DEEP_SWE_V11_TASK_COUNT}-task tree ${DEEP_SWE_V11_TASKS_TREE_SHA}; this material has ${datasetNames.length} task directories`);
  }
  if (coverage === "full" && tasksTreeSha !== DEEP_SWE_V11_TASKS_TREE_SHA) {
    throw new TypeError(`DeepSWE v1.1 full coverage requires the official tasks/ pin ${DEEP_SWE_V11_TASKS_TREE_SHA}; this material hashes to ${tasksTreeSha}`);
  }
  for (const name of selectedTaskNames) {
    if (!datasetNames.includes(name)) throw new TypeError(`DeepSWE v1.1 selected task ${name} is not in the resolved tasks tree`);
  }

  const harborSource = {
    kind: "dataset" as const,
    input: { path: "tasks" },
    materialPath: input.taskMaterialPath,
    revision: DEEP_SWE_V11_GIT_SHA,
    taskName: selectedTaskNames[0]!,
    taskNames: selectedTaskNames,
  };
  const resolved = resolveHarborMaterial(harborSource);
  for (const name of selectedTaskNames) {
    if (!resolved.files.some((file) => file.path === `${name}/task.toml`)) {
      throw new TypeError(`DeepSWE v1.1 material must contain the selected task package ${name}`);
    }
  }
  const canonicalRoot = realpathSync(input.taskMaterialPath);
  for (const file of resolved.files) {
    const bytes = new Uint8Array(readFileSync(join(canonicalRoot, file.path)));
    if (bytes.byteLength !== file.bytes || sha256Hex(bytes) !== file.sha256) throw new TypeError(`DeepSWE v1.1 material changed while sealing ${file.path}`);
    if (putSealedBytes(workspaceDir, bytes) !== file.sha256) throw new TypeError(`DeepSWE v1.1 CAS refused ${file.path}`);
  }
  const nConcurrent = input.nConcurrent ?? 1;
  const profile = DeepSweV11SelectionManifestSchema.parse({
    schema: DEEP_SWE_V11_SELECTION_SCHEMA,
    dataset: {
      id: DEEP_SWE_V11_DATASET_ID,
      gitSha: DEEP_SWE_V11_GIT_SHA,
      tasksTreeSha,
      taskCount: datasetNames.length,
    },
    coverage,
    selectedTaskNames,
    datasetProjectionChecksum: resolved.checksum,
    execution: {
      source: "dataset",
      nTasks: selectedTaskNames.length,
      nAttempts: replicates,
      nConcurrent,
      maxRetries: 3,
      jobGrain: "per-arm",
      agent: DEEP_SWE_V11_AGENT_ID,
    },
  });
  const profileSha256 = sha256Hex(deepSweV11SelectionBytes(profile));
  return {
    profile,
    profileSha256,
    coverage,
    selectedTaskNames,
    harbor: {
      executable: input.executable,
      engine: PIER_ADAPTER_ID,
      source: harborSource,
      arms: input.arms,
      environment: input.environment,
      outputs: input.outputs,
      retryPolicy: { nAttempts: replicates, nConcurrent, maxRetries: 3 },
      jobGrain: "per-arm",
      profiles: { [DEEP_SWE_V11_PROFILE]: profile },
    },
  };
}

export function readSealedDeepSweV11Profile(workspaceDir: string, profileSha256: string): DeepSweV11SelectionManifest {
  return DeepSweV11SelectionManifestSchema.parse(JSON.parse(new TextDecoder("utf8", { fatal: true }).decode(getSealedBytes(workspaceDir, profileSha256))));
}
