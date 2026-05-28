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
