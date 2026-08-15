/**
 * Eligibility checks for portfolio.v0.eval — §7.4.
 *
 * eligibility.min_closed_trades
 * eligibility.min_traded_notional
 *
 * FAIL in any of these → verdict REJECTED per §7.3.
 */

import type { Check } from '../types.js';

// ── min_closed_trades ─────────────────────────────────────────────────────────

/**
 * Check that the number of closed trades meets the minimum threshold.
 *
 * @param count   Rederived closedTradesCount
 * @param minRequired  Minimum from task.eligibility.minClosedTrades (default 20)
 */
export function checkMinClosedTrades(count: number, minRequired: number): Check {
  if (count >= minRequired) {
    return { name: 'eligibility.min_closed_trades', status: 'PASS' };
  }
  return {
    name: 'eligibility.min_closed_trades',
    status: 'FAIL',
    detail: {
      required: minRequired,
      actual: count,
    },
  };
}

// ── min_traded_notional ───────────────────────────────────────────────────────

/**
 * Check that the traded notional multiple meets the minimum threshold.
 *
 * @param multiple     Rederived tradedNotionalMultiple
 * @param minRequired  Minimum from task.eligibility.minTradedNotionalMultiple (default 5.0)
 */
export function checkMinTradedNotional(multiple: number, minRequired: number): Check {
  if (multiple >= minRequired) {
    return { name: 'eligibility.min_traded_notional', status: 'PASS' };
  }
  return {
    name: 'eligibility.min_traded_notional',
    status: 'FAIL',
    detail: {
      required: minRequired,
      actual: multiple,
    },
  };
}
