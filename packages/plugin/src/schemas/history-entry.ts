/** One derived-view row (product design §4.5). Owns no facts — computed from Evidence + Contribution + LocalLearning. */
import { z } from 'zod';
import { EligibilityVerdictSchema } from './eligibility-verdict.js';

export const HistoryEntrySchema = z.strictObject({
  sessionId: z.string().min(1),
  taskSummary: z.string().min(1),
  knowledgeSurfaced: z.number().int().nonnegative(),
  knowledgeUsed: z.number().int().nonnegative(),
  captureStatus: z.enum(['captured', 'not-captured']),
  eligibility: EligibilityVerdictSchema,
  contributionState: z.strictObject({
    status: z.enum([
      'none',
      'recorded',
      'minted',
      'rejected',
      'preview-required',
      'queued',
      'published',
      'vetoed',
    ]),
    anchorRef: z.string().min(1).optional(),
  }),
  distilledSkillRefs: z.array(z.string().min(1)),
});

export type HistoryEntry = z.infer<typeof HistoryEntrySchema>;
