import { describe, expect, it } from 'vitest';
import { syntheticClaimBlocked } from '../../src/solver-types/_swe-rebench-v2-synthetic-claim.js';

describe('syntheticClaimBlocked', () => {
  it('blocks minter claiming own mint', () => {
    expect(syntheticClaimBlocked({
      synthetic: true,
      minterSafe: '0xAbc',
    }, '0xabc')).toMatch(/minter/);
  });

  it('allows unrelated solver', () => {
    expect(syntheticClaimBlocked({
      synthetic: true,
      minterSafe: '0xAbc',
    }, '0xDef')).toBeNull();
  });
});
