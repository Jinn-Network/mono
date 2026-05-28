/**
 * Revert-decision logic for the learner's Memory-consolidation phase (#764).
 *
 * Given per-codeDigest pass-rate aggregates for a candidate Improve commit
 * (`withCommit`) and its parent (`atParent`), decide whether the commit
 * significantly regressed the frozen-eval pass rate and should be reverted.
 *
 * Thresholds are explicit and documented here (AC4) — not magic constants:
 *   - minSamplesPerArm: minimum indexed attempts required in EACH arm before a
 *     statistical test is meaningful. Below it, plateau is expected Level-1
 *     behaviour, so we abstain (reason 'insufficient_samples').
 *   - alpha: significance threshold (revert only when p < alpha, two-sided).
 *   - recentAttemptsWindow: how many most-recent attempts per codeDigest the
 *     aggregate is computed over. Overridable via implStateDir/policy.json
 *     (`policy.revert.recentAttemptsWindow`), mirroring policy.maxNotesBytes.
 */

import { twoProportionZTest } from './revert-stats.js';

export interface RevertPolicy {
  /** Minimum indexed attempts required per arm. Default 30. */
  minSamplesPerArm: number;
  /** Two-sided significance threshold. Default 0.05 (95% confidence). */
  alpha: number;
  /** Recent-attempts window per codeDigest. Default 200. */
  recentAttemptsWindow: number;
}

export const DEFAULT_REVERT_POLICY: RevertPolicy = {
  minSamplesPerArm: 30,
  alpha: 0.05,
  recentAttemptsWindow: 200,
};

export interface CodeDigestAggregate {
  codeDigest: string;
  /** Total indexed attempts for this codeDigest (within the window). */
  attempts: number;
  /** Pass count (verdictEnvelopeMeta.actualPassed === true). */
  passes: number;
  /** passes / attempts; 0 when attempts === 0. */
  passRate: number;
}

export type RevertReason =
  | 'significant_regression'
  | 'insufficient_samples'
  | 'not_significant'
  | 'no_regression';

export interface RevertDecisionInput {
  withCommit: CodeDigestAggregate;
  atParent: CodeDigestAggregate;
}

export interface RevertDecision {
  withCommit: { codeDigest: string; n: number; passRate: number };
  atParent: { codeDigest: string; n: number; passRate: number };
  delta: number;
  pValue: number;
  significant: boolean;
  recommendRevert: boolean;
  reason: RevertReason;
}

export function decideRevert(
  input: RevertDecisionInput,
  policy: RevertPolicy = DEFAULT_REVERT_POLICY,
): RevertDecision {
  const { withCommit, atParent } = input;
  const base = {
    withCommit: { codeDigest: withCommit.codeDigest, n: withCommit.attempts, passRate: withCommit.passRate },
    atParent: { codeDigest: atParent.codeDigest, n: atParent.attempts, passRate: atParent.passRate },
  };

  // Sample floor first — a zero-attempt codeDigest is "insufficient_samples",
  // NOT pass-rate zero (a fresh promotion that has not run yet is not a regression).
  if (withCommit.attempts < policy.minSamplesPerArm || atParent.attempts < policy.minSamplesPerArm) {
    return { ...base, delta: withCommit.passRate - atParent.passRate, pValue: 1, significant: false, recommendRevert: false, reason: 'insufficient_samples' };
  }

  const stats = twoProportionZTest({
    passesA: withCommit.passes,
    totalA: withCommit.attempts,
    passesB: atParent.passes,
    totalB: atParent.attempts,
  });
  const significant = stats.pValue < policy.alpha;

  if (stats.delta >= 0) {
    return { ...base, delta: stats.delta, pValue: stats.pValue, significant, recommendRevert: false, reason: 'no_regression' };
  }
  if (!significant) {
    return { ...base, delta: stats.delta, pValue: stats.pValue, significant, recommendRevert: false, reason: 'not_significant' };
  }
  return { ...base, delta: stats.delta, pValue: stats.pValue, significant: true, recommendRevert: true, reason: 'significant_regression' };
}

/** Merge a partial policy (e.g. from implStateDir/policy.json) over the defaults. */
export function resolveRevertPolicy(override?: Partial<RevertPolicy>): RevertPolicy {
  return { ...DEFAULT_REVERT_POLICY, ...(override ?? {}) };
}
