/**
 * Shared types for the portfolio-v0-evaluator.
 *
 * Single source of truth for Check, Verdict, and related types.
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

// ── PortfolioV0EvaluatorConfig ────────────────────────────────────────────────

export interface PortfolioV0EvaluatorConfig {
  /** Set by {@link buildHarnesses} for CLI registries. */
  stub?: boolean;
  /** Evaluator Safe multisig address (injected by daemon). */
  safeAddress?: string;
  /** Evaluator agent EOA address (injected by daemon). */
  agentEoa?: string;
  /** Evaluator agent EOA private key (injected by daemon). */
  agentEoaPrivateKey?: string;
  /** Test-only: injectable deps to avoid real network calls. */
  _testDeps?: {
    hlPortfolioPeriod?: (user: string) => Promise<{ accountValueHistory: HlGridPoint[] } | null>;
    hlUserFillsByTime?: (user: string, startTime: number, endTime?: number) => Promise<{ fills: HlFill[]; startTimeClamped: boolean }>;
  };
}
