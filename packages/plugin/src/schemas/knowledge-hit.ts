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
});

export type KnowledgeHit = z.infer<typeof KnowledgeHitSchema>;
