import { describe, it, expect } from 'vitest';
import type { CodeDigestRewardRow, DiscoveryAPI } from '../../src/discovery/types.js';

describe('CodeDigestRewardRow shape', () => {
  it('has the documented fields', () => {
    const row: CodeDigestRewardRow = {
      codeDigest: 'sha256:abc',
      attempts: 10,
      passes: 7,
      passRate: 0.7,
      avgScore: 0.62,
      gradedScores: [],
    };
    expect(row.attempts).toBe(10);
    expect(row.passRate).toBeCloseTo(0.7);
  });

  it('CodeDigestRewardRow carries per-attempt gradedScores', () => {
    const row: CodeDigestRewardRow = {
      codeDigest: 'sha256:x', attempts: 3, passes: 1, passRate: 1 / 3,
      avgScore: 0.6, gradedScores: [0.9, 0.5, 0.4],
    };
    expect(row.gradedScores).toHaveLength(3);
  });

  it('DiscoveryAPI declares getCodeDigestRewards', () => {
    // Type-level assertion: a value typed as DiscoveryAPI must have the method.
    const has = (api: DiscoveryAPI): boolean => typeof api.getCodeDigestRewards === 'function';
    expect(has).toBeTypeOf('function');
  });
});
