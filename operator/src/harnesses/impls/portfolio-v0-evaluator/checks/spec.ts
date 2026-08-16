/**
 * Spec checks for portfolio.v0.eval — §7.4.
 *
 * spec.equity_return_target
 * spec.max_drawdown_constraint
 *
 * FAIL in any spec.* check → verdict FAIL per §7.3.
 */

import type { Check } from '../types.js';

// ── equity_return_target ──────────────────────────────────────────────────────

/**
 * Check that rederived equityReturnPct >= task spec's minReturnPct.
 */
export function checkEquityReturnTarget(
  equityReturnPct: number,
  minReturnPct: number,
): Check {
  if (equityReturnPct >= minReturnPct) {
    return { name: 'spec.equity_return_target', status: 'PASS' };
  }
  return {
    name: 'spec.equity_return_target',
    status: 'FAIL',
    detail: {
      required: minReturnPct,
      actual: equityReturnPct,
    },
  };
}

// ── max_drawdown_constraint ───────────────────────────────────────────────────

/**
 * Check that rederived maxDrawdownPct <= task spec's maxDrawdownPct constraint.
 */
export function checkMaxDrawdownConstraint(
  maxDrawdownPct: number,
  maxAllowed: number,
): Check {
  if (maxDrawdownPct <= maxAllowed) {
    return { name: 'spec.max_drawdown_constraint', status: 'PASS' };
  }
  return {
    name: 'spec.max_drawdown_constraint',
    status: 'FAIL',
    detail: {
      limit: maxAllowed,
      actual: maxDrawdownPct,
    },
  };
}
