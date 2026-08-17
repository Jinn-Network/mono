/** Product-owned Terminal-Bench 2.1 selection. Existing TB 2.0 path stays and cannot claim this id. */
import { canonicalJsonBytes } from "@jinn-network/trust-core";
import { z } from "zod";
import { sha256Hex } from "../../workspace/sealed-store.js";
import { HARBOR_021_PACKAGER_ALGORITHM, TerminalBenchMaterialSchema } from "../terminal-bench-2/manifest.js";
import { SUITE_COVERAGE } from "../suite-protocol/comparability.js";

export const TERMINAL_BENCH_2_1_DATASET_ID = "terminal-bench/terminal-bench-2-1" as const;
/** Leaderboard pin from terminal-bench-2-1 `leaderboard/src/leaderboard/core/hub.py` DATASET_REF. */
export const TERMINAL_BENCH_2_1_DATASET_REF = "sha256:7d7bdc1cbedad549fc1140404bd4dc45e5fd0ea7c4186773687d177ad3a0699a" as const;
export const TERMINAL_BENCH_2_1_PROFILE = "https://product.jinn.network/profiles/terminal-bench-2-1-selection/v1" as const;
export const TERMINAL_BENCH_2_1_SELECTION_ROLE = "https://product.jinn.network/artifact-roles/terminal-bench-2-1/selection/v1" as const;
export const TERMINAL_BENCH_2_1_SELECTION_SCHEMA = "jinn.network/benchmark-product/terminal-bench-2-1-selection/1" as const;

const Sha256 = z.string().regex(/^[a-f0-9]{64}$/u);
const RegistryRevision = z.string().regex(/^sha256:[a-f0-9]{64}$/u);

export const TerminalBench21RegistryMetadataSchema = z.object({
  name: z.literal(TERMINAL_BENCH_2_1_DATASET_ID),
  version: z.string().min(1).optional(),
  dataset_version_content_hash: z.string().regex(/^(?:sha256:)?[a-f0-9]{64}$/u),
  task_ids: z.array(z.object({
    org: z.literal("terminal-bench"),
    name: z.string().min(1).regex(/^[^/]+$/u),
    ref: RegistryRevision,
  }).passthrough()).min(1),
}).passthrough();

export const TerminalBench21SelectionManifestSchema = z.object({
  schema: z.literal(TERMINAL_BENCH_2_1_SELECTION_SCHEMA),
  dataset: z.object({
    id: z.literal(TERMINAL_BENCH_2_1_DATASET_ID),
    revision: RegistryRevision,
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
    maxRetries: z.literal(0),
    jobGrain: z.literal("per-arm"),
  }).strict(),
}).strict().superRefine((value, context) => {
  if (value.execution.nTasks !== value.selectedTasks.length) {
    context.addIssue({ code: "custom", message: "nTasks must equal selectedTasks length", path: ["execution", "nTasks"] });
  }
});
export type TerminalBench21SelectionManifest = z.infer<typeof TerminalBench21SelectionManifestSchema>;

export function terminalBench21SelectionBytes(value: TerminalBench21SelectionManifest): Uint8Array {
  return canonicalJsonBytes(TerminalBench21SelectionManifestSchema.parse(value) as never);
}

export function terminalBench21SelectionSha256(value: TerminalBench21SelectionManifest): string {
  return sha256Hex(terminalBench21SelectionBytes(value));
}
