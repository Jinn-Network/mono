/**
 * Per-task cost estimates for paid-API-key harnesses.
 *
 * Background — Issue #331 (Run-mode `feat`, P0 tier under release-feedback
 * umbrella #328). The operator dashboard surfaces a harness/model selection
 * at SolverNet-join time and again in Settings. Operators routing a paid
 * API key (Anthropic, OpenAI, OpenRouter, Nous Portal) through the Hermes
 * harness — or a "raw API key" Claude Code variant if we ever add one —
 * have **no UI nudge** at join-time about per-task cost. The v0.1.6 dogfood
 * surfaced the concrete worry: a first-run operator could pick Opus 4.7 +
 * SWE-rebench v2 and burn $100s/hr before they figure out what Jinn does.
 *
 * This module captures the heuristic the SPA uses to render that estimate
 * and to gate the Save & Join action when the estimate exceeds a
 * configurable per-task threshold (default $1).
 *
 * Heuristic shape per the spec:
 *   per-1k-token rate × typical task length, by model id.
 *
 * Subscription billing paths (`usesPaidApiKey: false` from daemon
 * `/v1/status` `costSurface`) show "Included in subscription, no per-task
 * API cost" and **do not** trigger the confirmation gate.
 *
 * To add a new model: append an entry to `MODEL_COST_TABLE`. The id is the
 * exact `model` string persisted to `joinedSolverNets[<cid>].model`. Paid
 * vs subscription is resolved on the daemon via `resolveCredentialId` and
 * exposed on `GET /v1/status` as `costSurface.harnesses[<canonical>]`.
 * Keep the units
 * consistent: token counts in tokens, rates in USD-per-1k-tokens.
 *
 * Units note: Anthropic + OpenAI publish prices per million tokens; we
 * convert to per-1k-tokens here so the multiplication reads as
 * `(tokens / 1000) * pricePer1k`. Avoids floating-point surprises when the
 * dashboard renders cents.
 *
 * Pricing references captured at the time of this commit (see PR body):
 *   - Anthropic Claude Opus 4.7: $15/M input, $75/M output (≈ $0.015 / 1k
 *     input, $0.075 / 1k output). Typical SWE-rebench v2 task estimated at
 *     ~50k input + 20k output → ~$2.25/task. Anthropic public pricing.
 *   - Anthropic Claude Sonnet 4.6: $3/M input, $15/M output.
 *   - OpenAI GPT-5.4: $1.25/M input, $10/M output (OpenAI public pricing).
 *   - OpenAI GPT-5.4 Mini: $0.25/M input, $2/M output.
 *
 * These are heuristics. Provider-API reconciliation (actual usage) is
 * deferred to the P1 follow-up tracked in #331.
 */

export type Provider = 'anthropic' | 'openai' | 'openrouter' | 'nous' | 'other';

export interface ModelCostEntry {
  /** Upstream API provider that owns the billing relationship. */
  provider: Provider;
  /** USD per 1k input tokens. */
  inputPer1kTokens: number;
  /** USD per 1k output tokens. */
  outputPer1kTokens: number;
  /** Typical input-token consumption for a single task. Heuristic. */
  typicalInputTokens: number;
  /** Typical output-token consumption for a single task. Heuristic. */
  typicalOutputTokens: number;
  /**
   * `true` when this model id is only ever reached via a subscription path
   * (e.g. a future "Claude Code subscription" pinned model). The default
   * gate logic prefers the harness-level flag — this exists so an
   * individual model entry can override it on a per-id basis.
   */
  subscriptionPath?: boolean;
}

/**
 * Per-model cost entries. Keyed by the exact `model` id persisted to
 * `joinedSolverNets[<cid>].model`. The dashboard model dropdown in
 * `claudeModels.ts` is the source of truth for which ids appear here.
 */
