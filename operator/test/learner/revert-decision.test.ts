import { describe, it, expect } from 'vitest';
import {
  decideRevert,
  DEFAULT_REVERT_POLICY,
  type CodeDigestAggregate,
} from '../../src/learner/revert-decision.js';

const agg = (passes: number, attempts: number): CodeDigestAggregate => ({
  codeDigest: 'sha256:x',
  attempts,
  passRate: attempts > 0 ? passes / attempts : 0,
  passes,
  gradedScores: [],
});

describe('decideRevert', () => {
  it('recommends revert when delta<0 and p<alpha and both arms meet the floor', () => {
    const r = decideRevert(
      { withCommit: agg(40, 100), atParent: agg(80, 100) },
      DEFAULT_REVERT_POLICY,
    );
    expect(r.recommendRevert).toBe(true);
    expect(r.delta).toBeLessThan(0);
    expect(r.pValue).toBeLessThan(DEFAULT_REVERT_POLICY.alpha);
    expect(r.reason).toBe('significant_regression');
  });

  it('does NOT revert when an arm is below the sample floor', () => {
    const r = decideRevert(
      { withCommit: agg(2, 5), atParent: agg(80, 100) }, // withCommit total 5 < 30
      DEFAULT_REVERT_POLICY,
    );
    expect(r.recommendRevert).toBe(false);
    expect(r.reason).toBe('insufficient_samples');
  });

  it('treats a zero-attempt codeDigest as insufficient_samples, not pass-rate 0', () => {
    const r = decideRevert(
      { withCommit: agg(0, 0), atParent: agg(80, 100) },
      DEFAULT_REVERT_POLICY,
    );
    expect(r.recommendRevert).toBe(false);
    expect(r.reason).toBe('insufficient_samples');
  });

  it('does NOT revert when the regression is not significant (worse but p>=alpha)', () => {
    const r = decideRevert(
      { withCommit: agg(48, 100), atParent: agg(52, 100) }, // small diff
      DEFAULT_REVERT_POLICY,
    );
    expect(r.recommendRevert).toBe(false);
    expect(r.delta).toBeLessThan(0);
    expect(r.reason).toBe('not_significant');
  });

  it('does NOT revert when the commit IMPROVED things (delta>0)', () => {
    const r = decideRevert(
      { withCommit: agg(90, 100), atParent: agg(50, 100) },
      DEFAULT_REVERT_POLICY,
    );
    expect(r.recommendRevert).toBe(false);
    expect(r.reason).toBe('no_regression');
  });

  it('exposes documented constants (no magic numbers)', () => {
    expect(DEFAULT_REVERT_POLICY.minSamplesPerArm).toBe(30);
    expect(DEFAULT_REVERT_POLICY.alpha).toBe(0.05);
    expect(DEFAULT_REVERT_POLICY.recentAttemptsWindow).toBe(200);
  });
});

const P = DEFAULT_REVERT_POLICY;
const arm = (codeDigest: string, attempts: number, passes: number, gradedScores: number[]): CodeDigestAggregate =>
  ({ codeDigest, attempts, passes, passRate: attempts ? passes / attempts : 0, gradedScores });

describe('two-tier graded gate (#1019)', () => {
  it('tier 2 rescues an insufficient-binary case with a significant graded regression', () => {
    // binary underpowered (5<30); 10 graded scores per arm = at the gradedMinSamplesPerArm floor
    const withCommit = arm('w', 5, 1, [0.1, 0.15, 0.2, 0.1, 0.05, 0.12, 0.08, 0.11, 0.09, 0.13]);
    const atParent = arm('p', 5, 4, [0.85, 0.9, 0.8, 0.95, 0.88, 0.82, 0.91, 0.86, 0.89, 0.84]);
    const d = decideRevert({ withCommit, atParent }, P);
    expect(d.reason).toBe('graded_regression_provisional');
    expect(d.recommendRevert).toBe(true);
  });

  it('holds (does not revert) when binary says regress but graded says improve', () => {
    // binary: 18/40 vs 30/40 (regress); graded: 0.9 vs 0.4 (improve) → hold
    const withCommit = arm('w', 40, 18, Array(10).fill(0.9));
    const atParent = arm('p', 40, 30, Array(10).fill(0.4));
    const d = decideRevert({ withCommit, atParent }, P);
    expect(d.reason).toBe('binary_graded_disagree');
    expect(d.recommendRevert).toBe(false);
  });

  it('reverts on significant binary regression when graded agrees (or is absent)', () => {
    const withCommit = arm('w', 40, 8, []);
    const atParent = arm('p', 40, 34, []);
    const d = decideRevert({ withCommit, atParent }, P);
    expect(d.reason).toBe('significant_regression');
    expect(d.recommendRevert).toBe(true);
  });

  it('abstains when both tiers are underpowered', () => {
    const withCommit = arm('w', 3, 1, [0.5, 0.5, 0.5]);
    const atParent = arm('p', 3, 2, [0.5, 0.5, 0.5]);
    const d = decideRevert({ withCommit, atParent }, P);
    expect(d.reason).toBe('insufficient_samples');
    expect(d.recommendRevert).toBe(false);
  });

  it('degrades to binary-only when there are no graded scores (v1 window)', () => {
    const withCommit = arm('w', 5, 1, []);
    const atParent = arm('p', 5, 4, []);
    const d = decideRevert({ withCommit, atParent }, P);
    expect(d.reason).toBe('insufficient_samples');
  });
});
