import { z } from 'zod';

export const CONTRIBUTION_CANDIDATE_SCHEMA_VERSION = 'jinn.contribution-candidate.v1' as const;

const ContributionTestRunSchema = z.strictObject({
  command: z.string().min(1),
  exitCode: z.number().int(),
  at: z.iso.datetime(),
});

const ContributionSkillEventSchema = z.strictObject({
  skillRef: z.string().min(1),
  action: z.enum(['loaded', 'invoked']),
});

/**
 * The complete local input to contribution mining. Timestamps are required
 * caller inputs so assembling or parsing a candidate never reads the clock.
 */
export const ContributionCandidateV1Schema = z.strictObject({
  schemaVersion: z.literal(CONTRIBUTION_CANDIDATE_SCHEMA_VERSION),
  sourceId: z.string().min(1),
  repositorySlug: z.string().min(1),
  baseCommit: z.string().min(1),
  acceptedDiff: z.string().min(1),
  testRuns: z.array(ContributionTestRunSchema),
  intermediateFailureDiffs: z.array(z.string().min(1)),
  skillEvents: z.array(ContributionSkillEventSchema),
  publishMinedTasksConsent: z.boolean(),
  createdAt: z.iso.datetime(),
});

export type ContributionCandidateV1 = z.infer<typeof ContributionCandidateV1Schema>;
