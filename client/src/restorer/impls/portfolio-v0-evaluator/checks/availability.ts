/**
 * Availability checks for portfolio.v0.eval — §7.4.
 *
 * availability.hyperliquid_reachable
 * availability.hl_pre_snapshot_rederivable
 * availability.hl_fills_rederivable
 *
 * FAIL in any of these → verdict INDETERMINATE per §7.3.
 */

import type { HlGridPoint } from '../../../../venues/hyperliquid/types.js';
import { bracketGridPoints } from '../../../../venues/hyperliquid/grid.js';
import type { Check } from '../types.js';

// ── hyperliquid_reachable ─────────────────────────────────────────────────────

/**
 * Wraps a HL API call that should succeed if HL is reachable.
 *
 * Returns PASS if the call completes without throwing, FAIL otherwise.
 */
export function checkHlReachable(reachable: boolean, errorMsg?: string): Check {
  if (reachable) {
    return { name: 'availability.hyperliquid_reachable', status: 'PASS' };
  }
  return {
    name: 'availability.hyperliquid_reachable',
    status: 'FAIL',
    detail: errorMsg ?? 'Hyperliquid API is unreachable',
  };
}

// ── hl_pre_snapshot_rederivable ───────────────────────────────────────────────

/**
 * Check whether the pre-snapshot equity can be rederived from the portfolio
 * grid. A bracket must exist around preTs.
 *
 * Returns PASS if a bracket is found, FAIL if the grid has no bracket.
 */
export function checkPreSnapshotRederivable(
  grid: HlGridPoint[],
  preTs: number,
): Check {
  const bracket = bracketGridPoints(grid, preTs);
  if (bracket !== null) {
    return { name: 'availability.hl_pre_snapshot_rederivable', status: 'PASS' };
  }
  return {
    name: 'availability.hl_pre_snapshot_rederivable',
    status: 'FAIL',
    detail: `No grid bracket found for preTs=${preTs}`,
  };
}

// ── hl_fills_rederivable ──────────────────────────────────────────────────────

/**
 * Check whether fills could be fetched without clamping.
 *
 * If startTimeClamped is true, HL silently moved the retention horizon and
 * fills are incomplete — FAIL.
 */
export function checkFillsRederivable(startTimeClamped: boolean): Check {
  if (!startTimeClamped) {
    return { name: 'availability.hl_fills_rederivable', status: 'PASS' };
  }
  return {
    name: 'availability.hl_fills_rederivable',
    status: 'FAIL',
    detail: 'HL userFillsByTime startTime was clamped to retention horizon — fills are incomplete',
  };
}

// ── Post-snapshot funding-accrual edge case ───────────────────────────────────

/**
 * Check whether the post-snapshot is rederivable (no funding accrual issue).
 *
 * Per §7.5: if postSnapshot.capturedAt > endTs + 60s, emit SKIP and
 * downstream consistency checks should be skipped → INDETERMINATE.
 *
 * This check is named availability.hl_post_snapshot_rederivable and uses
 * SKIP status to propagate INDETERMINATE via the derivation rule (SKIP ≠ FAIL
 * for availability — a FAIL would cause INDETERMINATE, but SKIP means we
 * surface it separately).
 *
 * However, per §7.3 the derivation rule is:
 *   if any "availability.*" FAIL → INDETERMINATE
 *
 * A SKIP doesn't trigger INDETERMINATE via the rule, so the eval impl must
 * handle this edge case explicitly by checking for SKIP in downstream checks.
 */
export function checkPostSnapshotFundingAccrual(
  postCapturedAt: number,
  endTs: number,
): Check {
  const threshold = endTs + 60_000; // 60 seconds
  if (postCapturedAt > threshold) {
    return {
      name: 'availability.hl_post_snapshot_rederivable',
      status: 'SKIP',
      detail: `postSnapshot.capturedAt (${postCapturedAt}) > endTs+60s (${threshold}) — funding may have accrued`,
    };
  }
  return { name: 'availability.hl_post_snapshot_rederivable', status: 'PASS' };
}
