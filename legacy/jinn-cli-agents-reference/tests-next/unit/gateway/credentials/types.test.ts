/**
 * Unit Test: Credential Management Types
 * Module: services/x402-gateway/credentials/types.ts
 *
 * Tests trust tier comparison with binary model (untrusted/trusted).
 */

import { describe, expect, it } from 'vitest';
import {
  tierMeetsMinimum,
  TRUST_TIER_ORDER,
} from '../../../../services/x402-gateway/credentials/types.js';

describe('tierMeetsMinimum', () => {
  it('should treat same tier as meeting minimum', () => {
    for (const tier of TRUST_TIER_ORDER) {
      expect(tierMeetsMinimum(tier, tier)).toBe(true);
    }
  });

  it('trusted meets untrusted minimum', () => {
    expect(tierMeetsMinimum('trusted', 'untrusted')).toBe(true);
  });

  it('untrusted does not meet trusted minimum', () => {
    expect(tierMeetsMinimum('untrusted', 'trusted')).toBe(false);
  });

  it('should have correct tier ordering', () => {
    expect(TRUST_TIER_ORDER).toEqual(['untrusted', 'trusted']);
  });
});
