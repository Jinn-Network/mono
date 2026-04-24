/**
 * portfolio.v0 — typed intent spec, restoration manifest, and verdict manifest.
 *
 * §4   portfolio.v0 concrete intent shape
 * §5.1 Restoration manifest `portfolio.v0.manifest.v1`
 * §5.2 Verdict manifest     `portfolio.v0.eval.manifest.v1`
 */

import { z } from 'zod';
import { WindowSchema } from './desired-state.js';

// ── Shared primitives ────────────────────────────────────────────────────────

/** `0x`-prefixed hex string (address or tx hash). */
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

const SnapshotSchema = z.object({
  capturedAt: z.number().int(),
  hlTime: z.number().int(),
  payload: z.unknown(),
});

// Evaluator's rederived snapshots don't carry hlTime — only the restorer captures it during the live window.
const EvalSnapshotSchema = z.object({
  capturedAt: z.number().int(),
  payload: z.unknown(),
});

const ArtifactSchema = z.object({
  cid: z.string().min(1),
  // Open string — see §5.3 for conventions
  role: z.string(),
  sha256: z.string().optional(),
  metadata: z.record(z.unknown()).optional(),
  tags: z.array(z.string()).optional(),
  access: z
    .object({
      kind: z.enum(['open', 'x402-gated']),
      endpoint: z.string().optional(),
      priceUsdc: z.string().optional(),
    })
    .optional(),
});

export type Artifact = z.infer<typeof ArtifactSchema>;

/** Artifact shape as returned by a restorer impl — uses `path` (local file) instead of `cid` (assigned after upload). */
export type OutputArtifact = Omit<Artifact, 'cid' | 'sha256'> & { path: string };

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

// ── §5.1 — Restoration manifest ──────────────────────────────────────────────

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

export type RationaleEntry = z.infer<typeof RationaleEntrySchema>;

export const RestorationManifestSchema = z.object({
  schemaVersion: z.literal('portfolio.v0.manifest.v1'),
  generatedAt: z.number().int(),

  intent: IntentProvenanceSchema,
  restorer: ParticipantSchema,
  window: WindowSchema,

  preSnapshot: SnapshotSchema,
  postSnapshot: SnapshotSchema,

  fills: z.array(z.unknown()),

  gating: GatingSchema,
  informational: InformationalSchema,

  artifacts: z.array(ArtifactSchema),

  rationale: z.array(RationaleEntrySchema).optional(),

  signature: SignatureSchema,
});

export type RestorationManifest = z.infer<typeof RestorationManifestSchema>;

// ── §5.2 — Verdict manifest ───────────────────────────────────────────────────

const CheckSchema = z.object({
  name: z.string(),
  status: z.enum(['PASS', 'FAIL', 'SKIP']),
  detail: z.union([z.string(), z.record(z.unknown())]).optional(),
});

export const VerdictManifestSchema = z.object({
  schemaVersion: z.literal('portfolio.v0.eval.manifest.v1'),
  generatedAt: z.number().int(),

  intent: IntentProvenanceSchema,
  evaluator: ParticipantSchema,
  window: WindowSchema,

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

  signature: SignatureSchema,
});

export type VerdictManifest = z.infer<typeof VerdictManifestSchema>;
