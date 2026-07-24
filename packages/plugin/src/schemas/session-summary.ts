/** Assembled at session end() (product design §4.2 legibility requirement — "when Jinn found nothing, it says so"). */
import { z } from 'zod';
import { EligibilityVerdictSchema } from './eligibility-verdict.js';

export const SessionSummarySchema = z.strictObject({
  episodeRef: z.string().min(1),
  /** Evidence-first pickup facts (rescope §3.6) — the only knowledge-activity
   *  shape a session summary carries. The pre-rescope `surfacedRefs`/
   *  `fetchedRefs`/`surfacedHits`/`fetchedHits`/`installedSkillRefs` quintet
   *  is dropped as of R3+R5 (the host and acceptance gate that consumed it
   *  have flipped); `Episode.activity` still accepts those fields on read for
   *  old episode files (rescope §3.6), but no summary emits them again. */
  searchedTerms: z.array(z.string().min(1)).default([]),
  providedPackets: z.array(z.strictObject({
    ref: z.string().min(1),
    title: z.string().min(1),
  })).default([]),
  eligibility: EligibilityVerdictSchema,
  nothingFound: z.boolean(),
});

export type SessionSummary = z.infer<typeof SessionSummarySchema>;
