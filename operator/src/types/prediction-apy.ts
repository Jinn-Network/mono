/**
 * prediction.apy.v0 — typed task spec.
 *
 * Legacy manifest schemas (prediction.apy.v0.submission.v1,
 * prediction.apy.v0.verdict.v1) have been removed per scope §3.4.
 * Use jinn.execution.v1 SignedEnvelope with
 * PredictionApyV0RestorationPayloadSchema / PredictionApyV0VerdictPayloadSchema
 * instead.
 */
import { z } from 'zod/v3';
import { WindowSchema } from './task.js';

const HexStringSchema = z.string().regex(/^0x[0-9a-fA-F]*$/, 'must be a 0x-prefixed hex string');

export const PredictionApyV0SpecSchema = z.object({
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
  /**
   * Latest time after window start for a valid submission: submittedAt ≤
   * startTs + maxSubmissionDelayMs. Default 72h so it does not cut off
   * late-in-window posts on long windows; tighten per market.
   */
  maxSubmissionDelayMs: z.number().int().min(1).default(72 * 3_600_000),
});

export type PredictionApyV0Eligibility = z.infer<typeof PredictionApyV0EligibilitySchema>;

export const PredictionApyV0TaskSchema = z
  .object({
    id: z.string(),
    description: z.string().min(1),
    solverType: z.literal('prediction.apy.v0').optional(),
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
  .refine(
    (d) => {
      const { twaWindowSeconds, sampleCount } = d.spec.metric;
      if (sampleCount < 2) return true;
      const stepMs = Math.floor((twaWindowSeconds * 1000) / (sampleCount - 1));
      return stepMs >= 1000;
    },
    {
      message: 'TWA sample spacing must be at least 1 second (increase window or reduce sampleCount)',
      path: ['spec', 'metric', 'sampleCount'],
    },
  );

export type PredictionApyV0Task = z.infer<typeof PredictionApyV0TaskSchema>;
