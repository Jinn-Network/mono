/** Assembled at session end() (product design §4.2 legibility requirement — "when Jinn found nothing, it says so"). */
import { z } from 'zod';
import { EligibilityVerdictSchema } from './eligibility-verdict.js';
import { KnowledgeHitSchema } from './knowledge-hit.js';

export const SessionSummarySchema = z.strictObject({
  episodeRef: z.string().min(1),
  surfacedRefs: z.array(z.string().min(1)).default([]),
  fetchedRefs: z.array(z.string().min(1)).default([]),
  surfacedHits: z.array(KnowledgeHitSchema),
  fetchedHits: z.array(KnowledgeHitSchema),
  installedSkillRefs: z.array(z.string().min(1)),
  eligibility: EligibilityVerdictSchema,
  nothingFound: z.boolean(),
});

export type SessionSummary = z.infer<typeof SessionSummarySchema>;
