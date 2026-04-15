/**
 * Unit Test: Operator Trust Tier Calculation
 * Module: services/x402-gateway/credentials/operators.ts
 *
 * Tests the pure calculateTrustTier function.
 * Trust tier is determined solely by tierOverride; defaults to 'untrusted'.
 */

import { describe, expect, it } from 'vitest';
import { calculateTrustTier } from '../../../../services/x402-gateway/credentials/operators.js';

describe('calculateTrustTier', () => {
  it('returns untrusted when tierOverride is null', () => {
    expect(calculateTrustTier({
      tierOverride: null,
    })).toBe('untrusted');
  });

  it('returns trusted when tierOverride is trusted', () => {
    expect(calculateTrustTier({
      tierOverride: 'trusted',
    })).toBe('trusted');
  });

  it('returns untrusted when tierOverride is untrusted', () => {
    expect(calculateTrustTier({
      tierOverride: 'untrusted',
    })).toBe('untrusted');
  });

  it('empty string tierOverride is treated as null (falls through to default)', () => {
    const result = calculateTrustTier({
      tierOverride: '' as any,
    });
    // Empty string is falsy, so tierOverride is skipped → default 'untrusted'
    expect(result).toBe('untrusted');
  });

  it('invalid tierOverride is rejected and falls through to default', () => {
    const result = calculateTrustTier({
      tierOverride: 'admin' as any,
    });
    // 'admin' is not in TRUST_TIER_ORDER, so it's treated as invalid → default 'untrusted'
    expect(result).toBe('untrusted');
  });

  it('invalid tierOverride like superuser also falls through to default', () => {
    const result = calculateTrustTier({
      tierOverride: 'superuser' as any,
    });
    expect(result).toBe('untrusted');
  });
});
