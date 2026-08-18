import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readFileSync, realpathSync } from "node:fs";
import { z } from "zod";
import { atomicWriteFileSync, readFileIfExistsSync } from "../../fs/atomic.js";
import { runtimeHostPath } from "../../workspace/layout.js";
import { putSealedBytes, sha256Hex } from "../../workspace/sealed-store.js";
import {
  APEX_AGENTS_DEFAULT_MAX_STEPS,
  APEX_AGENTS_DEFAULT_TIMEOUT_SECONDS,
  APEX_AGENTS_JUDGE_MODEL,
  APEX_AGENTS_JUDGE_THINKING,
  APEX_AGENTS_REACT_AGENT_ID,
} from "../suite-protocol/comparability.js";
import { coverageFromSelectedNames, namedSliceTaskNames, type SuiteCoverage } from "../suite-protocol/manifest.js";
import {
  APEX_AGENTS_DATASET_ID,
  APEX_AGENTS_DATASET_REVISION,
  ARCHIPELAGO_ADAPTER_ID,
  ARCHIPELAGO_COMMIT_PIN,
  ApexAgentsRegistryMetadataSchema,
  assertSupportedArchipelagoCommit,
  type ApexAgentsSelectionManifest,
} from "./manifest.js";

export interface ApexAgentsSelectionRequest {
  readonly executable: string;
  readonly registryMetadataPath: string;
  readonly coverage?: Exclude<SuiteCoverage, "custom">;
  readonly taskIds?: readonly string[];
  readonly arms: readonly { readonly armId: string; readonly modelId: string }[];
}

export interface ApexAgentsSelectionResolution {
  readonly coverage: SuiteCoverage;
  readonly selectedTaskIds: readonly string[];
  readonly dataset: ApexAgentsSelectionManifest["dataset"];
  readonly archipelago: ApexAgentsSelectionManifest["archipelago"];
  readonly binding: ApexAgentsHostBinding;
}

export const ApexAgentsHostBindingSchema = z.object({
  executable: z.string().min(1),
}).strict();
export type ApexAgentsHostBinding = z.infer<typeof ApexAgentsHostBindingSchema>;

function probeArchipelagoCommit(executable: string): string {
  const stdout = execFileSync(realpathSync(executable), ["--version"], {
    encoding: "utf8",
    env: { PATH: process.env.PATH ?? "" },
  }).trim();
  const commit = stdout.replace(/^archipelago\s+/iu, "");
  return assertSupportedArchipelagoCommit(commit);
}

export function resolveApexAgentsSelection(
  workspaceDir: string,
  input: ApexAgentsSelectionRequest,
): ApexAgentsSelectionResolution {
  const executable = realpathSync(input.executable);
  const executableSha256 = createHash("sha256").update(readFileSync(executable)).digest("hex");
  const commit = probeArchipelagoCommit(executable);
  const registryBytes = new Uint8Array(readFileSync(realpathSync(input.registryMetadataPath)));
  let metadata: unknown;
  try { metadata = JSON.parse(new TextDecoder("utf8", { fatal: true }).decode(registryBytes)); }
  catch { throw new TypeError("APEX-Agents registry snapshot must be UTF-8 JSON"); }
  const parsed = ApexAgentsRegistryMetadataSchema.parse(metadata);
  if (parsed.revision !== APEX_AGENTS_DATASET_REVISION) {
    throw new TypeError("APEX-Agents registry revision drifted from the sealed HuggingFace pin");
  }
  const datasetNames = parsed.task_ids;
  if (new Set(datasetNames).size !== datasetNames.length) {
    throw new TypeError("APEX-Agents registry snapshot has duplicate task ids");
  }
  let selectedTaskIds: string[];
  if (input.taskIds !== undefined) {
    if (input.taskIds.length === 0) throw new TypeError("APEX-Agents custom task list must not be empty");
    selectedTaskIds = [...input.taskIds];
    if (input.coverage !== undefined && coverageFromSelectedNames(datasetNames, selectedTaskIds) !== input.coverage) {
      throw new TypeError("APEX-Agents task list does not match the named coverage slice");
    }
  } else if (input.coverage !== undefined) {
    selectedTaskIds = namedSliceTaskNames(datasetNames, input.coverage);
  } else {
    throw new TypeError("APEX-Agents selection requires coverage or an explicit task list");
  }
  const coverage = input.taskIds === undefined && input.coverage !== undefined
    ? input.coverage
    : coverageFromSelectedNames(datasetNames, selectedTaskIds);
  for (const name of selectedTaskIds) {
    if (datasetNames.filter((id) => id === name).length !== 1) {
      throw new TypeError(`APEX-Agents selected task ${name} must occur exactly once in the resolved dataset metadata`);
    }
  }
  if (input.arms.length === 0) throw new TypeError("APEX-Agents selection requires at least one arm");
  const registrySnapshotSha256 = putSealedBytes(workspaceDir, registryBytes);
  return {
    coverage,
    selectedTaskIds,
    dataset: {
      id: APEX_AGENTS_DATASET_ID,
      revision: APEX_AGENTS_DATASET_REVISION,
      registrySnapshotSha256,
      registrySnapshotBytes: registryBytes.byteLength,
      taskCount: datasetNames.length,
    },
    archipelago: {
      adapterId: ARCHIPELAGO_ADAPTER_ID,
      commit,
      executableSha256,
      agentId: APEX_AGENTS_REACT_AGENT_ID,
      maxSteps: APEX_AGENTS_DEFAULT_MAX_STEPS,
      timeoutSeconds: APEX_AGENTS_DEFAULT_TIMEOUT_SECONDS,
      judgeModel: APEX_AGENTS_JUDGE_MODEL,
      judgeThinking: APEX_AGENTS_JUDGE_THINKING,
      webSearch: false,
      timeoutOverride: false,
      resourceOverride: false,
    },
    binding: { executable },
  };
}

export function writeApexAgentsHostBinding(
  workspaceDir: string,
  selectionManifestSha256: string,
  binding: ApexAgentsHostBinding,
): void {
  atomicWriteFileSync(
    runtimeHostPath(workspaceDir, selectionManifestSha256),
    JSON.stringify(ApexAgentsHostBindingSchema.parse(binding), null, 2),
  );
}

export function readApexAgentsHostBinding(
  workspaceDir: string,
  selectionManifestSha256: string,
): ApexAgentsHostBinding {
  const bytes = readFileIfExistsSync(runtimeHostPath(workspaceDir, selectionManifestSha256));
  if (bytes === undefined) throw new TypeError("APEX-Agents host binding is missing");
  return ApexAgentsHostBindingSchema.parse(JSON.parse(new TextDecoder("utf8", { fatal: true }).decode(bytes)));
}

export function sealApexAgentsSelectionDependencies(
  workspaceDir: string,
  resolution: ApexAgentsSelectionResolution,
): void {
  const executableBytes = new Uint8Array(readFileSync(realpathSync(resolution.binding.executable)));
  if (sha256Hex(executableBytes) !== resolution.archipelago.executableSha256
    || putSealedBytes(workspaceDir, executableBytes) !== resolution.archipelago.executableSha256) {
    throw new TypeError("APEX-Agents Archipelago executable bytes do not match the sealed selection");
  }
}
