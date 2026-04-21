/**
 * Shared types for the portfolio-v0-evaluator.
 *
 * Single source of truth for Check, Verdict, EvalSpec, and related types.
 * Import from here instead of declaring locally in each check module.
 */

import type { HlFill, HlGridPoint } from '../../../venues/hyperliquid/types.js';

// ── Check ─────────────────────────────────────────────────────────────────────

export type CheckStatus = 'PASS' | 'FAIL' | 'SKIP';

export interface Check {
  name: string;
  status: CheckStatus;
  detail?: string | Record<string, unknown>;
}

// ── Verdict ───────────────────────────────────────────────────────────────────

export type Verdict = 'PASS' | 'FAIL' | 'REJECTED' | 'INDETERMINATE';

// ── EvalSpec ──────────────────────────────────────────────────────────────────

export interface EvalSpec {
  kind: 'portfolio.v0.eval';
  targetManifestCid: string;
  targetIntentCid: string;
  targetCreationTx: string;
  targetRequestId: string;
  /** Block number at which the evaluated intent was created on-chain. */
  targetCreationBlock: number;
  // Evaluator identity injected by daemon (not part of the on-chain intent)
  safeAddress?: string;
  agentEoa?: string;
  agentEoaPrivateKey?: string;
  ipfsGatewayUrl?: string;
  /** Test-only: injectable deps to avoid real network calls. */
  _testDeps?: {
    fetchFromIpfs?: (gatewayUrl: string, cid: string) => Promise<unknown>;
    hlPortfolioPeriod?: (user: string) => Promise<{ accountValueHistory: HlGridPoint[] } | null>;
    hlUserFillsByTime?: (user: string, startTime: number, endTime?: number) => Promise<{ fills: HlFill[]; startTimeClamped: boolean }>;
  };
}
