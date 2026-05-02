import { z } from 'zod';

const WindowSchema = z.object({
  startTs: z.number().int().nonnegative(),
  endTs: z.number().int().nonnegative(),
});

export const DecimalProbabilitySchema = z
  .string()
  .regex(/^(0(\.\d+)?|1(\.0+)?)$/, 'must be a decimal string in [0,1]');

export const IsoDateTimeSchema = z.string().datetime({ offset: true });

export const PredictionV1ClaimPolicySchema = z.object({
  kind: z.literal('parallel'),
  maxClaims: z.number().int().positive(),
  maxClaimsPerSolver: z.number().int().positive(),
  claimWindow: z.literal('task-window'),
  selection: z.literal('all-valid-solutions-scored'),
  economics: z.literal('testnet-flat'),
});

export const PredictionV1SpecSchema = z.object({
  question: z.object({
    kind: z.literal('binary'),
    text: z.string().min(1),
    yesLabel: z.literal('YES'),
    noLabel: z.literal('NO'),
  }),
  source: z.object({
    type: z.literal('prediction-market'),
    venue: z.literal('polymarket'),
    url: z.string().url(),
    identifiers: z.object({
      marketId: z.string().min(1),
      conditionId: z.string().min(1),
      yesTokenId: z.string().min(1),
      noTokenId: z.string().min(1),
    }),
  }),
  resolution: z.object({
    expectedResolutionTime: IsoDateTimeSchema,
    rulesText: z.string().min(1),
    rulesUrl: z.string().url(),
    timezone: z.string().optional(),
  }),
  consensusSnapshot: z.object({
    sampledAt: IsoDateTimeSchema,
    probabilityYes: DecimalProbabilitySchema,
    method: z.literal('best-bid-ask-midpoint'),
    bestBidYes: DecimalProbabilitySchema,
    bestAskYes: DecimalProbabilitySchema,
    spread: DecimalProbabilitySchema,
    source: z.literal('polymarket-clob'),
  }),
  eligibilitySnapshot: z.object({
    sampledAt: IsoDateTimeSchema,
    timeToResolutionHours: z.number(),
    liquidityUsd: z.string().min(1),
    volume24hUsd: z.string().min(1),
    orderbookAgeSeconds: z.number().nonnegative(),
    selectionReason: z.string().min(1),
  }),
});

export type PredictionV1Spec = z.infer<typeof PredictionV1SpecSchema>;

export const PredictionV1TaskSchema = z
  .object({
    id: z.string().min(1),
    description: z.string().min(1),
    solverType: z.literal('prediction.v1'),
    role: z.enum(['restoration', 'evaluation']).optional(),
    window: WindowSchema,
    claimPolicy: PredictionV1ClaimPolicySchema,
    spec: PredictionV1SpecSchema,
    eligibility: z.record(z.unknown()).default({}),
  })
  .refine((d) => d.window.endTs > d.window.startTs, {
    message: 'window.endTs must be > window.startTs',
    path: ['window'],
  })
  .refine((d) => Date.parse(d.spec.resolution.expectedResolutionTime) > d.window.startTs, {
    message: 'expectedResolutionTime must be after window.startTs',
    path: ['spec', 'resolution', 'expectedResolutionTime'],
  });

export type PredictionV1Task = z.infer<typeof PredictionV1TaskSchema>;
