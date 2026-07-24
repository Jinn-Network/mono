/** Evidence-first corpus search metadata (Stage 1 rescope §§3.1, 3.3). */
import { z } from 'zod';
import { TIER_ORDER } from './pickup-config.js';

export const KnowledgeHitSchema = z.strictObject({
  ref: z.string().min(1),
  canonicalEpisodeId: z.string().min(1).optional(),
  kind: z.enum(['seed', 'trace', 'skill']),
  title: z.string().min(1).optional(),
  snippet: z.string().min(1).optional(),
  score: z.number().min(0).max(1).optional(),
  tier: z.enum(TIER_ORDER).optional(),
  payloadKind: z.enum(['skill', 'unknown']).optional(),
  /** Distribution tags — scored alongside `snippet` by the evidence-first selection policy (rescope §3.3). */
  tags: z.array(z.string().min(1)).default([]),
  /** Trustworthy content-dedup identity: on-chain agentId when known, otherwise
   *  the record ref. Never a manifest-supplied safeAddress. */
  origin: z.string().min(1).optional(),
  /** Adapter-native recency value — comparable only within `recencyDomain`. */
  publishedAt: z.number().int().nonnegative().optional(),
  /**
   * Adapter-declared comparison domain for `publishedAt` (for example,
   * `unix-ms` or `block-number`). Recency is comparable only within one
   * explicit domain. When both hits omit this additive field, ranking keeps
   * the legacy raw-number behavior.
   */
  recencyDomain: z.string().min(1).optional(),
  /** Computed by the adapter from the wire hit's tags (issue #1824) — presence
   *  of RETRIEVAL_VISIBLE_TAG. Absent = treat as not visible (fail-closed at
   *  ranking). */
  retrievalVisible: z.boolean().optional(),
});

export type KnowledgeHit = z.infer<typeof KnowledgeHitSchema>;
