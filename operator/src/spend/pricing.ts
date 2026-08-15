import { getTokenCosts } from 'tokenlens';

/**
 * Price a token count in USD for the given model. Returns null when the model
 * is unknown to the catalog (caller falls back to a heuristic).
 *
 * Uses the tokenlens bundled, offline model catalog (models.dev snapshot).
 * The `tokenlens` re-export of `getTokenCosts` accepts an object with
 * `{ modelId, usage }` and injects the default catalog automatically.
 *
 * Note: tokenlens's bundled catalog may lag current model IDs (e.g.
 * `claude-haiku-4-5-20251001` is absent in v1.3.1 and returns null);
 * callers must handle null gracefully.
 */
export function priceTokens(
  modelId: string,
  tokens: { inputTokens: number; outputTokens: number },
): number | null {
  try {
    const costs = getTokenCosts({
      modelId,
      usage: { prompt_tokens: tokens.inputTokens, completion_tokens: tokens.outputTokens },
    });
    return typeof costs?.totalUSD === 'number' ? costs.totalUSD : null;
  } catch {
    return null;
  }
}
