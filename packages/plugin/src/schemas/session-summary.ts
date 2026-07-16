/** Assembled at session end() (product design §4.2 legibility requirement — "when Jinn found nothing, it says so"). */
import { z } from 'zod';
import { EligibilityVerdictSchema } from './eligibility-verdict.js';
import { KnowledgeHitSchema } from './knowledge-hit.js';

export const SessionSummarySchema = z.strictObject({
  episodeRef: z.string().min(1),
  /** Evidence-first pickup facts (rescope §3.6). */
  searchedTerms: z.array(z.string().min(1)).default([]),
  providedPackets: z.array(z.strictObject({
    ref: z.string().min(1),
    title: z.string().min(1),
  })).default([]),
  /** @deprecated rescope — retained for downstream harness-layer/cli/Python
   *  renderers until they migrate to searchedTerms/providedPackets. Populated
   *  from providedPackets when present, else echoes whatever legacy refs a
   *  pre-rescope caller submitted. */
  surfacedRefs: z.array(z.string().min(1)).default([]),
  /** @deprecated rescope */
  fetchedRefs: z.array(z.string().min(1)).default([]),
  surfacedHits: z.array(KnowledgeHitSchema),
  fetchedHits: z.array(KnowledgeHitSchema),
  /** @deprecated rescope — always empty; the skill adopt/install path no longer exists. */
  installedSkillRefs: z.array(z.string().min(1)),
  eligibility: EligibilityVerdictSchema,
  nothingFound: z.boolean(),
});

export type SessionSummary = z.infer<typeof SessionSummarySchema>;