export const MODEL_COST_TABLE: Readonly<Record<string, ModelCostEntry>> = {
  // ---------- Anthropic family (direct + via OpenRouter) ----------
  'claude-opus-4-7': {
    provider: 'anthropic',
    inputPer1kTokens: 0.015,
    outputPer1kTokens: 0.075,
    typicalInputTokens: 50_000,
    typicalOutputTokens: 20_000,
  },
  'claude-sonnet-4-6': {
    provider: 'anthropic',
    inputPer1kTokens: 0.003,
    outputPer1kTokens: 0.015,
    typicalInputTokens: 50_000,
    typicalOutputTokens: 20_000,
  },
  'claude-haiku-4-5-20251001': {
    provider: 'anthropic',
    inputPer1kTokens: 0.001,
    outputPer1kTokens: 0.005,
    typicalInputTokens: 50_000,
    typicalOutputTokens: 20_000,
  },
  // OpenRouter routing of the same families (Hermes harness uses these).
  'anthropic/claude-opus-4.7': {
    provider: 'openrouter',
    inputPer1kTokens: 0.015,
    outputPer1kTokens: 0.075,
    typicalInputTokens: 50_000,
    typicalOutputTokens: 20_000,
  },
  'anthropic/claude-sonnet-4.6': {
    provider: 'openrouter',
    inputPer1kTokens: 0.003,
    outputPer1kTokens: 0.015,
    typicalInputTokens: 50_000,
    typicalOutputTokens: 20_000,
  },

  // ---------- OpenAI family ----------
  'gpt-5.4': {
    provider: 'openai',
    inputPer1kTokens: 0.00125,
    outputPer1kTokens: 0.01,
    typicalInputTokens: 50_000,
    typicalOutputTokens: 20_000,
  },
  'gpt-5.4-mini': {
    provider: 'openai',
    inputPer1kTokens: 0.00025,
    outputPer1kTokens: 0.002,
    typicalInputTokens: 50_000,
    typicalOutputTokens: 20_000,
  },
  'gpt-5.5': {
    provider: 'openai',
    // Newer flagship; public pricing not confirmed at heuristic-capture
    // time, so use Opus-4.7-class rates as a conservative upper bound
    // until we get a verified figure.
    inputPer1kTokens: 0.015,
    outputPer1kTokens: 0.06,
    typicalInputTokens: 50_000,
    typicalOutputTokens: 20_000,
  },
  'gpt-5.3-codex': {
    provider: 'openai',
    inputPer1kTokens: 0.00125,
    outputPer1kTokens: 0.01,
    typicalInputTokens: 50_000,
    typicalOutputTokens: 20_000,
  },
  'gpt-5.3-codex-spark': {
    provider: 'openai',
    inputPer1kTokens: 0.00125,
    outputPer1kTokens: 0.01,
    typicalInputTokens: 50_000,
    typicalOutputTokens: 20_000,
  },

  // ---------- OpenRouter long-tail (Hermes) ----------
  // These rates are coarse — OpenRouter's effective price depends on the
  // route picked. We pick the published list-price upper bound so the
  // estimate biases toward over-warning rather than under-warning.
  'tencent/hy3-preview': {
    provider: 'openrouter',
    inputPer1kTokens: 0.003,
    outputPer1kTokens: 0.015,
    typicalInputTokens: 50_000,
    typicalOutputTokens: 20_000,
  },
  'deepseek/deepseek-v4-pro': {
    provider: 'openrouter',
    inputPer1kTokens: 0.0014,
    outputPer1kTokens: 0.0028,
    typicalInputTokens: 50_000,
    typicalOutputTokens: 20_000,
  },
  'deepseek/deepseek-v4-flash': {
    provider: 'openrouter',
    inputPer1kTokens: 0.0001,
    outputPer1kTokens: 0.0004,
    typicalInputTokens: 50_000,
    typicalOutputTokens: 20_000,
  },
  'google/gemini-3.1-flash-lite': {
    provider: 'openrouter',
    inputPer1kTokens: 0.0001,
    outputPer1kTokens: 0.0004,
    typicalInputTokens: 50_000,
    typicalOutputTokens: 20_000,
  },
  'moonshotai/kimi-k2.6': {
    provider: 'openrouter',
    inputPer1kTokens: 0.0006,
    outputPer1kTokens: 0.0025,
    typicalInputTokens: 50_000,
    typicalOutputTokens: 20_000,
  },
  'openrouter/owl-alpha': {
    provider: 'openrouter',
    inputPer1kTokens: 0.002,
    outputPer1kTokens: 0.008,
    typicalInputTokens: 50_000,
    typicalOutputTokens: 20_000,
  },
  'minimax/minimax-m2.7': {
    provider: 'openrouter',
    inputPer1kTokens: 0.0008,
    outputPer1kTokens: 0.0032,
    typicalInputTokens: 50_000,
    typicalOutputTokens: 20_000,
  },
  'nousresearch/hermes-4-405b': {
    provider: 'nous',
    inputPer1kTokens: 0.0009,
    outputPer1kTokens: 0.0009,
    typicalInputTokens: 50_000,
    typicalOutputTokens: 20_000,
  },
};

