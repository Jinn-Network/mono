/**
 * prediction.apy.v0 payloads — restoration + verdict, for use inside
 * jinn.execution.v1 envelopes.
 */

import { z } from 'zod/v3';

const HexStringSchema = z.string().regex(/^0x[0-9a-fA-F]*$/, 'must be a 0x-prefixed hex string');
const IntegerStringSchema = z.string().regex(/^-?\d+$/, 'must be an integer string');

// ── Restoration payload ───────────────────────────────────────────────────────

export const PredictionApyV0RestorationPayloadSchema = z.object({
  prediction: z.object({
    predictedBps: IntegerStringSchema,
    submittedAt: z.number().int(),
    modelId: z.string().min(1),
  }),
});

export type PredictionApyV0RestorationPayload = z.infer<
  typeof PredictionApyV0RestorationPayloadSchema
>;

// ── Verdict payload ───────────────────────────────────────────────────────────

const CheckSchema = z.object({
  name: z.string(),
  status: z.enum(['PASS', 'FAIL', 'SKIP', 'INDETERMINATE']),
  detail: z.union([z.string(), z.record(z.unknown())]).optional(),
});

const EnvelopeRefSchema = z.object({
  cid: z.string().min(1),
  sha256: z.string().regex(/^[0-9a-f]{64}$/),
});

function normalizeLegacySolutionEnvelopePayload(value: unknown): unknown {
  if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
    const payload = value as Record<string, unknown>;
    if (payload['solutionEnvelope'] === undefined && payload['restorationEnvelope'] !== undefined) {
      return { ...payload, solutionEnvelope: payload['restorationEnvelope'] };
    }
  }
  return value;
}

const VerificationCheckSchema = z.object({
  name: z.string(),
  passed: z.boolean(),
  detail: z.string().optional(),
});

const VerificationOfRestorationSchema = z.object({
  claimedTier: z.enum(['self-signed', 'committed', 'consensus', 'attested', 'proved']),
  sdkVersion: z.string(),
  timestamp: z.number().int(),
  checks: z.array(VerificationCheckSchema),
  overall: z.enum(['valid', 'invalid']),
});

export const PredictionApyV0VerdictPayloadSchema = z.preprocess(normalizeLegacySolutionEnvelopePayload, z.object({
  solutionEnvelope: EnvelopeRefSchema,
  verificationOfRestoration: VerificationOfRestorationSchema,
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
    submissionManifestCid: z.string().min(1).optional(),
  }),
  groundTruth: z.object({
    twApyBps: IntegerStringSchema,
    errorBps: z.string().regex(/^\d+$/),
  }),
  checks: z.array(CheckSchema),
}));

export type PredictionApyV0VerdictPayload = z.infer<typeof PredictionApyV0VerdictPayloadSchema>;
