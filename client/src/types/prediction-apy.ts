import { z } from 'zod';
import { WindowSchema } from './desired-state.js';

const HexStringSchema = z.string().regex(/^0x[0-9a-fA-F]*$/, 'must be a 0x-prefixed hex string');

const SignatureSchema = z.object({
  algo: z.literal('secp256k1'),
  signer: HexStringSchema,
  hash: HexStringSchema,
  sig: HexStringSchema,
});

const IntentProvenanceSchema = z.object({
  cid: z.string().min(1),
  onchainCreationTx: HexStringSchema,
  onchainCreationBlock: z.number().int(),
  requestId: HexStringSchema,
});

const ParticipantSchema = z.object({
  safeAddress: HexStringSchema,
  agentEoa: HexStringSchema,
});

const IntegerStringSchema = z.string().regex(/^-?\d+$/, 'must be an integer string');

export const PredictionApyV0SpecSchema = z.object({
  kind: z.literal('prediction.apy.v0'),
  oracle: z.object({
    venue: z.enum(['aave-v3-base-sepolia', 'aave-v3-base', 'aave-v3-mainnet']),
    pool: HexStringSchema,
    reserve: HexStringSchema,
    reserveSymbol: z.string().min(1),
  }),
  metric: z.object({
    type: z.literal('supply-apy-twa-bps'),
    twaWindowSeconds: z.number().int().min(600).max(604_800),
    sampleCount: z.number().int().min(2).max(512),
    toleranceBps: z.number().int().min(1).max(10_000),
  }),
  question: z.object({
    resolveTs: z.number().int(),
  }),
});

export type PredictionApyV0Spec = z.infer<typeof PredictionApyV0SpecSchema>;

export const PredictionApyV0EligibilitySchema = z.object({
  maxSubmissionDelayMs: z.number().int().default(60_000),
});

export type PredictionApyV0Eligibility = z.infer<typeof PredictionApyV0EligibilitySchema>;

export const PredictionApyV0IntentSchema = z
  .object({
    id: z.string(),
    description: z.string().min(1),
    window: WindowSchema,
    spec: PredictionApyV0SpecSchema,
    eligibility: PredictionApyV0EligibilitySchema.default({}),
  })
  .refine((d) => d.window.endTs > d.window.startTs, {
    message: 'window.endTs must be > window.startTs',
    path: ['window'],
  })
  .refine((d) => d.window.endTs - d.window.startTs >= 60_000, {
    message: 'window must be at least 1 minute',
    path: ['window'],
  })
  .refine((d) => d.window.endTs - d.window.startTs <= 72 * 3_600_000, {
    message: 'window must be at most 72 hours',
    path: ['window'],
  })
  .refine((d) => d.spec.question.resolveTs >= d.window.endTs, {
    message: 'resolveTs must be ≥ window.endTs',
    path: ['spec', 'question', 'resolveTs'],
  })
  .refine((d) => d.spec.question.resolveTs - d.window.endTs <= 8 * 24 * 3_600_000, {
    message: 'resolve gap must be ≤ 8 days',
    path: ['spec', 'question', 'resolveTs'],
  })
  .refine((d) => d.spec.metric.sampleCount <= d.spec.metric.twaWindowSeconds, {
    message: 'sampleCount must be <= twaWindowSeconds',
    path: ['spec', 'metric', 'sampleCount'],
  });

export type PredictionApyV0Intent = z.infer<typeof PredictionApyV0IntentSchema>;

export const PredictionApySubmissionManifestSchema = z.object({
  schemaVersion: z.literal('prediction.apy.v0.submission.v1'),
  generatedAt: z.number().int(),
  intent: IntentProvenanceSchema,
  restorer: ParticipantSchema,
  window: WindowSchema,
  prediction: z.object({
    predictedBps: IntegerStringSchema,
    submittedAt: z.number().int(),
    modelId: z.string().min(1),
  }),
  signature: SignatureSchema,
});

export type PredictionApySubmissionManifest = z.infer<typeof PredictionApySubmissionManifestSchema>;

export const PredictionApyVerdictManifestSchema = z.object({
  schemaVersion: z.literal('prediction.apy.v0.verdict.v1'),
  generatedAt: z.number().int(),
  intent: IntentProvenanceSchema,
  evaluator: ParticipantSchema,
  window: WindowSchema,
  verdict: z.enum(['PASS', 'FAIL', 'REJECTED', 'INDETERMINATE']),
  score: z.string(),
  scoreBasis: z.literal('absolute-error-linear.v1'),
  scoreVersion: z.string(),
  oracleReading: z.object({
    pool: HexStringSchema,
    reserve: HexStringSchema,
    sampleCount: z.number().int().positive(),
    twaWindowSeconds: z.number().int().positive(),
    resolveTs: z.number().int(),
  }),
  claimed: z.object({
    predictedBps: IntegerStringSchema,
    submittedAt: z.number().int(),
    modelId: z.string(),
    submissionManifestCid: z.string(),
  }),
  groundTruth: z.object({
    twApyBps: IntegerStringSchema,
    errorBps: z.string().regex(/^\d+$/),
  }),
  checks: z.array(
    z.object({
      name: z.string(),
      status: z.enum(['PASS', 'FAIL', 'SKIP']),
      detail: z.union([z.string(), z.record(z.unknown())]).optional(),
    }),
  ),
  signature: SignatureSchema,
});

export type PredictionApyVerdictManifest = z.infer<typeof PredictionApyVerdictManifestSchema>;
