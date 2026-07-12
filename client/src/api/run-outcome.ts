/**
 * Pure task-relative run-outcome derivation.
 *
 * A *run* carries a technical `state` (pending / COMPLETE / FAILED / RACE_LOST).
 * The task-relative *outcome* is a separate axis: given the verdict envelopes
 * posted against the run's task, did the network judge the run a pass or a fail?
 *
 * This module is the single source of truth for the quorum rule
 * (spec/2026-05-22-run-outcome.md §2). Build code must import
 * `SOLVE_OUTCOME_QUORUM` and these functions rather than re-deriving the
 * majority test, so the rule lives in one place.
 */

export type RunOutcome =
  | 'pass'
  | 'fail'
  | 'awaiting'
  | 'accepted'
  | 'rejected'
  | null;

/**
 * Resolved verdict counts for a task. The indexer folds REJECTED→FAIL, so the
 * quorum denominator is `pass + fail`. INVALID / INDETERMINATE / UNKNOWN
 * verdicts are excluded upstream (never counted into either pole).
 */
export interface VerdictTally {
  pass: number;
  fail: number;
}

/**
 * Strict-majority quorum for a solve run's outcome: a pole must hold *more than*
 * half of the resolved verdicts to decide the outcome. A tie (pass === fail)
 * decides nothing and stays `awaiting`. See spec/2026-05-22-run-outcome.md §2.
 */
export const SOLVE_OUTCOME_QUORUM = 0.5;

/**
 * Derive a solve run's task-relative outcome from its verdict tally.
 *
 * - Non-COMPLETE run → `null` (no outcome axis; the SPA renders `—`).
 * - COMPLETE, no resolved verdicts → `'awaiting'`.
 * - Strict majority PASS → `'pass'`; strict majority FAIL → `'fail'`.
 * - Tie → `'awaiting'`.
 */
export function deriveSolveOutcome(
  state: string,
  tally: VerdictTally | undefined,
): RunOutcome {
  if (state !== 'COMPLETE') return null;
  const pass = tally?.pass ?? 0;
  const fail = tally?.fail ?? 0;
  const resolved = pass + fail;
  if (resolved === 0) return 'awaiting';
  if (pass / resolved > SOLVE_OUTCOME_QUORUM) return 'pass';
  if (fail / resolved > SOLVE_OUTCOME_QUORUM) return 'fail';
  return 'awaiting';
}

/**
 * Derive an evaluate run's outcome: did the operator's own verdict agree with
 * the network's majority pole? Best-effort (spec §6): the operator-verdict join
 * is not yet wired, so callers pass `operatorPassed = undefined` today and this
 * degrades to `'awaiting'`.
 *
 * - Non-COMPLETE run → `null`.
 * - No resolved verdicts, unknown operator verdict, or a tie → `'awaiting'`.
 * - Operator agrees with the majority pole → `'accepted'`; disagrees →
 *   `'rejected'`.
 */
export function deriveEvaluateOutcome(
  state: string,
  operatorPassed: boolean | undefined,
  tally: VerdictTally | undefined,
): RunOutcome {
  if (state !== 'COMPLETE') return null;
  const pass = tally?.pass ?? 0;
  const fail = tally?.fail ?? 0;
  const resolved = pass + fail;
  if (resolved === 0 || operatorPassed === undefined) return 'awaiting';
  if (pass === fail) return 'awaiting';
  const majorityPassed = pass > fail;
  return operatorPassed === majorityPassed ? 'accepted' : 'rejected';
}
