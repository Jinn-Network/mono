import { readFileSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { putSealedBytes, sha256Hex } from "../../workspace/sealed-store.js";
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
  TERMINAL_BENCH_3_0_DATASET_ID,
  TERMINAL_BENCH_3_0_DATASET_REF,
  TERMINAL_BENCH_3_0_HUB_VERSION,
  TERMINAL_BENCH_3_0_PROFILE,
  TerminalBench30RegistryMetadataSchema,
  TerminalBench30SelectionManifestSchema,
  terminalBench30SelectionBytes,
  type TerminalBench30SelectionManifest,
} from "./manifest.js";

export interface TerminalBench30SelectionRequest {
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

export interface TerminalBench30SelectionResolution {
  readonly profile: TerminalBench30SelectionManifest;
  readonly profileSha256: string;
  readonly harbor: HarborRuntimeSelectionRequest;
  readonly coverage: SuiteCoverage;
  readonly selectedTaskNames: readonly string[];
}

function sealMaterial(workspaceDir: string, root: string, material: HarborSelectionManifest["source"]["resolved"]): TerminalBenchMaterial {
  const canonicalRoot = realpathSync(root);
  for (const file of material.files) {
    const bytes = new Uint8Array(readFileSync(join(canonicalRoot, file.path)));
    if (bytes.byteLength !== file.bytes || sha256Hex(bytes) !== file.sha256) throw new TypeError(`Terminal-Bench 3.0 material changed while sealing ${file.path}`);
    if (putSealedBytes(workspaceDir, bytes) !== file.sha256) throw new TypeError(`Terminal-Bench 3.0 CAS refused ${file.path}`);
  }
  return { checksum: material.checksum, files: material.files };
}

export function resolveTerminalBench30Selection(workspaceDir: string, input: TerminalBench30SelectionRequest): TerminalBench30SelectionResolution {
  const revision = input.datasetRevision.trim();
  if (revision === "@latest" || revision === "latest" || /@latest$/iu.test(revision)) {
    throw new TypeError("Terminal-Bench 3.0 refuses @latest; pin an immutable sha256 registry revision");
  }
  if (!/^sha256:[a-f0-9]{64}$/u.test(revision)) {
    throw new TypeError("Terminal-Bench 3.0 dataset revision must be an immutable sha256 registry revision");
  }
  // DR-2026-08-18 decision 1: the 3.0 dataset id is ROLLING (`terminal-bench/terminal-bench`,
  // not a version-scoped id like 2.1's), so a later Hub snapshot satisfies every structural
  // gate below. Only the sealed official pin may wear `terminal-bench-3.0`; a later Hub
  // version is a new pin (Issue + constant bump), never a silent select.
  if (revision !== TERMINAL_BENCH_3_0_DATASET_REF) {
    throw new TypeError(`Terminal-Bench 3.0 selects only the official pin ${TERMINAL_BENCH_3_0_DATASET_REF} (Hub version ${TERMINAL_BENCH_3_0_HUB_VERSION}); got ${revision}. The dataset id ${TERMINAL_BENCH_3_0_DATASET_ID} is rolling, so a later Hub version is a new pin (Issue + constant bump), never a silent select`);
  }
  const registryBytes = new Uint8Array(readFileSync(realpathSync(input.registryMetadataPath)));
  let metadata: unknown;
  try { metadata = JSON.parse(new TextDecoder("utf8", { fatal: true }).decode(registryBytes)); }
  catch { throw new TypeError("Terminal-Bench 3.0 registry snapshot must be UTF-8 JSON"); }
  const parsed = TerminalBench30RegistryMetadataSchema.parse(metadata);
  if (parsed.version !== undefined && parsed.version !== TERMINAL_BENCH_3_0_HUB_VERSION) {
    throw new TypeError(`Terminal-Bench 3.0 registry snapshot names Hub version ${parsed.version}; the official pin ${TERMINAL_BENCH_3_0_DATASET_REF} is Hub version ${TERMINAL_BENCH_3_0_HUB_VERSION}`);
  }
  const contentHash = parsed.dataset_version_content_hash.replace(/^sha256:/u, "");
  if (`sha256:${contentHash}` !== revision) throw new TypeError("Terminal-Bench 3.0 registry revision drifted from the selected immutable dataset revision");
  const datasetNames = parsed.task_ids.map((task) => task.name);
  if (new Set(datasetNames).size !== datasetNames.length) throw new TypeError("Terminal-Bench 3.0 registry snapshot has duplicate task names");
  let selectedTaskNames: string[];
  if (input.taskNames !== undefined) {
    if (input.taskNames.length === 0) throw new TypeError("Terminal-Bench 3.0 custom task list must not be empty");
    selectedTaskNames = [...input.taskNames];
    if (input.coverage !== undefined && coverageFromSelectedNames(datasetNames, selectedTaskNames) !== input.coverage) {
      throw new TypeError("Terminal-Bench 3.0 task list does not match the named coverage slice");
    }
  } else if (input.coverage !== undefined) {
    selectedTaskNames = namedSliceTaskNames(datasetNames, input.coverage);
  } else {
    throw new TypeError("Terminal-Bench 3.0 selection requires coverage or an explicit task list");
  }
  const coverage = input.taskNames === undefined && input.coverage !== undefined
    ? input.coverage
    : coverageFromSelectedNames(datasetNames, selectedTaskNames);
  for (const name of selectedTaskNames) {
    const matches = parsed.task_ids.filter((task) => task.name === name);
    if (matches.length !== 1) throw new TypeError(`Terminal-Bench 3.0 selected task ${name} must occur exactly once in the resolved dataset metadata`);
  }

  const harborSource = {
    kind: "dataset" as const,
    input: { name: TERMINAL_BENCH_3_0_DATASET_ID, ref: revision },
    materialPath: input.taskMaterialPath,
    revision,
    taskName: selectedTaskNames[0]!,
    taskNames: selectedTaskNames,
  };
  const resolved = resolveHarborMaterial(harborSource);
  for (const name of selectedTaskNames) {
    const tomls = resolved.files.filter((file) => file.path === `${name}/task.toml`);
    if (tomls.length !== 1) throw new TypeError(`Terminal-Bench 3.0 material must contain the selected task package ${name}`);
  }
  sealMaterial(workspaceDir, input.taskMaterialPath, resolved);
  const selectedTasks = selectedTaskNames.map((name) => {
    const taskRevision = parsed.task_ids.find((task) => task.name === name)!.ref;
    const packageHash = computeHarbor021TaskContentHash(join(realpathSync(input.taskMaterialPath), name));
    if (`sha256:${packageHash.contentHash}` !== taskRevision) {
      throw new TypeError("Terminal-Bench 3.0 task ref does not match Harbor 0.21 Packager.compute_content_hash over the selected package bytes");
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
  const profile = TerminalBench30SelectionManifestSchema.parse({
    schema: "jinn.network/benchmark-product/terminal-bench-3-0-selection/1",
    dataset: {
      id: TERMINAL_BENCH_3_0_DATASET_ID,
      revision,
      // Not a fallback: the two checks above proved `revision` IS the official pin and that
      // any `version` the snapshot carries equals the constant. The pin constant is defined
      // as the Hub content hash of version 3.0.0, so stamping the constant here records a
      // fact about the selected dataset rather than copying a foreign snapshot's claim.
      hubVersion: TERMINAL_BENCH_3_0_HUB_VERSION,
      registrySnapshotSha256,
      registrySnapshotBytes: registryBytes.byteLength,
      taskCount: parsed.task_ids.length,
    },
    coverage,
    selectedTasks,
    datasetProjectionChecksum: resolved.checksum,
    execution: { source: "dataset", nTasks: selectedTasks.length, nAttempts: 5, nConcurrent, maxRetries: 3, jobGrain: "per-arm" },
  });
  const profileSha256 = sha256Hex(terminalBench30SelectionBytes(profile));
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
      retryPolicy: { nAttempts: 5, nConcurrent, maxRetries: 3 },
      jobGrain: "per-arm",
      profiles: { [TERMINAL_BENCH_3_0_PROFILE]: profile },
    },
  };
}
