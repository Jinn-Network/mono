import { readFileSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { getSealedBytes, putSealedBytes, sha256Hex } from "../../workspace/sealed-store.js";
import type { HarborSelectionManifest } from "../harbor/manifest.js";
import { resolveHarborMaterial, type HarborRuntimeSelectionRequest } from "../harbor/host.js";
import { computeHarbor021TaskContentHash } from "../terminal-bench-2/host.js";
import { HARBOR_021_PACKAGER_ALGORITHM, type TerminalBenchMaterial } from "../terminal-bench-2/manifest.js";
import {
  coverageFromSelectedNames,
  namedSliceTaskNames,
  type SuiteCoverage,
} from "../suite-protocol/manifest.js";
import {
  TERMINAL_BENCH_2_1_DATASET_ID,
  TERMINAL_BENCH_2_1_PROFILE,
  TerminalBench21RegistryMetadataSchema,
  TerminalBench21SelectionManifestSchema,
  terminalBench21SelectionBytes,
  type TerminalBench21SelectionManifest,
} from "./manifest.js";

export interface TerminalBench21SelectionRequest {
  readonly executable: string;
  readonly registryMetadataPath: string;
  readonly datasetRevision: `sha256:${string}`;
  readonly taskMaterialPath: string;
  readonly coverage?: Exclude<SuiteCoverage, "custom">;
  readonly taskNames?: readonly string[];
  readonly nConcurrent?: number;
  readonly arms: HarborSelectionManifest["arms"];
  readonly environment: HarborSelectionManifest["environment"];
  readonly outputs: HarborSelectionManifest["outputs"];
}

export interface TerminalBench21SelectionResolution {
  readonly profile: TerminalBench21SelectionManifest;
  readonly profileSha256: string;
  readonly harbor: HarborRuntimeSelectionRequest;
  readonly coverage: SuiteCoverage;
  readonly selectedTaskNames: readonly string[];
}

function sealMaterial(workspaceDir: string, root: string, material: HarborSelectionManifest["source"]["resolved"]): TerminalBenchMaterial {
  const canonicalRoot = realpathSync(root);
  for (const file of material.files) {
    const bytes = new Uint8Array(readFileSync(join(canonicalRoot, file.path)));
    if (bytes.byteLength !== file.bytes || sha256Hex(bytes) !== file.sha256) throw new TypeError(`Terminal-Bench 2.1 material changed while sealing ${file.path}`);
    if (putSealedBytes(workspaceDir, bytes) !== file.sha256) throw new TypeError(`Terminal-Bench 2.1 CAS refused ${file.path}`);
  }
  return { checksum: material.checksum, files: material.files };
}

export function resolveTerminalBench21Selection(workspaceDir: string, input: TerminalBench21SelectionRequest): TerminalBench21SelectionResolution {
  if (!/^sha256:[a-f0-9]{64}$/u.test(input.datasetRevision)) throw new TypeError("Terminal-Bench 2.1 dataset revision must be an immutable sha256 registry revision");
  const registryBytes = new Uint8Array(readFileSync(realpathSync(input.registryMetadataPath)));
  let metadata: unknown;
  try { metadata = JSON.parse(new TextDecoder("utf8", { fatal: true }).decode(registryBytes)); }
  catch { throw new TypeError("Terminal-Bench 2.1 registry snapshot must be UTF-8 JSON"); }
  const parsed = TerminalBench21RegistryMetadataSchema.parse(metadata);
  const contentHash = parsed.dataset_version_content_hash.replace(/^sha256:/u, "");
  if (`sha256:${contentHash}` !== input.datasetRevision) throw new TypeError("Terminal-Bench 2.1 registry revision drifted from the selected immutable dataset revision");
  const datasetNames = parsed.task_ids.map((task) => task.name);
  if (new Set(datasetNames).size !== datasetNames.length) throw new TypeError("Terminal-Bench 2.1 registry snapshot has duplicate task names");
  let selectedTaskNames: string[];
  if (input.taskNames !== undefined) {
    if (input.taskNames.length === 0) throw new TypeError("Terminal-Bench 2.1 custom task list must not be empty");
    selectedTaskNames = [...input.taskNames];
    if (input.coverage !== undefined && coverageFromSelectedNames(datasetNames, selectedTaskNames) !== input.coverage) {
      throw new TypeError("Terminal-Bench 2.1 task list does not match the named coverage slice");
    }
  } else if (input.coverage !== undefined) {
    selectedTaskNames = namedSliceTaskNames(datasetNames, input.coverage);
  } else {
    throw new TypeError("Terminal-Bench 2.1 selection requires coverage or an explicit task list");
  }
  const coverage = coverageFromSelectedNames(datasetNames, selectedTaskNames);
  for (const name of selectedTaskNames) {
    const matches = parsed.task_ids.filter((task) => task.name === name);
    if (matches.length !== 1) throw new TypeError(`Terminal-Bench 2.1 selected task ${name} must occur exactly once in the resolved dataset metadata`);
  }

  const harborSource = {
    kind: "dataset" as const,
    input: { name: TERMINAL_BENCH_2_1_DATASET_ID, ref: input.datasetRevision },
    materialPath: input.taskMaterialPath,
    revision: input.datasetRevision,
    taskName: selectedTaskNames[0]!,
    taskNames: selectedTaskNames,
  };
  const resolved = resolveHarborMaterial(harborSource);
  for (const name of selectedTaskNames) {
    const tomls = resolved.files.filter((file) => file.path === `${name}/task.toml`);
    if (tomls.length !== 1) throw new TypeError(`Terminal-Bench 2.1 material must contain the selected task package ${name}`);
  }
  sealMaterial(workspaceDir, input.taskMaterialPath, resolved);
  const selectedTasks = selectedTaskNames.map((name) => {
    const taskRevision = parsed.task_ids.find((task) => task.name === name)!.ref;
    const packageHash = computeHarbor021TaskContentHash(join(realpathSync(input.taskMaterialPath), name));
    if (`sha256:${packageHash.contentHash}` !== taskRevision) {
      throw new TypeError("Terminal-Bench 2.1 task ref does not match Harbor 0.21 Packager.compute_content_hash over the selected package bytes");
    }
    const taskRoot = join(realpathSync(input.taskMaterialPath), name);
    const taskResolved = resolveHarborMaterial({ input: { name: `terminal-bench/${name}`, ref: taskRevision }, materialPath: taskRoot, revision: taskRevision });
    const material = sealMaterial(workspaceDir, taskRoot, taskResolved);
    return {
      package: { name: `terminal-bench/${name}`, ref: taskRevision },
      contentHashAlgorithm: HARBOR_021_PACKAGER_ALGORITHM,
      filter: name,
      material,
    };
  });
  const registrySnapshotSha256 = putSealedBytes(workspaceDir, registryBytes);
  const nConcurrent = input.nConcurrent ?? 5;
  const profile = TerminalBench21SelectionManifestSchema.parse({
    schema: "jinn.network/benchmark-product/terminal-bench-2-1-selection/1",
    dataset: {
      id: TERMINAL_BENCH_2_1_DATASET_ID,
      revision: input.datasetRevision,
      registrySnapshotSha256,
      registrySnapshotBytes: registryBytes.byteLength,
      taskCount: parsed.task_ids.length,
    },
    coverage,
    selectedTasks,
    datasetProjectionChecksum: resolved.checksum,
    execution: { source: "dataset", nTasks: selectedTasks.length, nAttempts: 5, nConcurrent, maxRetries: 0, jobGrain: "per-arm" },
  });
  const profileSha256 = sha256Hex(terminalBench21SelectionBytes(profile));
  return {
    profile,
    profileSha256,
    coverage,
    selectedTaskNames,
    harbor: {
      executable: input.executable,
      source: harborSource,
      arms: input.arms,
      environment: input.environment,
      outputs: input.outputs,
      retryPolicy: { nAttempts: 5, nConcurrent, maxRetries: 0 },
      jobGrain: "per-arm",
      profiles: { [TERMINAL_BENCH_2_1_PROFILE]: profile },
    },
  };
}

export function readSealedTerminalBench21Profile(workspaceDir: string, profileSha256: string): TerminalBench21SelectionManifest {
  return TerminalBench21SelectionManifestSchema.parse(JSON.parse(new TextDecoder("utf8", { fatal: true }).decode(getSealedBytes(workspaceDir, profileSha256))));
}
