/**
 * Consistency checks for portfolio.v0.eval — §7.4.
 *
 * consistency.pre_snapshot
 * consistency.post_snapshot
 * consistency.fills              (set match by tid; per-fill fields exact)
 * consistency.gating.equity_return
 * consistency.gating.max_drawdown
 * consistency.gating.closed_trades
 * consistency.gating.traded_notional
 *
 * FAIL in any consistency.* check → verdict FAIL per §7.3.
 *
 * Tolerance rules per §7.5:
 *   Snapshot decimal fields: 0.01% relative OR 0.0001 USD absolute (whichever greater)
 *   Per-fill HL fields: exact
 *   Fills set membership (by tid): exact
 *   equityReturnPct, maxDrawdownPct: 0.05% absolute
 *   closedTradesCount: exact
 *   tradedNotionalMultiple: 0.05% relative
 */

import type { HlFill } from '../../../../venues/hyperliquid/types.js';
import type { Check } from '../types.js';

// ── Tolerance helpers ─────────────────────────────────────────────────────────

const SNAPSHOT_REL_TOL = 0.0001; // 0.01%
const SNAPSHOT_ABS_TOL = 0.0001; // 0.0001 USD
const METRIC_ABS_TOL = 0.05;     // 0.05% absolute (for equityReturnPct, maxDrawdownPct)
const NOTIONAL_REL_TOL = 0.0005; // 0.05% relative (for tradedNotionalMultiple)

/**
 * Snapshot field comparison: 0.01% relative OR 0.0001 absolute, whichever is greater.
 */
function snapshotFieldClose(claimed: number, rederived: number): boolean {
  const absDiff = Math.abs(claimed - rederived);
  const relTol = Math.abs(claimed) * SNAPSHOT_REL_TOL;
  const effectiveTol = Math.max(relTol, SNAPSHOT_ABS_TOL);
  return absDiff <= effectiveTol;
}

// ── Snapshot checks ───────────────────────────────────────────────────────────

/**
 * Extract the canonical accountValue from a snapshot payload.
 *
 * Supports two shapes:
 *   1. Legacy: `{ marginSummary: { accountValue } }` (HL's raw clearinghouseState).
 *   2. Unified (current harness): `{ accountValue, clearinghouseState, spotClearinghouseState, ... }`
 *      — top-level `accountValue` is perps margin + spot USDC, matching HL's
 *      `portfolio` endpoint unified equity.
 */
export function extractAccountValue(payload: unknown): number | null {
  if (
    payload !== null &&
    typeof payload === 'object' &&
    'marginSummary' in (payload as Record<string, unknown>)
  ) {
    const ms = (payload as Record<string, unknown>).marginSummary;
    if (ms !== null && typeof ms === 'object' && 'accountValue' in (ms as Record<string, unknown>)) {
      const val = parseFloat(String((ms as Record<string, unknown>).accountValue));
      return isNaN(val) ? null : val;
    }
  }
  // Also try direct accountValue field
  if (payload !== null && typeof payload === 'object' && 'accountValue' in (payload as Record<string, unknown>)) {
    const val = parseFloat(String((payload as Record<string, unknown>).accountValue));
    return isNaN(val) ? null : val;
  }
  return null;
}

/**
 * Check pre-snapshot consistency.
 *
 * Compares accountValue between claimed and rederived pre-snapshot.
 * If either snapshot lacks a parseable accountValue, SKIP (not enough data).
 */
export function checkPreSnapshot(
  claimedPayload: unknown,
  rederived: { capturedAt: number; payload: unknown } | null,
): Check {
  if (rederived === null) {
    return {
      name: 'consistency.pre_snapshot',
      status: 'SKIP',
      detail: 'Pre-snapshot rederivation was skipped (no grid bracket)',
    };
  }

  const claimedValue = extractAccountValue(claimedPayload);
  const rederivValue = extractAccountValue(rederived.payload);

  if (claimedValue === null || rederivValue === null) {
    return {
      name: 'consistency.pre_snapshot',
      status: 'SKIP',
      detail: 'Could not extract accountValue from snapshot payload(s)',
    };
  }

  if (snapshotFieldClose(claimedValue, rederivValue)) {
    return { name: 'consistency.pre_snapshot', status: 'PASS' };
  }

  return {
    name: 'consistency.pre_snapshot',
    status: 'FAIL',
    detail: {
      claimed: claimedValue,
      rederived: rederivValue,
      absDiff: Math.abs(claimedValue - rederivValue),
    },
  };
}

/**
 * Check post-snapshot consistency.
 *
 * Compares accountValue between claimed and rederived post-snapshot.
 * If postSnapshot rederivation was skipped (funding accrual), SKIP.
 */
export function checkPostSnapshot(
  claimedPayload: unknown,
  rederived: { capturedAt: number; payload: unknown } | null,
): Check {
  if (rederived === null) {
    return {
      name: 'consistency.post_snapshot',
      status: 'SKIP',
      detail: 'Post-snapshot rederivation was skipped',
    };
  }

  const claimedValue = extractAccountValue(claimedPayload);
  const rederivValue = extractAccountValue(rederived.payload);

  if (claimedValue === null || rederivValue === null) {
    return {
      name: 'consistency.post_snapshot',
      status: 'SKIP',
      detail: 'Could not extract accountValue from snapshot payload(s)',
    };
  }

  if (snapshotFieldClose(claimedValue, rederivValue)) {
    return { name: 'consistency.post_snapshot', status: 'PASS' };
  }

  return {
    name: 'consistency.post_snapshot',
    status: 'FAIL',
    detail: {
      claimed: claimedValue,
      rederived: rederivValue,
      absDiff: Math.abs(claimedValue - rederivValue),
    },
  };
}

