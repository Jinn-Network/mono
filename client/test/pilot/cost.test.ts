import { describe, it, expect } from 'vitest';
import { solveCostUsd, DEEPSEEK_V4_FLASH_RATES } from '../../src/pilot/cost.js';

describe('token cost pricing', () => {
  it('prices input + output at the fixed rate table', () => {
    // 186114 input * 0.09/M + 6207 output * 0.18/M
    const c = solveCostUsd({ inputTokens: 186114, outputTokens: 6207, cacheReadTokens: 0 }, DEEPSEEK_V4_FLASH_RATES);
    expect(c).toBeCloseTo(186114 * 0.09e-6 + 6207 * 0.18e-6, 6);
  });
  it('discounts cache-read input when a cacheReadPerM rate is given', () => {
    const rates = { ...DEEPSEEK_V4_FLASH_RATES, cacheReadPerM: 0.02 };
    const withCache = solveCostUsd({ inputTokens: 100000, outputTokens: 0, cacheReadTokens: 50000 }, rates);
    const noCacheRate = solveCostUsd({ inputTokens: 100000, outputTokens: 0, cacheReadTokens: 50000 }, DEEPSEEK_V4_FLASH_RATES);
    expect(withCache).toBeLessThan(noCacheRate); // cache-read billed cheaper than fresh input
  });
});
