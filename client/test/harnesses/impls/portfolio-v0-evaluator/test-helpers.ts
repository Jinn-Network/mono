/**
 * Shared test helpers for portfolio-v0-evaluator tests.
 *
 * Centralises `makeFill` and `makePayload` to avoid duplication across test files.
 */

import type { HlFill } from '../../../../src/venues/hyperliquid/types.js';

/**
 * Build a synthetic HlFill with sensible defaults.
 * Pass `overrides` to customise specific fields.
 */
export function makeFill(overrides: Partial<HlFill> = {}): HlFill {
  return {
    coin: 'BTC',
    px: '50000',
    sz: '0.01',
    side: 'B',
    time: 1000,
    startPosition: '0',
    dir: 'Open Long',
    closedPnl: '0.0',
    hash: '0xabc',
    oid: 1,
    crossed: false,
    fee: '0.5',
    tid: 1,
    feeToken: 'USDC',
    twapId: null,
    ...overrides,
  };
}

/**
 * Build a synthetic snapshot payload with the given accountValue string.
 */
export function makePayload(accountValue: string): { marginSummary: { accountValue: string } } {
  return { marginSummary: { accountValue } };
}

/**
 * Build a unified-shape snapshot payload (the shape the harness writes today).
 * Unified accountValue = perps + spot USDC.
 */
export function makeUnifiedPayload(
  accountValue: string,
  opts: { perps?: string; spotUsdc?: string } = {},
): Record<string, unknown> {
  const perps = opts.perps ?? accountValue;
  const spotUsdc = opts.spotUsdc ?? '0';
  return {
    accountValue,
    perpsAccountValue: perps,
    spotUsdc,
    clearinghouseState: {
      marginSummary: { accountValue: perps, totalNtlPos: '0', totalRawUsd: '0', totalMarginUsed: '0' },
      crossMarginSummary: { accountValue: perps, totalNtlPos: '0', totalRawUsd: '0', totalMarginUsed: '0' },
      crossMaintenanceMarginUsed: '0',
      withdrawable: perps,
      assetPositions: [],
      time: 0,
    },
    spotClearinghouseState: {
      balances: spotUsdc === '0'
        ? []
        : [{ coin: 'USDC', token: 0, total: spotUsdc, hold: '0.0', entryNtl: '0.0' }],
    },
  };
}
