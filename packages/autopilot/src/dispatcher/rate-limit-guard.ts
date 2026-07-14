/**
 * Rate-limit guard — circuit-breaker around `runCycle`.
 *
 * The orchestrator (`scripts/run-autopilot.ts`) wraps every `runCycle` call
 * with `gateOrRun`. If the per-cycle Project snapshot reports that GraphQL
 * `rateLimit.remaining` has fallen below {@link DEFAULT_FLOOR}, `gateOrRun`
 * returns a `RateLimitSkip` carrying a calculated `sleepMs` (clamped to
 * `[0, 1 hour]`) and `runCycle` is NOT invoked.
 *
 * The orchestrator then schedules the next attempt via `setTimeout(_, sleepMs)`
 * — sleeping happens at the orchestrator level so `runCycle` stays pure and
 * the gate stays unit-testable.
 *
 * The floor exists to leave headroom for in-flight sessions, which call `gh`
 * independently of the dispatcher's per-cycle budget. Without the guard, a
 * dispatcher cycle that succeeds with `remaining=1` could leave nothing for a
 * session mid-`gh pr create`.
 *
 * Tracking: jinn-mono#585.
 */

import { runCycle as defaultRunCycle } from './loop.js';
import type { CycleDeps, CycleReport } from './loop.js';
import type { ProjectSnapshot } from './project-snapshot.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * Minimum GraphQL points that must remain before the dispatcher will run a
 * cycle. Below this, the gate trips and the orchestrator sleeps until the
 * rate-limit window resets.
 *
 * 500 points is comfortable headroom — a typical session consumes 50-200
 * points over its lifetime, so 500 covers at least one concurrent session
 * completing its work even if the dispatcher's own consumption ticks up.
 */
export const DEFAULT_FLOOR = 500;

/** Hard upper bound on the gate's sleep, in milliseconds. Defensive against
 *  malformed `resetAt` from upstream — GitHub's window is always ≤1 hour. */
const MAX_SLEEP_MS = 60 * 60 * 1000;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface RateLimitSkip {
  skipped: true;
  reason: 'budget-low';
  remaining: number;
  /** Suggested sleep before the next attempt. Clamped to `[0, 1 hour]`. */
  sleepMs: number;
  /** Echo of `snapshot.rateLimit.resetAt` for logging. */
  resetAt: string;
}

export type GateResult = CycleReport | RateLimitSkip;

export interface GateOpts {
  /** Override the gate's floor (default {@link DEFAULT_FLOOR}). */
  floor?: number;
  /** Override the clock (default `Date.now`). For deterministic testing. */
  now?: () => number;
  /** Inject the runCycle function (default real `runCycle` from `loop.ts`).
   *  For unit-testing the gate in isolation. */
  runCycleFn?: (snap: ProjectSnapshot, deps: CycleDeps) => Promise<CycleReport>;
}

// ---------------------------------------------------------------------------
// Type guard
// ---------------------------------------------------------------------------

export function isSkipped(result: GateResult): result is RateLimitSkip {
  return (result as RateLimitSkip).skipped === true;
}

// ---------------------------------------------------------------------------
// Gate
// ---------------------------------------------------------------------------

/**
 * Gate the cycle on GraphQL budget. Returns the cycle's `CycleReport` if the
 * snapshot's `rateLimit.remaining >= floor`; otherwise returns a
 * {@link RateLimitSkip} carrying the suggested sleep duration.
 *
 * @param snapshot The cycle's Project snapshot (already fetched by the
 *   orchestrator; the gate reads only `snapshot.rateLimit`).
 * @param deps `runCycle`'s deps, passed through unchanged when the gate
 *   does not trip.
 * @param opts Optional overrides for floor, clock, and `runCycle`.
 */
export async function gateOrRun(
  snapshot: ProjectSnapshot,
  deps: CycleDeps,
  opts: GateOpts = {},
): Promise<GateResult> {
  const floor = opts.floor ?? DEFAULT_FLOOR;
  const now = opts.now ?? (() => Date.now());
  const runCycleFn = opts.runCycleFn ?? defaultRunCycle;

  if (snapshot.rateLimit.remaining >= floor) {
    return runCycleFn(snapshot, deps);
  }

  const resetMs = Date.parse(snapshot.rateLimit.resetAt);
  const rawSleep = Number.isFinite(resetMs) ? resetMs - now() + 5_000 : 0;
  const sleepMs = Math.max(0, Math.min(rawSleep, MAX_SLEEP_MS));

  return {
    skipped: true,
    reason: 'budget-low',
    remaining: snapshot.rateLimit.remaining,
    sleepMs,
    resetAt: snapshot.rateLimit.resetAt,
  };
}
