/**
 * prediction.v0 — typed task spec.
 *
 * §4 of spec/2026-04-20-prediction-v0-pis-phase-1-design.md
 *
 * Legacy manifest schemas (prediction.v0.submission.v1, prediction.v0.verdict.v1)
 * have been removed per scope §3.4. Use jinn.execution.v1 SignedEnvelope with
 * PredictionV0RestorationPayloadSchema / PredictionV0VerdictPayloadSchema instead.
 */
import { z } from 'zod';
import { WindowSchema } from './task.js';

const HexStringSchema = z.string().regex(/^0x[0-9a-fA-F]*$/, 'must be a 0x-prefixed hex string');

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

// ── Spec + eligibility + task ────────────────────────────────────────────────

export const PredictionV0SpecSchema = z.object({
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

export const PredictionV0TaskSchema = z
  .object({
    id: z.string(),
    description: z.string().min(1),
    solverType: z.literal('prediction.v0').optional(),
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

export type PredictionV0Task = z.infer<typeof PredictionV0TaskSchema>;
