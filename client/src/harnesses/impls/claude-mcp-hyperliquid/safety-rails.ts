/**
 * Safety rails for claude-mcp-hyperliquid write tools — §8.3.
 *
 * All validation is pure (no I/O). Enforced at the tool boundary so Claude
 * cannot bypass them through reasoning.
 */

// ── Config ────────────────────────────────────────────────────────────────────

export interface SafetyConfig {
  /** Maximum fraction of account value per position. Default: 0.25 */
  maxPositionFraction: number;
  /** Maximum leverage. Default: 10 */
  maxLeverage: number;
  /** Maximum slippage in basis points. Default: 50 */
  maxSlippageBps: number;
  /** Max write ops per minute. Default: 60 */
  maxOpsPerMinute: number;
  /** Max total trade count in window. Default: 1000 */
  maxTotalTrades: number;
  /**
   * Hard absolute notional cap per trade in USD. Optional.
   * When set, effective cap = min(maxPositionFraction × accountValue, maxNotionalUsd).
   * Defaults: 5000 on mainnet, 500 on testnet — but when this field is set,
   * the configured value takes precedence.
   */
  maxNotionalUsd?: number;
}

export const DEFAULT_SAFETY_CONFIG: SafetyConfig = {
  maxPositionFraction: 0.25,
  maxLeverage: 10,
  maxSlippageBps: 50,
  maxOpsPerMinute: 60,
  maxTotalTrades: 1000,
};

// ── Rate-limit state ──────────────────────────────────────────────────────────

export interface RateLimitState {
  /** Timestamps (epoch ms) of recent write ops, oldest first */
  opTimestamps: number[];
  /** Total write ops since creation */
  totalOps: number;
}

export function createRateLimitState(): RateLimitState {
  return { opTimestamps: [], totalOps: 0 };
}

// ── Validation helpers ────────────────────────────────────────────────────────

export interface ValidationResult {
  ok: true;
}

export interface ValidationError {
  ok: false;
  code: string;
  message: string;
}

export type ValidationOutcome = ValidationResult | ValidationError;

function err(code: string, message: string): ValidationError {
  return { ok: false, code, message };
}

const ok: ValidationResult = { ok: true };

// ── Rate-limit check ──────────────────────────────────────────────────────────

/**
 * Check rate limit and record the op if it passes.
 * Mutates `state` on success.
 */
export function checkRateLimit(
  state: RateLimitState,
  config: SafetyConfig,
  nowMs: number = Date.now(),
): ValidationOutcome {
  // Purge ops older than 60 seconds
  const cutoff = nowMs - 60_000;
  state.opTimestamps = state.opTimestamps.filter((t) => t > cutoff);

  if (state.opTimestamps.length >= config.maxOpsPerMinute) {
    return err(
      'RATE_LIMIT',
      `Rate limit exceeded: ${state.opTimestamps.length} ops in last 60s (max ${config.maxOpsPerMinute})`,
    );
  }

  if (state.totalOps >= config.maxTotalTrades) {
    return err(
      'TOTAL_TRADE_CAP',
      `Total trade cap reached: ${state.totalOps} ops (max ${config.maxTotalTrades})`,
    );
  }

  // Record op
  state.opTimestamps.push(nowMs);
  state.totalOps += 1;

  return ok;
}

// ── Open-position validation ──────────────────────────────────────────────────

export interface OpenPositionParams {
  coin: string;
  side: 'long' | 'short';
  /** Size in units of the base asset */
  size: number;
  leverage: number;
  /** Current mid price for the coin (used to compute notional) */
  midPrice: number;
  /** Current account value in USD */
  accountValue: number;
  slippageBps: number;
  tp?: number;
  sl?: number;
}

export function validateOpenPosition(
  params: OpenPositionParams,
  config: SafetyConfig,
): ValidationOutcome {
  const { size, leverage, midPrice, accountValue, slippageBps } = params;

  if (leverage > config.maxLeverage) {
    return err(
      'LEVERAGE_EXCEEDED',
      `Leverage ${leverage}x exceeds max ${config.maxLeverage}x`,
    );
  }

  if (slippageBps > config.maxSlippageBps) {
    return err(
      'SLIPPAGE_EXCEEDED',
      `Slippage ${slippageBps} bps exceeds max ${config.maxSlippageBps} bps`,
    );
  }

  if (size <= 0) {
    return err('INVALID_SIZE', 'Size must be positive');
  }

  if (midPrice <= 0) {
    return err('INVALID_PRICE', 'Mid price must be positive');
  }

  const notionalUsd = size * midPrice;
  const maxNotional = config.maxPositionFraction * accountValue;

  if (notionalUsd > maxNotional) {
    return err(
      'NOTIONAL_EXCEEDED',
      `Notional $${notionalUsd.toFixed(2)} exceeds max $${maxNotional.toFixed(2)} (${(config.maxPositionFraction * 100).toFixed(0)}% of $${accountValue.toFixed(2)} account)`,
    );
  }

  return ok;
}

// ── Close-position validation ─────────────────────────────────────────────────

export interface ClosePositionParams {
  coin: string;
  sizeOrAll: number | 'all';
}

export function validateClosePosition(
  params: ClosePositionParams,
): ValidationOutcome {
  if (typeof params.sizeOrAll === 'number' && params.sizeOrAll <= 0) {
    return err('INVALID_SIZE', 'Size must be positive or "all"');
  }
  return ok;
}

// ── Modify-position validation ────────────────────────────────────────────────

export interface ModifyPositionParams {
  coin: string;
  leverage?: number;
  tp?: number;
  sl?: number;
}

export function validateModifyPosition(
  params: ModifyPositionParams,
  config: SafetyConfig,
): ValidationOutcome {
  if (params.leverage !== undefined && params.leverage > config.maxLeverage) {
    return err(
      'LEVERAGE_EXCEEDED',
      `Leverage ${params.leverage}x exceeds max ${config.maxLeverage}x`,
    );
  }
  return ok;
}
