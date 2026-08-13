/** Product-owned Terminal-Bench 2 selection and migration evidence. */
import { canonicalJsonBytes } from "@jinn-network/trust-core";
import { z } from "zod";
import { sha256Hex } from "../../workspace/sealed-store.js";

export const TERMINAL_BENCH_2_DATASET_ID = "terminal-bench/terminal-bench-2" as const;
export const TERMINAL_BENCH_2_PROFILE = "https://product.jinn.network/profiles/terminal-bench-2-selection/v1" as const;
export const TERMINAL_BENCH_2_SELECTION_ROLE = "https://product.jinn.network/artifact-roles/terminal-bench-2/selection/v1" as const;
export const TERMINAL_BENCH_MIGRATION_ROLE = "https://product.jinn.network/artifact-roles/terminal-bench/migration/v1" as const;
export const TERMINAL_BENCH_2_SELECTION_SCHEMA = "jinn.network/benchmark-product/terminal-bench-2-selection/1" as const;
export const TERMINAL_BENCH_MIGRATION_SCHEMA = "jinn.network/benchmark-product/terminal-bench-migration/1" as const;
export const HARBOR_021_PACKAGER_ALGORITHM = "harbor-framework/harbor@64afbbcb62165950301e1a6407c729aa26d844ff:Packager.compute_content_hash" as const;

const Sha256 = z.string().regex(/^[a-f0-9]{64}$/u);
const RegistryRevision = z.string().regex(/^sha256:[a-f0-9]{64}$/u);
const MaterialFile = z.object({ path: z.string().min(1), sha256: Sha256, bytes: z.number().int().nonnegative() }).strict();
export const TerminalBenchMaterialSchema = z.object({
  checksum: Sha256,
  files: z.array(MaterialFile).min(1),
}).strict();
export type TerminalBenchMaterial = z.infer<typeof TerminalBenchMaterialSchema>;

/** Exact PackageDatasetClient metadata fields used by Harbor 0.21. Unknown upstream
 * descriptive fields stay in the separately sealed byte-exact snapshot. */
export const TerminalBenchRegistryMetadataSchema = z.object({
  name: z.literal(TERMINAL_BENCH_2_DATASET_ID),
  version: z.string().min(1).optional(),
  dataset_version_content_hash: z.string().regex(/^(?:sha256:)?[a-f0-9]{64}$/u),
  task_ids: z.array(z.object({
    org: z.literal("terminal-bench"),
    name: z.string().min(1).regex(/^[^/]+$/u),
    ref: RegistryRevision,
  }).passthrough()).min(1),
}).passthrough();

export const TerminalBench2SelectionManifestSchema = z.object({
  schema: z.literal(TERMINAL_BENCH_2_SELECTION_SCHEMA),
  dataset: z.object({
    id: z.literal(TERMINAL_BENCH_2_DATASET_ID),
    revision: RegistryRevision,
    registrySnapshotSha256: Sha256,
    registrySnapshotBytes: z.number().int().positive(),
  }).strict(),
  selectedTask: z.object({
    package: z.object({ name: z.string().regex(/^terminal-bench\/[^/]+$/u), ref: RegistryRevision }).strict(),
    contentHashAlgorithm: z.literal(HARBOR_021_PACKAGER_ALGORITHM),
    filter: z.string().min(1).regex(/^[^/]+$/u),
    datasetProjectionChecksum: Sha256,
    material: TerminalBenchMaterialSchema,
  }).strict(),
  migrationManifestSha256: Sha256.optional(),
  execution: z.object({ source: z.literal("dataset"), nTasks: z.literal(1), nAttempts: z.literal(1), nConcurrent: z.literal(1), maxRetries: z.literal(0) }).strict(),
}).strict();
export type TerminalBench2SelectionManifest = z.infer<typeof TerminalBench2SelectionManifestSchema>;

const Disclosure = z.discriminatedUnion("status", [
  z.object({ status: z.literal("none") }).strict(),
  z.object({ status: z.literal("applied"), description: z.string().trim().min(1) }).strict(),
]);

export const TerminalBenchMigrationManifestSchema = z.object({
  schema: z.literal(TERMINAL_BENCH_MIGRATION_SCHEMA),
  harbor: z.object({ version: z.string().regex(/^0\.21\.\d+(?:[-+][0-9A-Za-z.-]+)?$/u), executableSha256: Sha256 }).strict(),
  command: z.object({
    executable: z.literal("harbor"),
    argv: z.tuple([z.literal("task"), z.literal("migrate"), z.literal("-i"), z.literal("source"), z.literal("-o"), z.literal("transformed")]),
    stdoutSha256: Sha256,
    stderrSha256: Sha256,
  }).strict(),
  relationship: z.literal("source-transformed-by-harbor-mapper"),
  source: TerminalBenchMaterialSchema,
  transformed: TerminalBenchMaterialSchema,
  runnable: TerminalBenchMaterialSchema,
  manualAdjustment: Disclosure,
}).strict();
export type TerminalBenchMigrationManifest = z.infer<typeof TerminalBenchMigrationManifestSchema>;

export function terminalBench2SelectionBytes(value: TerminalBench2SelectionManifest): Uint8Array {
  return canonicalJsonBytes(TerminalBench2SelectionManifestSchema.parse(value) as never);
}

export function terminalBenchMigrationBytes(value: TerminalBenchMigrationManifest): Uint8Array {
  return canonicalJsonBytes(TerminalBenchMigrationManifestSchema.parse(value) as never);
}

export function terminalBenchManifestSha256(bytes: Uint8Array): string { return sha256Hex(bytes); }
