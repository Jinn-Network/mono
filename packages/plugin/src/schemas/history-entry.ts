/** One derived-view row (product design §4.5). Owns no facts — computed from Evidence + Contribution + LocalLearning. */
import { z } from 'zod';
import { EligibilityVerdictSchema } from './eligibility-verdict.js';

export const HistoryEntrySchema = z.strictObject({
  sessionId: z.string().min(1),
  capturedAt: z.iso.datetime(),
  taskSummary: z.string().min(1),
  knowledgeSurfaced: z.number().int().nonnegative().nullable(),
  knowledgeUsed: z.number().int().nonnegative().nullable(),
  captureStatus: z.enum(['captured', 'not-captured']),
  eligibility: EligibilityVerdictSchema.nullable(),
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
      'unavailable',
    ]),
    anchorRef: z.string().min(1).optional(),
  }),
  distilledSkills: z.array(z.strictObject({
    ref: z.string().min(1),
    state: z.enum(['staged', 'installed']),
  })).nullable(),
});

export type HistoryEntry = z.infer<typeof HistoryEntrySchema>;
