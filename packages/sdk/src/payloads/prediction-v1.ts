import { z } from 'zod/v3';
import { DecimalProbabilitySchema, IsoDateTimeSchema } from '../prediction-v1.js';

const Sha256Schema = z.string().regex(/^[0-9a-f]{64}$/);

const EnvelopeRefSchema = z.object({
  cid: z.string(),
  sha256: Sha256Schema,
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

const CheckSchema = z.object({
  name: z.string().min(1),
  status: z.enum(['PASS', 'FAIL', 'SKIP', 'INDETERMINATE']),
  detail: z.union([z.string(), z.record(z.unknown())]).optional(),
});

export const PredictionV1RestorationPayloadSchema = z.object({
  probabilityYes: DecimalProbabilitySchema,
  submittedAt: IsoDateTimeSchema,
  format: z.literal('decimal'),
  modelId: z.string().min(1),
  confidence: z.enum(['low', 'medium', 'high']).optional(),
  methodology: z.string().optional(),
  evidenceCids: z.array(z.string().min(1)).optional(),
  reasoningCid: z.string().min(1).optional(),
  sourceRefs: z
    .array(
      z.object({
        title: z.string().min(1),
        url: z.string().url(),
      }),
    )
    .optional(),
});

export type PredictionV1RestorationPayload = z.infer<typeof PredictionV1RestorationPayloadSchema>;

export const PredictionV1VerdictPayloadSchema = z.preprocess(normalizeLegacySolutionEnvelopePayload, z.object({
  verdict: z.enum(['SCORED', 'REJECTED', 'INVALID', 'INDETERMINATE']),
  outcome: z.enum(['YES', 'NO', 'INVALID']).optional(),
  resolvedAt: IsoDateTimeSchema.optional(),
  resolutionSource: z.object({
    venue: z.literal('polymarket'),
    url: z.string().url(),
    marketId: z.string().min(1),
    conditionId: z.string().min(1),
  }),
  task: z.object({
    cid: z.string(),
    id: z.string().min(1),
  }),
  solutionEnvelope: EnvelopeRefSchema,
  claimed: z
    .object({
      probabilityYes: DecimalProbabilitySchema,
      submittedAt: IsoDateTimeSchema,
      modelId: z.string().min(1),
    })
    .optional(),
  benchmark: z.object({
    probabilityYes: DecimalProbabilitySchema,
    sampledAt: IsoDateTimeSchema,
    method: z.literal('best-bid-ask-midpoint'),
  }),
  scores: z
    .object({
      scoreBasis: z.literal('brier-loss.v1'),
      solverBrier: z.string(),
      consensusBrier: z.string(),
      brierSpread: z.string(),
    })
    .optional(),
  checks: z.array(CheckSchema),
}));

export type PredictionV1VerdictPayload = z.infer<typeof PredictionV1VerdictPayloadSchema>;
