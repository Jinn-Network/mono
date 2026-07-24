import { describe, expect, it } from 'vitest';
import { deriveEligibility } from '../src/eligibility.js';

const AT = '2026-07-14T00:00:00.000Z';
const base = {
  status: 'completed' as const,
  verifiabilityTier: 'user-accepted' as const,
  retentionPolicy: 'contribution-eligible' as const,
};

describe('deriveEligibility (AC2)', () => {
  it('is eligible when completed, contribution-eligible, and an accepted diff is present', () => {
    const v = deriveEligibility({ ...base, acceptedDiff: true }, AT);
    expect(v.eligible).toBe(true);
    expect(v.reason.length).toBeGreaterThan(0);
    expect(v.checkedAt).toBe(AT);
  });

  it('is eligible via a public-repo signal', () => {
    const v = deriveEligibility({ ...base, publicRepo: true }, AT);
    expect(v.eligible).toBe(true);
  });

  it('is ineligible with a specific reason when outcome is not completed', () => {
    const v = deriveEligibility({ ...base, status: 'failed', acceptedDiff: true }, AT);
    expect(v.eligible).toBe(false);
    expect(v.reason).toContain('completed');
  });

  it('is ineligible with a specific reason when retention is local-private', () => {
    const v = deriveEligibility({ ...base, retentionPolicy: 'local-private', acceptedDiff: true }, AT);
    expect(v.eligible).toBe(false);
    expect(v.reason).toContain('retention');
  });

  it('is ineligible with a specific reason when no accepted-diff/public-repo signal is present', () => {
    const v = deriveEligibility(base, AT);
    expect(v.eligible).toBe(false);
    expect(v.reason).toContain('accepted diff');
  });

  it('always returns a non-empty reason string', () => {
    expect(deriveEligibility({ ...base, acceptedDiff: true }, AT).reason).not.toBe('');
  });
});
