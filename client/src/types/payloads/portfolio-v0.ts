/**
 * portfolio.v0 payloads — restoration + verdict, for use inside
 * jinn.execution.v1 envelopes.
 */

import { z } from 'zod/v3';

const SnapshotSchema = z.object({
  capturedAt: z.number().int(),
  hlTime: z.number().int(),
  payload: z.unknown(),
});

const EvalSnapshotSchema = z.object({
  capturedAt: z.number().int(),
  payload: z.unknown(),
});

const GatingSchema = z.object({
  equityReturnPct: z.string(),
  maxDrawdownPct: z.string(),
  closedTradesCount: z.number().int(),
  tradedNotionalMultiple: z.string(),
});

const InformationalSchema = z
  .object({
    sharpe: z.string().optional(),
    sortino: z.string().optional(),
    calmar: z.string().optional(),
    profitFactor: z.string().optional(),
    expectancy: z.string().optional(),
    winRate: z.string().optional(),
    holdTimeMs: z
      .object({ mean: z.number(), median: z.number(), p95: z.number() })
      .optional(),
    leverageHistogram: z.record(z.number()).optional(),
    longShortMix: z
      .object({ longCount: z.number().int(), shortCount: z.number().int() })
      .optional(),
  })
  .optional();

const RationaleEntrySchema = z.object({
  ts: z.number().int(),
  sessionId: z.string(),
  note: z.string(),
  relatedFillTids: z.array(z.number().int()).optional(),
});

export const PortfolioV0RestorationPayloadSchema = z.object({
  preSnapshot: SnapshotSchema,
  postSnapshot: SnapshotSchema,
  fills: z.array(z.unknown()),
  gating: GatingSchema,
  informational: InformationalSchema,
  rationale: z.array(RationaleEntrySchema).optional(),
});

export type PortfolioV0RestorationPayload = z.infer<typeof PortfolioV0RestorationPayloadSchema>;

const CheckSchema = z.object({
  name: z.string(),
  status: z.enum(['PASS', 'FAIL', 'SKIP']),
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

export const PortfolioV0VerdictPayloadSchema = z.preprocess(normalizeLegacySolutionEnvelopePayload, z.object({
  solutionEnvelope: EnvelopeRefSchema,
  verificationOfRestoration: VerificationOfRestorationSchema,
  verdict: z.enum(['PASS', 'FAIL', 'REJECTED', 'INDETERMINATE']),
  score: z.string(),
  scoreBasis: z.string(),
  scoreVersion: z.string(),
  rederived: z.object({
    preSnapshot: EvalSnapshotSchema,
    postSnapshot: EvalSnapshotSchema,
    fills: z.array(z.unknown()),
    gating: z.record(z.unknown()),
  }),
  claimed: z.object({
    preSnapshot: EvalSnapshotSchema,
    postSnapshot: EvalSnapshotSchema,
    fillsHash: z.string(),
    fillsCount: z.number().int(),
    gating: z.record(z.unknown()),
  }),
  checks: z.array(CheckSchema),
}));

export type PortfolioV0VerdictPayload = z.infer<typeof PortfolioV0VerdictPayloadSchema>;
