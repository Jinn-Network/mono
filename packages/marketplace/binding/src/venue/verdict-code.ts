// SPDX-License-Identifier: MIT

/**
 * On-chain verdict codes, re-homed verbatim from `operator/src/adapters/mech/verdict-code.ts`
 * (design §14 "declared impact"; `contracts/src/tasks/TaskCoordinator.sol`'s `VerdictCode`
 * enum). `recordVerdict` rejects 0 (None) and anything > 4.
 *
 *   None       = 0  -- not a valid submission value
 *   Pass       = 1  -- evaluation concluded the restoration was correct
 *   Fail       = 2  -- evaluation concluded the restoration was incorrect
 *   Invalid    = 3  -- the evaluator could not produce a verdict (missing data, harness error, etc.)
 *   Unresolved = 4  -- the outcome cannot be determined yet (prediction window still open, etc.)
 */
export const VerdictCode = {
  None: 0,
  Pass: 1,
  Fail: 2,
  Invalid: 3,
  Unresolved: 4,
} as const;

export type VerdictCode = (typeof VerdictCode)[keyof typeof VerdictCode];

/**
 * Venue-level mapping (design §6.4): a venue-reported verdict maps to
 * `{Pass, Fail, Invalid, Unresolved}` with NO defaulting -- a missing or unrecognized verdict
 * value throws rather than being guessed as `Invalid(3)`.
 *
 * NOT the reader for a Result Evaluation Statement's `predicate.verdict`. That field has one
 * ratified vocabulary (`pass|fail|inconclusive`, `ResultEvaluationStatementShape`) and one reader,
 * `decisionGradeVerdictCode` in `../named-checks.js` -- the one the named gate itself applies. This
 * function's vocabulary is wider yet has no `inconclusive` case, so reading a Statement with it
 * refuses exactly the verdicts the gate expects to see (defect #41).
 */
export function verdictCodeFromValue(raw: unknown): VerdictCode {
  const normalized = typeof raw === "string" ? raw.toUpperCase() : raw;
  switch (normalized) {
    case "PASS":
    case "SCORED":
      return VerdictCode.Pass;
    case "FAIL":
    case "REJECTED":
      return VerdictCode.Fail;
    case "INVALID":
      return VerdictCode.Invalid;
    case "INDETERMINATE":
    case "UNRESOLVED":
      return VerdictCode.Unresolved;
    default:
      throw new Error(
        `missing or unrecognized verdict value (got=${String(raw)}); refusing to claim Invalid(3) without an explicit evaluator verdict`,
      );
  }
}
