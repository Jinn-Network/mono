/**
 * Restorer engine — startup crash recovery.
 *
 * §6.5 of spec/2026-04-17-portfolio-v0-design.md
 *
 * This module re-exports the `recoverInFlight` capability cleanly for callers
 * that want a standalone function rather than calling the engine method directly.
 * The recovery algorithm lives in `RestorationEngine._recoverDispatch`; this
 * module is a thin adapter for dependency-injection friendly usage.
 */

import type { RestorationEngine, RecoveryReport } from './engine.js';

/**
 * Run startup recovery pass on the given engine.
 *
 * Scans all in-flight intents from the persistence layer and dispatches each
 * one to the appropriate resume handler based on current state. Errors are
 * collected per-intent (failed intents are marked FAILED in the DB); the
 * function itself does not throw.
 *
 * @returns Array of per-intent recovery reports (outcome 'ok' or 'failed').
 */
export async function recoverInFlight(
  engine: RestorationEngine,
): Promise<RecoveryReport[]> {
  return engine.recoverInFlight();
}