// ── Fills consistency ─────────────────────────────────────────────────────────

/**
 * Check fills consistency: set membership by tid (exact), and per-fill field
 * equality for px, sz, time, fee, closedPnl.
 */
export function checkFills(
  claimedFills: unknown[],
  rederived: HlFill[],
): Check {
  const claimed = claimedFills as HlFill[];

  // Set membership by tid — exact match required
  const claimedTids = new Set(claimed.map((f) => f.tid));
  const rederivTids = new Set(rederived.map((f) => f.tid));

  const missingInRederived = [...claimedTids].filter((t) => !rederivTids.has(t));
  const extraInRederived = [...rederivTids].filter((t) => !claimedTids.has(t));

  if (missingInRederived.length > 0 || extraInRederived.length > 0) {
    return {
      name: 'consistency.fills',
      status: 'FAIL',
      detail: {
        missingInRederived,
        extraInRederived,
      },
    };
  }

  // Per-fill field equality (exact) for matching tids
  const rederivMap = new Map(rederived.map((f) => [f.tid, f]));
  const fieldMismatches: Array<{ tid: number; field: string; claimed: unknown; rederived: unknown }> = [];

  const EXACT_FIELDS: (keyof HlFill)[] = ['px', 'sz', 'time', 'fee', 'closedPnl', 'coin', 'side'];

  for (const fill of claimed) {
    const re = rederivMap.get(fill.tid);
    if (!re) continue; // Already caught above
    for (const field of EXACT_FIELDS) {
      if (String(fill[field]) !== String(re[field])) {
        fieldMismatches.push({
          tid: fill.tid,
          field,
          claimed: fill[field],
          rederived: re[field],
        });
      }
    }
  }

  if (fieldMismatches.length > 0) {
    return {
      name: 'consistency.fills',
      status: 'FAIL',
      detail: { fieldMismatches: fieldMismatches.slice(0, 10) }, // cap output
    };
  }

  return { name: 'consistency.fills', status: 'PASS' };
}

// ── Gating metric checks ──────────────────────────────────────────────────────

/**
 * Check consistency of equityReturnPct (claimed vs rederived).
 * Tolerance: 0.05% absolute.
 */
export function checkGatingEquityReturn(claimed: string, rederived: number): Check {
  const claimedNum = parseFloat(claimed);
  if (isNaN(claimedNum)) {
    return {
      name: 'consistency.gating.equity_return',
      status: 'FAIL',
      detail: `claimed equityReturnPct is not a number: ${claimed}`,
    };
  }
  if (Math.abs(claimedNum - rederived) <= METRIC_ABS_TOL) {
    return { name: 'consistency.gating.equity_return', status: 'PASS' };
  }
  return {
    name: 'consistency.gating.equity_return',
    status: 'FAIL',
    detail: { claimed: claimedNum, rederived, absDiff: Math.abs(claimedNum - rederived) },
  };
}

/**
 * Check consistency of maxDrawdownPct (claimed vs rederived).
 * Tolerance: 0.05% absolute.
 */
export function checkGatingMaxDrawdown(claimed: string, rederived: number): Check {
  const claimedNum = parseFloat(claimed);
  if (isNaN(claimedNum)) {
    return {
      name: 'consistency.gating.max_drawdown',
      status: 'FAIL',
      detail: `claimed maxDrawdownPct is not a number: ${claimed}`,
    };
  }
  if (Math.abs(claimedNum - rederived) <= METRIC_ABS_TOL) {
    return { name: 'consistency.gating.max_drawdown', status: 'PASS' };
  }
  return {
    name: 'consistency.gating.max_drawdown',
    status: 'FAIL',
    detail: { claimed: claimedNum, rederived, absDiff: Math.abs(claimedNum - rederived) },
  };
}

/**
 * Check consistency of closedTradesCount (claimed vs rederived).
 * Tolerance: exact.
 */
export function checkGatingClosedTrades(claimed: number, rederived: number): Check {
  if (claimed === rederived) {
    return { name: 'consistency.gating.closed_trades', status: 'PASS' };
  }
  return {
    name: 'consistency.gating.closed_trades',
    status: 'FAIL',
    detail: { claimed, rederived },
  };
}

/**
 * Check consistency of tradedNotionalMultiple (claimed vs rederived).
 * Tolerance: 0.05% relative.
 */
export function checkGatingTradedNotional(claimed: string, rederived: number): Check {
  const claimedNum = parseFloat(claimed);
  if (isNaN(claimedNum)) {
    return {
      name: 'consistency.gating.traded_notional',
      status: 'FAIL',
      detail: `claimed tradedNotionalMultiple is not a number: ${claimed}`,
    };
  }
  // 0.05% relative tolerance
  const absDiff = Math.abs(claimedNum - rederived);
  const relTol = Math.abs(claimedNum) * NOTIONAL_REL_TOL;
  if (absDiff <= Math.max(relTol, 1e-9)) {
    return { name: 'consistency.gating.traded_notional', status: 'PASS' };
  }
  return {
    name: 'consistency.gating.traded_notional',
    status: 'FAIL',
    detail: {
      claimed: claimedNum,
      rederived,
      absDiff,
      relTol,
    },
  };
}
