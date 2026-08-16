import { describe, it, expect } from 'vitest';
import { solveCostUsd, DEEPSEEK_V4_FLASH_RATES, GPT_5_4_MINI_RATES } from '../../src/pilot/cost.js';

describe('token cost pricing', () => {
  it('prices input + output at the fixed rate table', () => {
    // 186114 input * 0.09/M + 6207 output * 0.18/M
    const c = solveCostUsd({ inputTokens: 186114, outputTokens: 6207, cacheReadTokens: 0, reasoningTokens: 0 }, DEEPSEEK_V4_FLASH_RATES);
    expect(c).toBeCloseTo(186114 * 0.09e-6 + 6207 * 0.18e-6, 6);
  });
  it('discounts cache-read input when a cacheReadPerM rate is given', () => {
    const rates = { ...DEEPSEEK_V4_FLASH_RATES, cacheReadPerM: 0.02 };
    const withCache = solveCostUsd({ inputTokens: 100000, outputTokens: 0, cacheReadTokens: 50000, reasoningTokens: 0 }, rates);
    const noCacheRate = solveCostUsd({ inputTokens: 100000, outputTokens: 0, cacheReadTokens: 50000, reasoningTokens: 0 }, DEEPSEEK_V4_FLASH_RATES);
    expect(withCache).toBeLessThan(noCacheRate); // cache-read billed cheaper than fresh input
  });
  it('does NOT double-count reasoning tokens (output_tokens already includes them)', () => {
    // gpt-5.4-mini: 15107 input * 0.75/M + 102 output * 4.50/M. reasoning_tokens=17
    // is a subset of output_tokens and must not be added on top.
    const withReasoning = solveCostUsd({ inputTokens: 15107, outputTokens: 102, cacheReadTokens: 0, reasoningTokens: 17 }, GPT_5_4_MINI_RATES);
    const ignoringReasoningField = solveCostUsd({ inputTokens: 15107, outputTokens: 102, cacheReadTokens: 0, reasoningTokens: 0 }, GPT_5_4_MINI_RATES);
    expect(withReasoning).toBe(ignoringReasoningField);
    expect(withReasoning).toBeCloseTo(15107 * 0.75e-6 + 102 * 4.5e-6, 9);
  });
  it('FAILS LOUD when cache_read > input AND a cacheReadPerM rate is priced (no silent clamp to 0 fresh)', () => {
    const rates = { ...DEEPSEEK_V4_FLASH_RATES, cacheReadPerM: 0.02 };
    expect(() => solveCostUsd({ inputTokens: 100, outputTokens: 0, cacheReadTokens: 500, reasoningTokens: 0 }, rates)).toThrow(/invariant|cache_read/i);
  });
  it('does NOT throw on cache_read > input when no cacheReadPerM rate is set (no-cache path unchanged)', () => {
    // Matches the solve.test.ts fixture (input 186114 < cache_read 258944): must still price cleanly.
    expect(() => solveCostUsd({ inputTokens: 186114, outputTokens: 6207, cacheReadTokens: 258944, reasoningTokens: 0 }, DEEPSEEK_V4_FLASH_RATES)).not.toThrow();
  });
});
