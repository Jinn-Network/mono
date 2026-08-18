/** Product-owned SWE-bench Verified selection. Cousin swe-rebench cannot claim this id. */
import { canonicalJsonBytes } from "@jinn-network/trust-core";
import { z } from "zod";
import { sha256Hex } from "../../workspace/sealed-store.js";
import { SUITE_COVERAGE } from "../suite-protocol/comparability.js";
import { SwebenchVerifiedSuiteProtocolSelectionSchema } from "../suite-protocol/manifest.js";

export const SWE_BENCH_VERIFIED_DATASET_ID = "princeton-nlp/SWE-bench_Verified" as const;
/** HuggingFace dataset git SHA for princeton-nlp/SWE-bench_Verified (500 test examples), re-read 2026-08-17. */
export const SWE_BENCH_VERIFIED_DATASET_REVISION = "c104f840cc67f8b6eec6f759ebc8b2693d585d4a" as const;
export const SWE_BENCH_VERIFIED_DATASET_INSTANCE_COUNT = 500 as const;
export const SWE_BENCH_HARNESS_ADAPTER_ID = "swebench-harness" as const;
export const SWE_BENCH_HARNESS_VERSION_RANGE = "4.1.x" as const;
export const SWE_BENCH_VERIFIED_DEFAULT_TIMEOUT_SECONDS = 1800 as const;
export const SWE_BENCH_VERIFIED_PROFILE = "https://product.jinn.network/profiles/swe-bench-verified-selection/v1" as const;
export const SWE_BENCH_VERIFIED_SELECTION_ROLE = "https://product.jinn.network/artifact-roles/swe-bench-verified/selection/v1" as const;
export const SWE_BENCH_VERIFIED_SELECTION_SCHEMA = "jinn.network/benchmark-product/swe-bench-verified-selection/1" as const;
export const SWE_BENCH_HARNESS_RUNTIME_EVIDENCE_PROFILE = "https://product.jinn.network/profiles/swebench-harness-evidence/v1" as const;

const Sha256 = z.string().regex(/^[a-f0-9]{64}$/u);
const HfRevision = z.string().regex(/^[a-f0-9]{40}$/u);
const InstanceId = z.string().min(1).regex(/^[^/]+$/u);

export const SwebenchVerifiedRegistryMetadataSchema = z.object({
  name: z.literal(SWE_BENCH_VERIFIED_DATASET_ID),
  revision: HfRevision,
  instance_ids: z.array(InstanceId).min(1),
}).passthrough();
export type SwebenchVerifiedRegistryMetadata = z.infer<typeof SwebenchVerifiedRegistryMetadataSchema>;

export const SwebenchVerifiedSelectionManifestSchema = z.object({
  schema: z.literal(SWE_BENCH_VERIFIED_SELECTION_SCHEMA),
  dataset: z.object({
    id: z.literal(SWE_BENCH_VERIFIED_DATASET_ID),
    revision: HfRevision,
    registrySnapshotSha256: Sha256,
    registrySnapshotBytes: z.number().int().positive(),
    instanceCount: z.number().int().positive(),
  }).strict(),
  coverage: z.enum(SUITE_COVERAGE),
  selectedInstances: z.array(z.object({
    instanceId: InstanceId,
  }).strict()).min(1),
  harness: z.object({
    adapterId: z.literal(SWE_BENCH_HARNESS_ADAPTER_ID),
    version: z.string().regex(/^4\.1\.\d+(?:[-+][0-9A-Za-z.-]+)?$/u),
    executableSha256: Sha256,
    timeoutSeconds: z.literal(SWE_BENCH_VERIFIED_DEFAULT_TIMEOUT_SECONDS),
    timeoutOverride: z.literal(false),
    resourceOverride: z.literal(false),
  }).strict(),
  suite: SwebenchVerifiedSuiteProtocolSelectionSchema,
}).strict().superRefine((value, context) => {
  if (value.selectedInstances.length !== value.suite.selectedTaskNames.length) {
    context.addIssue({ code: "custom", message: "selectedInstances must match suite selectedTaskNames", path: ["selectedInstances"] });
  }
  const names = value.selectedInstances.map((item) => item.instanceId);
  if (names.join("\0") !== value.suite.selectedTaskNames.join("\0")) {
    context.addIssue({ code: "custom", message: "selectedInstances must equal suite selectedTaskNames in order", path: ["selectedInstances"] });
  }
  if (value.dataset.revision !== value.suite.datasetRevision) {
    context.addIssue({ code: "custom", message: "dataset revision must equal suite datasetRevision", path: ["dataset", "revision"] });
  }
});
export type SwebenchVerifiedSelectionManifest = z.infer<typeof SwebenchVerifiedSelectionManifestSchema>;

export function swebenchVerifiedSelectionBytes(value: SwebenchVerifiedSelectionManifest): Uint8Array {
  return canonicalJsonBytes(SwebenchVerifiedSelectionManifestSchema.parse(value) as never);
}

export function swebenchVerifiedSelectionSha256(value: SwebenchVerifiedSelectionManifest): string {
  return sha256Hex(swebenchVerifiedSelectionBytes(value));
}

export function assertSupportedSwebenchHarnessVersion(version: string): string {
  if (!/^4\.1\.\d+(?:[-+][0-9A-Za-z.-]+)?$/u.test(version)) {
    throw new TypeError(`SWE-bench Verified requires swebench ${SWE_BENCH_HARNESS_VERSION_RANGE}, got ${version}`);
  }
  return version;
}
