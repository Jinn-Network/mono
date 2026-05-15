import { z } from 'zod';

const HexShaSchema = z.string().regex(/^[0-9a-f]{64}$/);

export const SessionDerivedExpectedArtifactsSchema = z.object({
  finalPatchRef: z.string().min(1).optional(),
  testSuiteRef: z.string().min(1).optional(),
  reproductionRef: z.string().min(1).optional(),
}).passthrough();

export const SessionDerivedTaskSchema = z.object({
  schemaVersion: z.literal('session-derived-task.v1'),
  sourceCaptureCid: z.string().min(1),
  sourceCaptureSha256: HexShaSchema.optional(),
  repo: z.object({
    remoteUrl: z.string().min(1).optional(),
    commitHash: z.string().regex(/^[0-9a-f]{40}$/).optional(),
    branch: z.string().min(1).optional(),
  }).optional(),
  problemStatement: z.string().min(1),
  expectedArtifacts: SessionDerivedExpectedArtifactsSchema.default({}),
  signalHints: z.array(z.string().min(1)).default([]),
  distillation: z.object({
    promptSha256: HexShaSchema,
    model: z.string().min(1),
    distilledAt: z.string().datetime({ offset: true }),
  }),
});
export type SessionDerivedTask = z.infer<typeof SessionDerivedTaskSchema>;

export const SessionDerivedSolutionSchema = z.object({
  schemaVersion: z.literal('session-derived-solution.v1'),
  patch: z.string().min(1).optional(),
  artifacts: z.array(z.object({
    artifactType: z.string().min(1),
    cid: z.string().min(1),
    sha256: HexShaSchema.optional(),
  })).default([]),
  rationale: z.string().min(1).optional(),
  trajectoryCid: z.string().min(1).optional(),
  cost: z.object({
    totalUsd: z.number().nonnegative(),
    llmUsd: z.number().nonnegative().optional(),
    toolUsd: z.number().nonnegative().optional(),
  }).optional(),
}).refine((value) => value.patch !== undefined || value.artifacts.length > 0, {
  message: 'session-derived Solution requires patch or artifacts',
});
export type SessionDerivedSolution = z.infer<typeof SessionDerivedSolutionSchema>;

export const SessionDerivedSignalSchema = z.object({
  present: z.boolean(),
  score: z.number().min(0).max(1),
  weight: z.number().positive(),
  reasoning: z.string().optional(),
});

export const SessionDerivedVerdictSchema = z.object({
  schemaVersion: z.literal('session-derived-verdict.v1'),
  verdict: z.enum(['SCORED', 'SKIPPED']),
  compositeScore: z.number().min(0).max(1),
  signalBreakdown: z.object({
    testSuiteRerun: SessionDerivedSignalSchema,
    structuralSimilarity: SessionDerivedSignalSchema,
    llmJudge: SessionDerivedSignalSchema,
  }),
  evaluatorCostUsd: z.number().nonnegative().default(0),
});
export type SessionDerivedVerdict = z.infer<typeof SessionDerivedVerdictSchema>;
