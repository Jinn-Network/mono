import type { SolveTokens } from './solve.js';

export interface RateTable { inputPerM: number; outputPerM: number; cacheReadPerM?: number; }
export const DEEPSEEK_V4_FLASH_RATES: RateTable = { inputPerM: 0.09, outputPerM: 0.18 };

/** USD for one solve from provider-actual token counts. When a cacheReadPerM
 *  rate is supplied, cache-read tokens are priced at that (discounted) rate and
 *  the remaining (fresh) input at inputPerM; otherwise all input is inputPerM. */
export function solveCostUsd(tokens: SolveTokens, rates: RateTable): number {
  const per = (n: number, rate: number): number => n * rate * 1e-6;
  if (typeof rates.cacheReadPerM === 'number') {
    const fresh = Math.max(0, tokens.inputTokens - tokens.cacheReadTokens);
    return per(fresh, rates.inputPerM) + per(tokens.cacheReadTokens, rates.cacheReadPerM) + per(tokens.outputTokens, rates.outputPerM);
  }
  return per(tokens.inputTokens, rates.inputPerM) + per(tokens.outputTokens, rates.outputPerM);
}
