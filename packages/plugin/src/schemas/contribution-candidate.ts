import { z } from 'zod';

export const CONTRIBUTION_CANDIDATE_SCHEMA_VERSION = 'jinn.contribution-candidate.v1' as const;

const ContributionTestRunShape = {
  command: z.string().min(1),
  exitCode: z.number().int(),
  at: z.iso.datetime(),
};
const ContributionTestRunSchema = z.strictObject(ContributionTestRunShape);
const ContributionTestRunReadSchema = z.looseObject(ContributionTestRunShape);

const ContributionSkillEventShape = {
  skillRef: z.string().min(1),
  action: z.enum(['loaded', 'invoked']),
};
const ContributionSkillEventSchema = z.strictObject(ContributionSkillEventShape);
const ContributionSkillEventReadSchema = z.looseObject(ContributionSkillEventShape);

const ContributionCandidateShape = {
  schemaVersion: z.literal(CONTRIBUTION_CANDIDATE_SCHEMA_VERSION),
  sourceId: z.string().min(1),
  repositorySlug: z.string().min(1),
  baseCommit: z.string().min(1),
  acceptedDiff: z.string().min(1),
  intermediateFailureDiffs: z.array(z.string().min(1)),
  publishMinedTasksConsent: z.boolean(),
  createdAt: z.iso.datetime(),
};

/**
 * The complete local input to contribution mining. Timestamps are required
 * caller inputs so assembling or parsing a candidate never reads the clock.
 */
export const ContributionCandidateV1Schema = z.strictObject({
  ...ContributionCandidateShape,
  testRuns: z.array(ContributionTestRunSchema),
  skillEvents: z.array(ContributionSkillEventSchema),
});

/** Additive reader used only inside canonical local EpisodeV1 records. */
export const ContributionCandidateV1ReadSchema = z.looseObject({
  ...ContributionCandidateShape,
  testRuns: z.array(ContributionTestRunReadSchema),
  skillEvents: z.array(ContributionSkillEventReadSchema),
});

export type ContributionCandidateV1 = z.infer<typeof ContributionCandidateV1Schema>;

/** Resolve a forward-additive candidate from a canonical Episode into the
 * current v1 fields. Unknown future fields stay in the Episode but never make
 * an otherwise valid local reference look unresolved to an older reader. */
export const ContributionCandidateV1ProjectionSchema = ContributionCandidateV1ReadSchema
  .transform((candidate): ContributionCandidateV1 => ({
    schemaVersion: candidate.schemaVersion,
    sourceId: candidate.sourceId,
    repositorySlug: candidate.repositorySlug,
    baseCommit: candidate.baseCommit,
    acceptedDiff: candidate.acceptedDiff,
    testRuns: candidate.testRuns.map((run) => ({
      command: run.command,
      exitCode: run.exitCode,
      at: run.at,
    })),
    intermediateFailureDiffs: candidate.intermediateFailureDiffs,
    skillEvents: candidate.skillEvents.map((event) => ({
      skillRef: event.skillRef,
      action: event.action,
    })),
    publishMinedTasksConsent: candidate.publishMinedTasksConsent,
    createdAt: candidate.createdAt,
  }));
