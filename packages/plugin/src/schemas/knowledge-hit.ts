/** A single corpus result — seeds + prior traces + distilled skills (product design §4.2). */
import { z } from 'zod';

export const KnowledgeHitSchema = z.strictObject({
  ref: z.string().min(1),
  kind: z.enum(['seed', 'trace', 'skill']),
  title: z.string().min(1).optional(),
  snippet: z.string().min(1).optional(),
  score: z.number().min(0).max(1).optional(),
});

export type KnowledgeHit = z.infer<typeof KnowledgeHitSchema>;
