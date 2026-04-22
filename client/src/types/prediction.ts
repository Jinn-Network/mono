/**
 * prediction.v0 — typed intent spec, submission manifest, verdict manifest.
 *
 * §4 of spec/2026-04-20-prediction-v0-pis-phase-1-design.md
 */
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

// ── Question kinds ────────────────────────────────────────────────────────────

const ThresholdQuestionSchema = z.object({
  kind: z.literal('threshold'),
  operator: z.enum(['GT', 'GTE', 'LT', 'LTE']),
  threshold: z.string(),
  resolveTs: z.number().int(),
});

const RangeQuestionSchema = z.object({
  kind: z.literal('range'),
  lowerBound: z.string(),
  upperBound: z.string(),
  resolveTs: z.number().int(),
});

// ── Spec + eligibility + intent ────────────────────────────────────────────────

export const PredictionV0SpecSchema = z.object({
  kind: z.literal('prediction.v0'),
  oracle: z.object({
    venue: z.enum(['chainlink-base-sepolia', 'chainlink-base']),
    feed: HexStringSchema,
    feedDescription: z.string(),
  }),
  question: z.discriminatedUnion('kind', [ThresholdQuestionSchema, RangeQuestionSchema]),
});

export type PredictionV0Spec = z.infer<typeof PredictionV0SpecSchema>;

export const PredictionV0EligibilitySchema = z.object({
  maxSubmissionDelayMs: z.number().int().default(60_000),
});

export type PredictionV0Eligibility = z.infer<typeof PredictionV0EligibilitySchema>;

export const PredictionV0IntentSchema = z
  .object({
    id: z.string(),
    description: z.string().min(1),
    window: WindowSchema,
    spec: PredictionV0SpecSchema,
    eligibility: PredictionV0EligibilitySchema.default({}),
  })
  .refine(d => d.window.endTs > d.window.startTs, {
    message: 'window.endTs must be > window.startTs',
    path: ['window'],
  })
  .refine(d => d.window.endTs - d.window.startTs >= 60_000, {
    message: 'window must be at least 1 minute',
    path: ['window'],
  })
  .refine(d => d.window.endTs - d.window.startTs <= 86_400_000, {
    message: 'window must be at most 24 hours',
    path: ['window'],
  })
  .refine(d => d.spec.question.resolveTs >= d.window.endTs, {
    message: 'resolveTs must be ≥ window.endTs',
    path: ['spec', 'question', 'resolveTs'],
  })
  .refine(d => d.spec.question.resolveTs - d.window.endTs <= 3_600_000, {
    message: 'resolve gap (resolveTs - endTs) must be ≤ 1 hour',
    path: ['spec', 'question', 'resolveTs'],
  });

export type PredictionV0Intent = z.infer<typeof PredictionV0IntentSchema>;

// ── Submission manifest ───────────────────────────────────────────────────────

export const PredictionSubmissionManifestSchema = z.object({
  schemaVersion: z.literal('prediction.v0.submission.v1'),
  generatedAt: z.number().int(),
  intent: IntentProvenanceSchema,
  restorer: ParticipantSchema,
  window: WindowSchema,
  prediction: z.object({
    probability: z.string().regex(/^(0(\.\d+)?|1(\.0+)?)$/, 'must be a decimal in [0,1]'),
    submittedAt: z.number().int(),
    modelId: z.string().min(1),
  }),
  oracleSnapshot: z
    .object({
      feed: HexStringSchema,
      roundId: z.string(),
      answer: z.string(),
      updatedAt: z.number().int(),
    })
    .optional(),
  rationale: z
    .array(
      z.object({
        ts: z.number().int(),
        note: z.string(),
      }),
    )
    .optional(),
  signature: SignatureSchema,
});

export type PredictionSubmissionManifest = z.infer<typeof PredictionSubmissionManifestSchema>;

// ── Verdict manifest ──────────────────────────────────────────────────────────

const CheckSchema = z.object({
  name: z.string(),
  status: z.enum(['PASS', 'FAIL', 'SKIP', 'INDETERMINATE']),
  detail: z.union([z.string(), z.record(z.unknown())]).optional(),
});

export const PredictionVerdictManifestSchema = z.object({
  schemaVersion: z.literal('prediction.v0.verdict.v1'),
  generatedAt: z.number().int(),
  intent: IntentProvenanceSchema,
  evaluator: ParticipantSchema,
  window: WindowSchema,
  verdict: z.enum(['PASS', 'FAIL', 'REJECTED', 'INDETERMINATE']),
  score: z.string(),
  scoreBasis: z.literal('brier.v1'),
  scoreVersion: z.string(),
  oracleReading: z.object({
    feed: HexStringSchema,
    roundId: z.string(),
    answer: z.string(),
    updatedAt: z.number().int(),
    nextRoundUpdatedAt: z.number().int().optional(),
  }),
  claimed: z.object({
    probability: z.string(),
    submittedAt: z.number().int(),
    modelId: z.string(),
    /** Present when the submission was registered on IPFS; omitted for inline/dev. */
    submissionManifestCid: z.string().min(1).optional(),
  }),
  groundTruth: z.enum(['YES', 'NO']),
  checks: z.array(CheckSchema),
  signature: SignatureSchema,
});

export type PredictionVerdictManifest = z.infer<typeof PredictionVerdictManifestSchema>;
