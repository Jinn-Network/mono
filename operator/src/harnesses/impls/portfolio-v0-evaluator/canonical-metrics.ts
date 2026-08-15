/**
 * Canonical metric computation for portfolio.v0 — §7.6.
 *
 * Single source of truth shared by both the harness and evaluator.
 * Pure functions; no I/O.
 */

import type { HlFill } from '../../../venues/hyperliquid/types.js';

// ── Equity curve ──────────────────────────────────────────────────────────────

/** A single point on the equity curve: [timestamp_ms, accountValue_as_number]. */
export interface EquityPoint {
  ts: number;
  value: number;
}

/**
 * Build an equity curve from the pre/post snapshot values and fills.
 *
 * Per §7.6: the curve is sampled at:
 *   - preSnapshot.capturedAt (value = preSnapshot accountValue)
 *   - every fill.time (value = inline equity; see note below)
 *   - postSnapshot.capturedAt (value = postSnapshot accountValue)
 *
 * Note: HL does not return per-fill equity. The evaluator uses the
 * pre/post accountValues and the fill timestamps as curve shape anchors.
 * For drawdown calculation purposes the curve is:
 *   pre-equity → (fills sorted by time but using pre/post values interpolated
 *   between them) → post-equity.
 *
 * Actually §7.6 says "sampled at preSnapshot.capturedAt + every fill.time +
 * postSnapshot.capturedAt". Since HL only provides point-in-time equity at
 * pre/post (not at each fill), the canonical approach is to use linear
 * interpolation between the pre and post equity values at each fill timestamp.
 * This matches what the harness can compute and is deterministic.
 */
export function equityCurve(
  preTs: number,
  preValue: number,
  postTs: number,
  postValue: number,
  fillTimes: number[],
): EquityPoint[] {
  const points: EquityPoint[] = [];

  // Pre snapshot
  points.push({ ts: preTs, value: preValue });

  // Fill time points — linear interpolation between pre and post
  const duration = postTs - preTs;
  const sorted = [...fillTimes].sort((a, b) => a - b);
  for (const ts of sorted) {
    const clampedTs = Math.max(preTs, Math.min(postTs, ts));
    const frac = duration > 0 ? (clampedTs - preTs) / duration : 0;
    const value = preValue + frac * (postValue - preValue);
    points.push({ ts: clampedTs, value });
  }

  // Post snapshot
  points.push({ ts: postTs, value: postValue });

  return points;
}

// ── maxDrawdownPct ────────────────────────────────────────────────────────────

/**
 * Compute max drawdown percentage over an equity curve.
 *
 * Per §7.6:
 *   Drawdown at P = 100 * (peak_so_far - equity_P) / peak_so_far
 *   maxDrawdownPct = max over all P
 *
 * Returns 0 if the curve has fewer than 2 points or no drawdown.
 */
export function maxDrawdownPct(curve: EquityPoint[]): number {
  if (curve.length < 2) return 0;

  let peakSoFar = curve[0]!.value;
  let maxDd = 0;

  for (const point of curve) {
    if (point.value > peakSoFar) {
      peakSoFar = point.value;
    }
    if (peakSoFar > 0) {
      const dd = (100 * (peakSoFar - point.value)) / peakSoFar;
      if (dd > maxDd) maxDd = dd;
    }
  }

  return maxDd;
}

// ── equityReturnPct ───────────────────────────────────────────────────────────

/**
 * Compute equity return percentage.
 *
 * Per §7.6: 100 * (postValue - preValue) / preValue
 *
 * Returns 0 if preValue is 0.
 */
export function equityReturnPct(preValue: number, postValue: number): number {
  if (preValue === 0) return 0;
  return (100 * (postValue - preValue)) / preValue;
}

// ── closedTradesCount ─────────────────────────────────────────────────────────

/**
 * Count fills where closedPnl is non-zero.
 *
 * Per §7.6: count of fills where closedPnl != 0
 *
 * Parses as float to handle "0", "0.0", "0.00", "-0.0", "+0.0" etc.
 * NaN (non-numeric input) and empty string are treated as not-closed (excluded).
 */
export function closedTradesCount(fills: HlFill[]): number {
  return fills.filter((f) => {
    const v = parseFloat(f.closedPnl);
    return !isNaN(v) && v !== 0;
  }).length;
}

// ── tradedNotionalMultiple ────────────────────────────────────────────────────

/**
 * Compute traded notional multiple.
 *
 * Per §7.6: sum_i(|sz_i * px_i|) / preValue
 *
 * Returns 0 if preValue is 0.
 */
export function tradedNotionalMultiple(fills: HlFill[], preValue: number): number {
  if (preValue === 0) return 0;
  const total = fills.reduce((acc, f) => {
    const sz = parseFloat(f.sz);
    const px = parseFloat(f.px);
    return acc + Math.abs(sz * px);
  }, 0);
  return total / preValue;
}
