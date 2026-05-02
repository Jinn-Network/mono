/**
 * Tests for safety-rails.ts — pure validation logic.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import {
  checkRateLimit,
  validateOpenPosition,
  validateClosePosition,
  validateModifyPosition,
  createRateLimitState,
  DEFAULT_SAFETY_CONFIG,
} from '../../../../src/harnesses/impls/claude-mcp-hyperliquid/safety-rails.js';
import type { RateLimitState } from '../../../../src/harnesses/impls/claude-mcp-hyperliquid/safety-rails.js';

describe('checkRateLimit', () => {
  let state: RateLimitState;

  beforeEach(() => {
    state = createRateLimitState();
  });

  it('allows first op', () => {
    const result = checkRateLimit(state, DEFAULT_SAFETY_CONFIG);
    expect(result.ok).toBe(true);
    expect(state.totalOps).toBe(1);
    expect(state.opTimestamps).toHaveLength(1);
  });

  it('rejects when per-minute limit exceeded', () => {
    const now = Date.now();
    // Fill up to max
    for (let i = 0; i < DEFAULT_SAFETY_CONFIG.maxOpsPerMinute; i++) {
      checkRateLimit(state, DEFAULT_SAFETY_CONFIG, now + i);
    }
    const result = checkRateLimit(state, DEFAULT_SAFETY_CONFIG, now + DEFAULT_SAFETY_CONFIG.maxOpsPerMinute);
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.code).toBe('RATE_LIMIT');
  });

  it('allows ops after 60s window rolls over', () => {
    const now = Date.now();
    // Fill up
    for (let i = 0; i < DEFAULT_SAFETY_CONFIG.maxOpsPerMinute; i++) {
      checkRateLimit(state, DEFAULT_SAFETY_CONFIG, now + i);
    }
    // 61s later — old ops expired
    const result = checkRateLimit(state, DEFAULT_SAFETY_CONFIG, now + 61_000);
    expect(result.ok).toBe(true);
  });

  it('rejects when total trade cap reached', () => {
    const customConfig = { ...DEFAULT_SAFETY_CONFIG, maxTotalTrades: 2 };
    checkRateLimit(state, customConfig, Date.now());
    checkRateLimit(state, customConfig, Date.now() + 1);
    const result = checkRateLimit(state, customConfig, Date.now() + 2);
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.code).toBe('TOTAL_TRADE_CAP');
  });
});

describe('validateOpenPosition', () => {
  const baseParams = {
    coin: 'BTC',
    side: 'long' as const,
    size: 0.01,
    leverage: 5,
    midPrice: 50_000,
    accountValue: 10_000,
    slippageBps: 20,
  };

  it('accepts a valid position', () => {
    // notional = 0.01 * 50000 = 500; maxNotional = 0.25 * 10000 = 2500
    const result = validateOpenPosition(baseParams, DEFAULT_SAFETY_CONFIG);
    expect(result.ok).toBe(true);
  });

  it('rejects when leverage exceeds max', () => {
    const result = validateOpenPosition({ ...baseParams, leverage: 11 }, DEFAULT_SAFETY_CONFIG);
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.code).toBe('LEVERAGE_EXCEEDED');
  });

  it('rejects when slippage exceeds max', () => {
    const result = validateOpenPosition({ ...baseParams, slippageBps: 51 }, DEFAULT_SAFETY_CONFIG);
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.code).toBe('SLIPPAGE_EXCEEDED');
  });

  it('rejects when notional exceeds 25% of account', () => {
    // size=0.1, midPrice=50000 → notional=5000; max=2500
    const result = validateOpenPosition({ ...baseParams, size: 0.1 }, DEFAULT_SAFETY_CONFIG);
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.code).toBe('NOTIONAL_EXCEEDED');
  });

  it('rejects zero size', () => {
    const result = validateOpenPosition({ ...baseParams, size: 0 }, DEFAULT_SAFETY_CONFIG);
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.code).toBe('INVALID_SIZE');
  });

  it('rejects zero mid price', () => {
    const result = validateOpenPosition({ ...baseParams, midPrice: 0 }, DEFAULT_SAFETY_CONFIG);
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.code).toBe('INVALID_PRICE');
  });

  it('respects custom maxPositionFraction', () => {
    const customConfig = { ...DEFAULT_SAFETY_CONFIG, maxPositionFraction: 0.10 };
    // notional=500, max=0.10*10000=1000 → ok
    expect(validateOpenPosition(baseParams, customConfig).ok).toBe(true);

    // notional=1500 > 1000 → reject
    const result = validateOpenPosition({ ...baseParams, size: 0.03 }, customConfig);
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.code).toBe('NOTIONAL_EXCEEDED');
  });
});

describe('validateClosePosition', () => {
  it('accepts "all" as sizeOrAll', () => {
    expect(validateClosePosition({ coin: 'BTC', sizeOrAll: 'all' }).ok).toBe(true);
  });

  it('accepts positive number', () => {
    expect(validateClosePosition({ coin: 'BTC', sizeOrAll: 0.01 }).ok).toBe(true);
  });

  it('rejects zero or negative size', () => {
    const r = validateClosePosition({ coin: 'BTC', sizeOrAll: 0 });
    expect(r.ok).toBe(false);
    expect(r.ok === false && r.code).toBe('INVALID_SIZE');
  });
});

describe('validateModifyPosition', () => {
  it('accepts leverage within max', () => {
    expect(validateModifyPosition({ coin: 'BTC', leverage: 5 }, DEFAULT_SAFETY_CONFIG).ok).toBe(true);
  });

  it('rejects leverage above max', () => {
    const r = validateModifyPosition({ coin: 'BTC', leverage: 15 }, DEFAULT_SAFETY_CONFIG);
    expect(r.ok).toBe(false);
    expect(r.ok === false && r.code).toBe('LEVERAGE_EXCEEDED');
  });

  it('accepts no-op (no params)', () => {
    expect(validateModifyPosition({ coin: 'BTC' }, DEFAULT_SAFETY_CONFIG).ok).toBe(true);
  });
});
