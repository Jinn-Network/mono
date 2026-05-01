/**
 * portfolio.v0 — typed intent spec.
 *
 * §4 portfolio.v0 concrete intent shape
 *
 * Legacy manifest schemas (portfolio.v0.manifest.v1, portfolio.v0.eval.manifest.v1)
 * have been removed per scope §3.4. Use jinn.execution.v1 SignedEnvelope with
 * PortfolioV0RestorationPayloadSchema / PortfolioV0VerdictPayloadSchema instead.
 */

import { z } from 'zod';
import { WindowSchema } from './desired-state.js';

// ── Shared primitives ────────────────────────────────────────────────────────

/** `0x`-prefixed hex string (address or tx hash). */
const HexStringSchema = z.string().regex(/^0x[0-9a-fA-F]*$/, 'must be a 0x-prefixed hex string');

const ArtifactSchema = z.object({
  cid: z.string().min(1),
  // Open string — see §5.3 for conventions
  artifactType: z.string(),
  sha256: z.string().optional(),
  metadata: z.record(z.unknown()).optional(),
  tags: z.array(z.string()).optional(),
  access: z
    .object({
      endpoint: z.string().optional(),
      priceUsdc: z.string().regex(/^\d+(\.\d+)?$/).optional(),
    })
    .optional(),
});

export type Artifact = z.infer<typeof ArtifactSchema>;

/** Artifact shape as returned by a restorer impl — uses `path` (local file) instead of `cid` (assigned after upload). */
export type OutputArtifact = Omit<Artifact, 'cid' | 'sha256'> & { path: string };

const SnapshotSchema = z.object({
  capturedAt: z.number().int(),
  hlTime: z.number().int(),
  payload: z.unknown(),
});

export type Snapshot = z.infer<typeof SnapshotSchema>;

// ── §4.1 — portfolio.v0 intent spec ──────────────────────────────────────────

export const PortfolioV0SpecSchema = z.object({
  kind: z.literal('portfolio.v0'),
  account: z.object({
    venue: z.enum(['hyperliquid-testnet', 'hyperliquid-mainnet']),
    masterAddress: HexStringSchema,
  }),
  target: z.object({
    metric: z.literal('equity_return_pct'),
    minReturnPct: z.number(),
  }),
  constraint: z.object({
    maxDrawdownPct: z.number(),
  }),
});

export type PortfolioV0Spec = z.infer<typeof PortfolioV0SpecSchema>;

export const PortfolioV0EligibilitySchema = z.object({
  minClosedTrades: z.number().int().default(20),
  minTradedNotionalMultiple: z.number().default(5.0),
});

export type PortfolioV0Eligibility = z.infer<typeof PortfolioV0EligibilitySchema>;

/**
 * Full portfolio.v0 intent — composes the generic RestorationJob fields with the
 * portfolio-specific spec + eligibility fields.  The 24 h window constraint is
 * enforced by a Zod refinement.
 */
export const PortfolioV0IntentSchema = z
  .object({
    // id is required here — generic RestorationJob parsing assigns a UUID if missing; portfolio.v0 intents must already have one assigned.
    id: z.string(),
    description: z.string().min(1),
    window: WindowSchema,
    spec: PortfolioV0SpecSchema,
    eligibility: PortfolioV0EligibilitySchema.default({}),
  })
  .refine((d) => d.window.endTs - d.window.startTs === 86_400_000, {
    message: 'window must be exactly 24 h (endTs - startTs === 86_400_000 ms)',
    path: ['window'],
  });

export type PortfolioV0Intent = z.infer<typeof PortfolioV0IntentSchema>;

// ── Rationale entry — kept for use in portfolio-v0 restorer impl ─────────────

const RationaleEntrySchema = z.object({
  ts: z.number().int(),
  sessionId: z.string(),
  note: z.string(),
  relatedFillTids: z.array(z.number().int()).optional(),
});

export type RationaleEntry = z.infer<typeof RationaleEntrySchema>;
