/**
 * Restorer-impl interface — §6.7 of the portfolio.v0 design spec.
 *
 * Pure type definitions; no runtime side effects.
 */

import type { DesiredState } from '../types/desired-state.js';
import type { OutputArtifact, RationaleEntry, Snapshot } from '../types/portfolio.js';

// ── RestorationContext ────────────────────────────────────────────────────────

export interface RestorationContext {
  intent: DesiredState;
  /** Persistent directory for impl-specific state. */
  implStateDir: string;
  /** Ephemeral working directory (cleared between attempts). */
  workingDir: string;
  log: (event: { level: 'info' | 'warn' | 'error'; msg: string; data?: unknown }) => void;
  /** Fires at window.endTs. */
  abort: AbortSignal;
  msUntilEndTs: () => number;
}

// ── RestorationOutput ─────────────────────────────────────────────────────────

export interface RestorationOutput {
  venueRef: { name: string };

  /** Optional — evaluator impls that do not operate on a venue leave these undefined. */
  preSnapshot?: Snapshot;
  postSnapshot?: Snapshot;
  fills?: unknown[];

  /** Shape is per spec.kind convention. */
  gating: Record<string, unknown>;
  informational?: Record<string, unknown>;

  artifacts?: OutputArtifact[];
  rationale?: RationaleEntry[];
}

// ── RestorerImpl ──────────────────────────────────────────────────────────────

export interface RestorerImpl {
  name: string;
  /** semver */
  version: string;
  /**
   * Return true if this impl should handle the given (kind, type) pair.
   *
   * `type` reflects DesiredState.type:
   *   - 'restoration' (or undefined — legacy default): the impl runs a restoration attempt
   *   - 'evaluation': the impl runs as an evaluator producing a verdict
   *
   * A restorer impl for kind=X should return true for type !== 'evaluation'.
   * An evaluator impl for kind=X should return true for type === 'evaluation'.
   */
  supports(ctx: { kind: string; type?: 'restoration' | 'evaluation' }): boolean;
  canAttempt?(intent: DesiredState): Promise<{ ok: true } | { ok: false; reason: string }>;
  run(ctx: RestorationContext): Promise<RestorationOutput>;
}
