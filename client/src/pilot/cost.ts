import type { SolveTokens } from './solve.js';

export interface RateTable { inputPerM: number; outputPerM: number; cacheReadPerM?: number; }
export const DEEPSEEK_V4_FLASH_RATES: RateTable = { inputPerM: 0.09, outputPerM: 0.18 };
/** gpt-5.4-mini published API rate (used to price Codex-subscription token
 *  counts at a representative metered cost — the sub bills flat, but the gate
 *  measures what a metered user would pay). $0.75/M in, $4.50/M out. */
export const GPT_5_4_MINI_RATES: RateTable = { inputPerM: 0.75, outputPerM: 4.5 };

/** USD for one solve from provider-actual token counts. `output_tokens` already
 *  INCLUDES `reasoning_tokens` (OpenAI `completion_tokens` semantics, verified
 *  empirically on the Codex backend), so reasoning is NOT added again — it is
 *  surfaced separately only for reporting. Likewise `input_tokens` is inclusive
 *  of `cache_read_tokens`: when a cacheReadPerM rate is supplied, cache-read
 *  tokens are re-priced at that (discounted) rate and the remaining (fresh)
 *  input at inputPerM; otherwise all input is inputPerM. */
export function solveCostUsd(tokens: SolveTokens, rates: RateTable): number {
  const per = (n: number, rate: number): number => n * rate * 1e-6;
  const outputCost = per(tokens.outputTokens, rates.outputPerM);
  if (typeof rates.cacheReadPerM === 'number') {
    // The fresh/cache split only matters when a discounted cacheReadPerM rate is
    // priced. Here the `input ⊇ cache_read` invariant must hold — silently
    // clamping fresh to 0 would hide a bad token export and mis-price the solve,
    // so fail loud instead. (The no-cache-rate path below is untouched: it prices
    // all input at inputPerM and never reads cacheReadTokens.)
    if (tokens.cacheReadTokens > tokens.inputTokens) {
      throw new Error(
        `solveCostUsd: cache_read_tokens (${tokens.cacheReadTokens}) > input_tokens (${tokens.inputTokens}) ` +
        `violates the input ⊇ cache_read invariant when a cacheReadPerM rate is priced`,
      );
    }
    const fresh = tokens.inputTokens - tokens.cacheReadTokens;
    return per(fresh, rates.inputPerM) + per(tokens.cacheReadTokens, rates.cacheReadPerM) + outputCost;
  }
  return per(tokens.inputTokens, rates.inputPerM) + outputCost;
}
