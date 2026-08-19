/** Product-owned Terminal-Bench 3.0 selection. TB 2.1 / 2.0 / Verified cannot claim this id. */
import { canonicalJsonBytes } from "@jinn-network/trust-core";
import { z } from "zod";
import { HARBOR_021_PACKAGER_ALGORITHM, TerminalBenchMaterialSchema } from "../terminal-bench-2/manifest.js";
import { SUITE_COVERAGE } from "../suite-protocol/comparability.js";

export const TERMINAL_BENCH_3_0_DATASET_ID = "terminal-bench/terminal-bench" as const;
/** Hub dataset_version_content_hash for named version 3.0.0, re-read 2026-08-18. Never @latest. */
export const TERMINAL_BENCH_3_0_DATASET_REF = "sha256:a32a61879ea94eb9dc16fa1fbeb398759f0c07ca633d9d1f6aec760207036da3" as const;
export const TERMINAL_BENCH_3_0_HUB_VERSION = "3.0.0" as const;
export const TERMINAL_BENCH_3_0_PROFILE = "https://product.jinn.network/profiles/terminal-bench-3-0-selection/v1" as const;
export const TERMINAL_BENCH_3_0_SELECTION_ROLE = "https://product.jinn.network/artifact-roles/terminal-bench-3-0/selection/v1" as const;
export const TERMINAL_BENCH_3_0_SELECTION_SCHEMA = "jinn.network/benchmark-product/terminal-bench-3-0-selection/1" as const;

const Sha256 = z.string().regex(/^[a-f0-9]{64}$/u);
const RegistryRevision = z.string().regex(/^sha256:[a-f0-9]{64}$/u);

export const TerminalBench30RegistryMetadataSchema = z.object({
  name: z.literal(TERMINAL_BENCH_3_0_DATASET_ID),
  version: z.string().min(1).optional(),
  dataset_version_content_hash: z.string().regex(/^(?:sha256:)?[a-f0-9]{64}$/u),
  task_ids: z.array(z.object({
    org: z.literal("terminal-bench"),
    name: z.string().min(1).regex(/^[^/]+$/u),
    ref: RegistryRevision,
  }).passthrough()).min(1),
}).passthrough();

export const TerminalBench30SelectionManifestSchema = z.object({
  schema: z.literal(TERMINAL_BENCH_3_0_SELECTION_SCHEMA),
  dataset: z.object({
    id: z.literal(TERMINAL_BENCH_3_0_DATASET_ID),
    revision: RegistryRevision,
    hubVersion: z.string().min(1),
    registrySnapshotSha256: Sha256,
    registrySnapshotBytes: z.number().int().positive(),
    taskCount: z.number().int().positive(),
  }).strict(),
  coverage: z.enum(SUITE_COVERAGE),
  selectedTasks: z.array(z.object({
    package: z.object({ name: z.string().regex(/^terminal-bench\/[^/]+$/u), ref: RegistryRevision }).strict(),
    contentHashAlgorithm: z.literal(HARBOR_021_PACKAGER_ALGORITHM),
    filter: z.string().min(1).regex(/^[^/]+$/u),
    material: TerminalBenchMaterialSchema,
  }).strict()).min(1),
  datasetProjectionChecksum: Sha256,
  execution: z.object({
    source: z.literal("dataset"),
    nTasks: z.number().int().positive(),
    nAttempts: z.literal(5),
    nConcurrent: z.number().int().positive(),
    maxRetries: z.literal(3),
    jobGrain: z.literal("per-arm"),
  }).strict(),
}).strict().superRefine((value, context) => {
  if (value.execution.nTasks !== value.selectedTasks.length) {
    context.addIssue({ code: "custom", message: "nTasks must equal selectedTasks length", path: ["execution", "nTasks"] });
  }
});
export type TerminalBench30SelectionManifest = z.infer<typeof TerminalBench30SelectionManifestSchema>;

export function terminalBench30SelectionBytes(value: TerminalBench30SelectionManifest): Uint8Array {
  return canonicalJsonBytes(TerminalBench30SelectionManifestSchema.parse(value) as never);
}
