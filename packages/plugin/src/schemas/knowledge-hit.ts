/** A single corpus result — seeds + prior traces + distilled skills (product design §4.2). */
import { z } from 'zod';
import { TIER_ORDER } from './pickup-config.js';

export const KnowledgeHitSchema = z.strictObject({
  ref: z.string().min(1),
  kind: z.enum(['seed', 'trace', 'skill']),
  title: z.string().min(1).optional(),
  snippet: z.string().min(1).optional(),
  score: z.number().min(0).max(1).optional(),
  tier: z.enum(TIER_ORDER).optional(),
  payloadKind: z.enum(['skill', 'unknown']).optional(),
  /** Distribution tags — scored alongside `snippet` by the evidence-first selection policy (rescope §3.3). */
  tags: z.array(z.string().min(1)).default([]),
  /** Publisher/attribution identity (e.g. an on-chain agentId) — the evidence-first
   *  selection policy's `(taskSummary, origin)` content-dedup key and the eventual
   *  KnowledgePacket's `attribution.origin`. */
  origin: z.string().min(1).optional(),
  /** Unix-ms publish time — the selection policy's recency tiebreaker (rescope §3.3). */
  publishedAt: z.number().int().nonnegative().optional(),
});

export type KnowledgeHit = z.infer<typeof KnowledgeHitSchema>;
