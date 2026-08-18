import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readFileSync, realpathSync } from "node:fs";
import { z } from "zod";
import { atomicWriteFileSync, readFileIfExistsSync } from "../../fs/atomic.js";
import { runtimeHostPath } from "../../workspace/layout.js";
import { putSealedBytes, sha256Hex } from "../../workspace/sealed-store.js";
import { coverageFromSelectedNames, namedSliceTaskNames, type SuiteCoverage } from "../suite-protocol/manifest.js";
import {
  SWE_BENCH_HARNESS_ADAPTER_ID,
  SWE_BENCH_VERIFIED_DATASET_ID,
  SWE_BENCH_VERIFIED_DATASET_REVISION,
  SWE_BENCH_VERIFIED_DEFAULT_TIMEOUT_SECONDS,
  SwebenchVerifiedRegistryMetadataSchema,
  assertSupportedSwebenchHarnessVersion,
  type SwebenchVerifiedSelectionManifest,
} from "./manifest.js";

export interface SwebenchVerifiedSelectionRequest {
  readonly executable: string;
  readonly registryMetadataPath: string;
  readonly coverage?: Exclude<SuiteCoverage, "custom">;
  readonly instanceIds?: readonly string[];
  readonly arms: readonly { readonly armId: string; readonly modelNameOrPath: string }[];
}

export interface SwebenchVerifiedSelectionResolution {
  readonly coverage: SuiteCoverage;
  readonly selectedInstanceIds: readonly string[];
  readonly dataset: SwebenchVerifiedSelectionManifest["dataset"];
  readonly harness: SwebenchVerifiedSelectionManifest["harness"];
  readonly binding: SwebenchVerifiedHostBinding;
}

export const SwebenchVerifiedHostBindingSchema = z.object({
  executable: z.string().min(1),
}).strict();
export type SwebenchVerifiedHostBinding = z.infer<typeof SwebenchVerifiedHostBindingSchema>;

function probeHarnessVersion(executable: string): string {
  const stdout = execFileSync(realpathSync(executable), ["--version"], {
    encoding: "utf8",
    env: { PATH: process.env.PATH ?? "" },
  }).trim();
  const version = stdout.replace(/^swebench\s+/iu, "").replace(/^swebench\.harness\s+/iu, "");
  return assertSupportedSwebenchHarnessVersion(version);
}

export function resolveSwebenchVerifiedSelection(
  workspaceDir: string,
  input: SwebenchVerifiedSelectionRequest,
): SwebenchVerifiedSelectionResolution {
  const executable = realpathSync(input.executable);
  const executableSha256 = createHash("sha256").update(readFileSync(executable)).digest("hex");
  const version = probeHarnessVersion(executable);
  const registryBytes = new Uint8Array(readFileSync(realpathSync(input.registryMetadataPath)));
  let metadata: unknown;
  try { metadata = JSON.parse(new TextDecoder("utf8", { fatal: true }).decode(registryBytes)); }
  catch { throw new TypeError("SWE-bench Verified registry snapshot must be UTF-8 JSON"); }
  const parsed = SwebenchVerifiedRegistryMetadataSchema.parse(metadata);
  if (parsed.revision !== SWE_BENCH_VERIFIED_DATASET_REVISION) {
    throw new TypeError("SWE-bench Verified registry revision drifted from the sealed HuggingFace pin");
  }
  const datasetNames = parsed.instance_ids;
  if (new Set(datasetNames).size !== datasetNames.length) {
    throw new TypeError("SWE-bench Verified registry snapshot has duplicate instance ids");
  }
  let selectedInstanceIds: string[];
  if (input.instanceIds !== undefined) {
    if (input.instanceIds.length === 0) throw new TypeError("SWE-bench Verified custom instance list must not be empty");
    selectedInstanceIds = [...input.instanceIds];
    if (input.coverage !== undefined && coverageFromSelectedNames(datasetNames, selectedInstanceIds) !== input.coverage) {
      throw new TypeError("SWE-bench Verified instance list does not match the named coverage slice");
    }
  } else if (input.coverage !== undefined) {
    selectedInstanceIds = namedSliceTaskNames(datasetNames, input.coverage);
  } else {
    throw new TypeError("SWE-bench Verified selection requires coverage or an explicit instance list");
  }
  const coverage = input.instanceIds === undefined && input.coverage !== undefined
    ? input.coverage
    : coverageFromSelectedNames(datasetNames, selectedInstanceIds);
  for (const name of selectedInstanceIds) {
    if (datasetNames.filter((id) => id === name).length !== 1) {
      throw new TypeError(`SWE-bench Verified selected instance ${name} must occur exactly once in the resolved dataset metadata`);
    }
  }
  if (input.arms.length === 0) throw new TypeError("SWE-bench Verified selection requires at least one arm");
  const registrySnapshotSha256 = putSealedBytes(workspaceDir, registryBytes);
  return {
    coverage,
    selectedInstanceIds,
    dataset: {
      id: SWE_BENCH_VERIFIED_DATASET_ID,
      revision: SWE_BENCH_VERIFIED_DATASET_REVISION,
      registrySnapshotSha256,
      registrySnapshotBytes: registryBytes.byteLength,
      instanceCount: datasetNames.length,
    },
    harness: {
      adapterId: SWE_BENCH_HARNESS_ADAPTER_ID,
      version,
      executableSha256,
      timeoutSeconds: SWE_BENCH_VERIFIED_DEFAULT_TIMEOUT_SECONDS,
      timeoutOverride: false,
      resourceOverride: false,
    },
    binding: { executable },
  };
}

export function writeSwebenchVerifiedHostBinding(
  workspaceDir: string,
  selectionManifestSha256: string,
  binding: SwebenchVerifiedHostBinding,
): void {
  atomicWriteFileSync(
    runtimeHostPath(workspaceDir, selectionManifestSha256),
    JSON.stringify(SwebenchVerifiedHostBindingSchema.parse(binding), null, 2),
  );
}

export function readSwebenchVerifiedHostBinding(
  workspaceDir: string,
  selectionManifestSha256: string,
): SwebenchVerifiedHostBinding {
  const bytes = readFileIfExistsSync(runtimeHostPath(workspaceDir, selectionManifestSha256));
  if (bytes === undefined) throw new TypeError("SWE-bench Verified host binding is missing");
  return SwebenchVerifiedHostBindingSchema.parse(JSON.parse(new TextDecoder("utf8", { fatal: true }).decode(bytes)));
}

export function sealSwebenchVerifiedSelectionDependencies(
  workspaceDir: string,
  resolution: SwebenchVerifiedSelectionResolution,
): void {
  const executableBytes = new Uint8Array(readFileSync(realpathSync(resolution.binding.executable)));
  if (sha256Hex(executableBytes) !== resolution.harness.executableSha256
    || putSealedBytes(workspaceDir, executableBytes) !== resolution.harness.executableSha256) {
    throw new TypeError("SWE-bench Verified harness executable bytes do not match the sealed selection");
  }
}
