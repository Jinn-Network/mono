/**
 * Config shape v2 — types and zod schemas for the stage-1 cutover keys
 * (`claimPolicy`, `executionWiring`, `posting`), plus the mapper from
 * operator-config wiring entries onto the marketplace-pipeline's frozen
 * `ExecutionWiringEntry` type.
 *
 * See `docs/superpowers/plans/2026-07-30-cutover-stage-1-solver-flow.md`
 * Task 1.
 *
 * Amendment (coordinator amendment 1, binding on this file): spec §9's
 * "behavior-identical on day one" means CLAIM_NOTHING is the posture for an
 * *unconfigured* predicate, not for the migration of a configured operator.
 * `ClaimPolicyConfig.spendCapWei` / `.aiUnitCap` are therefore OPTIONAL — an
 * operator with no per-claim caps set relies on the host's USD
 * rolling-window gates (kept per spec §6.5) as the operative spend bound,
 * exactly today's behavior.
 */

import { z } from 'zod/v3';
import type { ExecutionWiringEntry } from '@jinn-network/marketplace-pipeline';

export const CONFIG_SHAPE_VERSION = 2 as const;

const DecimalWei = z.string().regex(/^\d+$/u, 'spendCapWei must be a decimal wei string');

export const ClaimPolicyConfigSchema = z.object({
  mode: z.enum(['claim-nothing', 'every-runnable', 'match-legacy-manifest-digest']),
  spendCapWei: DecimalWei.optional(),
  aiUnitCap: z.number().int().nonnegative().optional(),
});
export type ClaimPolicyConfig = z.infer<typeof ClaimPolicyConfigSchema>;

export const ExecutionWiringConfigEntrySchema = z.object({
  workKind: z.string().min(1),
  harness: z.string().min(1),
  model: z.string().min(1),
  plugins: z.array(z.string()).default([]),
  credentialRef: z.string().min(1),
  isolationPolicy: z.string().min(1),
  legacyManifestDigest: z.string().min(1).optional(),
});
export type ExecutionWiringConfigEntry = z.infer<typeof ExecutionWiringConfigEntrySchema>;

export const PostingConfigEntrySchema = z.object({
  workKind: z.string().min(1),
  launchedRecordPath: z.string().min(1),
  generatorEnabled: z.boolean(),
  legacyManifestDigest: z.string().min(1).optional(),
});
export type PostingConfigEntry = z.infer<typeof PostingConfigEntrySchema>;

/** Maps operator config entries onto the pipeline's frozen entry type. */
export function toPipelineWiring(
  entries: readonly ExecutionWiringConfigEntry[],
): ExecutionWiringEntry[] {
  return entries.map((entry) => ({
    workKind: entry.workKind,
    harness: entry.harness,
    model: entry.model,
    plugins: [...entry.plugins],
    credentialRef: entry.credentialRef,
    isolationPolicy: entry.isolationPolicy,
    ...(entry.legacyManifestDigest === undefined
      ? {}
      : { legacyManifestDigest: entry.legacyManifestDigest }),
  }));
}
