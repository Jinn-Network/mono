import { describe, expect, it } from 'vitest';
import { priceTokens } from '../../src/spend/pricing.js';

describe('priceTokens', () => {
  it('returns a positive USD cost for a known model', () => {
    const usd = priceTokens('gpt-4o', { inputTokens: 1000, outputTokens: 1000 });
    expect(usd).not.toBeNull();
    expect(usd as number).toBeGreaterThan(0);
  });

  it('returns null for an unknown model', () => {
    expect(priceTokens('no-such-model-xyz-123', { inputTokens: 1000, outputTokens: 1000 })).toBeNull();
  });

  it('returns 0 for zero tokens on a known model', () => {
    expect(priceTokens('gpt-4o', { inputTokens: 0, outputTokens: 0 })).toBe(0);
  });
});
