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
 *   - gradedMinSamplesPerArm: minimum per-arm graded scores before the graded
 *     (Tier 2) sensitivity test runs. Below it, Tier 2 is skipped entirely.
 *   - gradedAlpha: significance threshold for the Mann-Whitney graded test.
 */

import { twoProportionZTest, mannWhitneyU } from './revert-stats.js';

export interface RevertPolicy {
  /** Minimum indexed attempts required per arm. Default 30. */
  minSamplesPerArm: number;
  /** Two-sided significance threshold. Default 0.05 (95% confidence). */
  alpha: number;
  /** Recent-attempts window per codeDigest. Default 200. */
  recentAttemptsWindow: number;
  /** Minimum per-arm graded samples before the graded (Tier 2) test runs. Default 10. */
  gradedMinSamplesPerArm: number;
  /** Two-sided significance threshold for the graded test. Default 0.05. */
  gradedAlpha: number;
}

export const DEFAULT_REVERT_POLICY: RevertPolicy = {
  minSamplesPerArm: 30,
  alpha: 0.05,
  recentAttemptsWindow: 200,
  gradedMinSamplesPerArm: 10,
  gradedAlpha: 0.05,
};

export interface CodeDigestAggregate {
  codeDigest: string;
  /** Total indexed attempts for this codeDigest (within the window). */
  attempts: number;
  /** Pass count (verdictEnvelopeMeta.actualPassed === true). */
  passes: number;
  /** passes / attempts; 0 when attempts === 0. */
  passRate: number;
  /** Per-attempt graded scores (passedCount/totalCount) within the window. May be empty (v1). */
  gradedScores: number[];
}

export type RevertReason =
  | 'significant_regression'
  | 'insufficient_samples'
  | 'not_significant'
  | 'no_regression'
  | 'graded_regression_provisional'
  | 'binary_graded_disagree';

export interface RevertDecisionInput {
  withCommit: CodeDigestAggregate;
  atParent: CodeDigestAggregate;
}

export interface RevertDecision {
  withCommit: { codeDigest: string; n: number; passRate: number };
  atParent: { codeDigest: string; n: number; passRate: number };
  /**
   * Tier 1: proportion delta (pass-rate difference, [-1,1]). Tier 2
   * (reason='graded_regression_provisional'): mean graded-score delta.
   * Scale differs by tier — inspect `reason` to interpret.
   */
  delta: number;
  /** p-value from the two-proportion z-test (Tier 1) or Mann-Whitney U (Tier 2). */
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

  const mean = (xs: number[]) => (xs.length ? xs.reduce((s, v) => s + v, 0) / xs.length : 0);
  const gradedReady =
    withCommit.gradedScores.length >= policy.gradedMinSamplesPerArm &&
    atParent.gradedScores.length >= policy.gradedMinSamplesPerArm;
  // gradedDelta is only meaningful when gradedReady; mean([]) === 0 is a sentinel otherwise.
  const gradedDelta = gradedReady ? mean(withCommit.gradedScores) - mean(atParent.gradedScores) : 0;

  // Tier 1 — binary objective.
  const binaryUnderpowered =
    withCommit.attempts < policy.minSamplesPerArm || atParent.attempts < policy.minSamplesPerArm;

  if (!binaryUnderpowered) {
    const stats = twoProportionZTest({
      passesA: withCommit.passes, totalA: withCommit.attempts,
      passesB: atParent.passes, totalB: atParent.attempts,
    });
    const significant = stats.pValue < policy.alpha;
    if (stats.delta >= 0) {
      return { ...base, delta: stats.delta, pValue: stats.pValue, significant, recommendRevert: false, reason: 'no_regression' };
    }
    if (!significant) {
      return { ...base, delta: stats.delta, pValue: stats.pValue, significant, recommendRevert: false, reason: 'not_significant' };
    }
    // Binary says significant regression. Confirmation guardrail: if graded
    // data exists and DISAGREES (graded improved), hold rather than revert.
    if (gradedReady && gradedDelta > 0) {
      return { ...base, delta: stats.delta, pValue: stats.pValue, significant: true, recommendRevert: false, reason: 'binary_graded_disagree' };
    }
    return { ...base, delta: stats.delta, pValue: stats.pValue, significant: true, recommendRevert: true, reason: 'significant_regression' };
  }

  // Tier 2 — graded sensitivity (only when binary is underpowered).
  if (gradedReady) {
    const mw = mannWhitneyU(withCommit.gradedScores, atParent.gradedScores);
    if (mw.pValue < policy.gradedAlpha && gradedDelta < 0) {
      return { ...base, delta: gradedDelta, pValue: mw.pValue, significant: true, recommendRevert: true, reason: 'graded_regression_provisional' };
    }
  }

  return { ...base, delta: withCommit.passRate - atParent.passRate, pValue: 1, significant: false, recommendRevert: false, reason: 'insufficient_samples' };
}

/** Merge a partial policy (e.g. from implStateDir/policy.json) over the defaults. */
export function resolveRevertPolicy(override?: Partial<RevertPolicy>): RevertPolicy {
  return { ...DEFAULT_REVERT_POLICY, ...(override ?? {}) };
}