/** Default per-task USD threshold above which the confirmation gate fires. */
export const DEFAULT_HIGH_COST_THRESHOLD_USD = 1;

export interface CostEstimate {
  /** Estimated per-task cost in USD. */
  usd: number;
  /** Computed input cost in USD. */
  inputUsd: number;
  /** Computed output cost in USD. */
  outputUsd: number;
  /** Heuristic typical input tokens used. */
  typicalInputTokens: number;
  /** Heuristic typical output tokens used. */
  typicalOutputTokens: number;
  /** Underlying entry consulted. */
  entry: ModelCostEntry;
}

/**
 * Compute the per-task cost estimate for a given model id. Returns `null`
 * when the id has no entry in `MODEL_COST_TABLE` — callers should treat
 * that as "unknown, don't surface a number" rather than rendering $0.
 */
export function estimateModelCost(modelId: string): CostEstimate | null {
  const entry = MODEL_COST_TABLE[modelId];
  if (!entry) return null;
  const inputUsd = (entry.typicalInputTokens / 1000) * entry.inputPer1kTokens;
  const outputUsd = (entry.typicalOutputTokens / 1000) * entry.outputPer1kTokens;
  return {
    usd: inputUsd + outputUsd,
    inputUsd,
    outputUsd,
    typicalInputTokens: entry.typicalInputTokens,
    typicalOutputTokens: entry.typicalOutputTokens,
    entry,
  };
}

export interface CostSurfaceDecision {
  /** Whether to show a numeric cost-per-task estimate at all. */
  showEstimate: boolean;
  /** Resolved estimate (may be `null` even when `showEstimate` is true if the model id is unknown). */
  estimate: CostEstimate | null;
  /** Whether the Save & Join action requires the high-cost confirmation. */
  requiresConfirmation: boolean;
  /**
   * Human-readable reason the surface is suppressed when `showEstimate`
   * is false — e.g. "Included in subscription, no per-task API cost".
   * `null` when the surface is shown.
   */
  suppressedReason: string | null;
}

/**
 * Decide what the cost surface should render for a given harness + model
 * combination, plus whether the confirmation gate fires.
 *
 * Defaults:
 *   - threshold: $1 / task (see DEFAULT_HIGH_COST_THRESHOLD_USD).
 *   - `usesPaidApiKey: false` → suppress surface + skip gate.
 *   - unknown model on a paid path → show estimate slot (caller may
 *     render "estimate unavailable") but DO NOT trigger the gate.
 */
export function decideCostSurface(
  usesPaidApiKey: boolean,
  modelId: string | undefined,
  thresholdUsd: number = DEFAULT_HIGH_COST_THRESHOLD_USD,
): CostSurfaceDecision {
  if (!usesPaidApiKey) {
    return {
      showEstimate: false,
      estimate: null,
      requiresConfirmation: false,
      suppressedReason: 'Included in subscription, no per-task API cost.',
    };
  }
  const estimate = modelId ? estimateModelCost(modelId) : null;
  const modelOverridesSubscription =
    estimate?.entry.subscriptionPath === true;
  if (modelOverridesSubscription) {
    return {
      showEstimate: false,
      estimate: null,
      requiresConfirmation: false,
      suppressedReason: 'Included in subscription, no per-task API cost.',
    };
  }
  return {
    showEstimate: true,
    estimate,
    requiresConfirmation: estimate !== null && estimate.usd > thresholdUsd,
    suppressedReason: null,
  };
}

/**
 * Format a USD amount for compact display in the dashboard. Picks the
 * smallest fraction count that still distinguishes the value from $0.
 */
export function formatUsd(amount: number): string {
  if (!Number.isFinite(amount)) return '—';
  if (amount === 0) return '$0';
  if (amount < 0.01) return `<$0.01`;
  if (amount < 1) return `$${amount.toFixed(2)}`;
  if (amount < 10) return `$${amount.toFixed(2)}`;
  return `$${amount.toFixed(2)}`;
}
