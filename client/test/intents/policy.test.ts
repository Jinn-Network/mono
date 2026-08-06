import { describe, expect, it } from 'vitest';
import { describeClaimPolicyIntent } from '../../src/intents/policy.js';

describe('describeClaimPolicyIntent (intent-module law)', () => {
  it('reports a configured policy verbatim in a versioned envelope', () => {
    const result = describeClaimPolicyIntent({
      claimPolicy: { mode: 'match-legacy-manifest-digest', spendCapWei: '1000', aiUnitCap: 5 },
    });
    expect(result.schemaVersion).toBe(1);
    expect(result.verb).toBe('policy show');
    expect(typeof result.generatedAt).toBe('string');
    expect(result.claimPolicy).toEqual({
      mode: 'match-legacy-manifest-digest',
      spendCapWei: '1000',
      aiUnitCap: 5,
    });
  });

  it('reports null when no policy is configured (claim-nothing posture)', () => {
    expect(describeClaimPolicyIntent({ claimPolicy: undefined }).claimPolicy).toBeNull();
  });

  it('takes only config in and returns a result out (no CommandContext/argv surface)', () => {
    // Structural conformance: the sole parameter is a config slice.
    expect(describeClaimPolicyIntent.length).toBe(1);
  });
});
