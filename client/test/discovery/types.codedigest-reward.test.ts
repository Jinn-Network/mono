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
    };
    expect(row.attempts).toBe(10);
    expect(row.passRate).toBeCloseTo(0.7);
  });

  it('DiscoveryAPI declares getCodeDigestRewards', () => {
    // Type-level assertion: a value typed as DiscoveryAPI must have the method.
    const has = (api: DiscoveryAPI): boolean => typeof api.getCodeDigestRewards === 'function';
    expect(has).toBeTypeOf('function');
  });
});
