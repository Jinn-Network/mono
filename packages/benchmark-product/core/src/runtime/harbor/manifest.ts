/** Immutable, pre-dispatch selection for the managed direct Harbor adapter. */
import { canonicalJsonBytes } from "@jinn-network/trust-core";
import { z } from "zod";
import { sha256Hex } from "../../workspace/sealed-store.js";

export const HARBOR_ADAPTER_ID = "harbor" as const;
export const HARBOR_SELECTION_SCHEMA = "jinn.network/benchmark-product/harbor-selection/1" as const;
export const HARBOR_RUNTIME_EVIDENCE_PROFILE = "https://product.jinn.network/profiles/harbor-evidence/v1" as const;
export const SUPPORTED_HARBOR_VERSION_RANGE = "0.21.x" as const;

const Sha256 = z.string().regex(/^[a-f0-9]{64}$/);
const Json: z.ZodType<unknown> = z.lazy(() => z.union([z.string(), z.number().finite(), z.boolean(), z.null(), z.array(Json), z.record(z.string(), Json)]));
const RevisionedReference = z.object({ reference: z.string().min(1), revision: z.string().min(1), checksum: Sha256 }).strict();

/** Harbor 0.21 is deliberately constrained to one Job / one Trial / one execution. */
export const HarborSelectionManifestSchema = z.object({
  schema: z.literal(HARBOR_SELECTION_SCHEMA),
  adapter: z.object({ id: z.literal(HARBOR_ADAPTER_ID), version: z.literal("1") }).strict(),
  harbor: z.object({ version: z.string().regex(/^0\.21\.\d+(?:[-+][0-9A-Za-z.-]+)?$/), executableSha256: Sha256 }).strict(),
  dataset: RevisionedReference,
  task: RevisionedReference,
  agent: z.object({ id: z.string().min(1), configuration: z.record(z.string(), Json) }).strict(),
  model: z.object({ id: z.string().min(1), configuration: z.record(z.string(), Json) }).strict(),
  environment: z.object({ image: z.string().min(1), configuration: z.record(z.string(), Json) }).strict(),
  retryPolicy: z.object({ nAttempts: z.literal(1), nConcurrent: z.literal(1), maxRetries: z.literal(0) }).strict(),
}).strict();

export type HarborSelectionManifest = z.infer<typeof HarborSelectionManifestSchema>;

export function harborSelectionManifestBytes(manifest: HarborSelectionManifest): Uint8Array {
  return canonicalJsonBytes(HarborSelectionManifestSchema.parse(manifest) as never);
}

export function harborSelectionManifestSha256(manifest: HarborSelectionManifest): string {
  return sha256Hex(harborSelectionManifestBytes(manifest));
}

/** Rejects broad ranges and every Harbor release outside the supported 0.21 line. */
export function assertSupportedHarborVersion(version: string): void {
  if (!/^0\.21\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(version)) {
    throw new TypeError(`managed Harbor adapter requires Harbor ${SUPPORTED_HARBOR_VERSION_RANGE}; received ${version}`);
  }
}
