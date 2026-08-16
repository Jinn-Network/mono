/**
 * Score function for portfolio.v0 evaluation — §7.8.
 *
 * scoreBasis: "calmar.v1"
 * score_calmar_v1 =
 *   if verdict != PASS: "0"
 *   else:
 *     ratio = clamp(equityReturnPct / max(maxDrawdownPct, 1.0%), 0, 10.0)
 *     encoded = ratio * 1e17   // range [0, 1e18]
 *     encoded as decimal string
 */

import type { Verdict } from './types.js';

/**
 * Compute the calmar.v1 score.
 *
 * @param equityReturnPct  Equity return percentage (e.g. 5.0 for +5%)
 * @param maxDrawdownPctVal  Max drawdown percentage (e.g. 2.0 for 2%)
 * @param verdict  The evaluation verdict
 * @returns Fixed-point string in 1e18 scale; "0" for any non-PASS verdict
 */
export function scoreCalmarV1(
  equityReturnPct: number,
  maxDrawdownPctVal: number,
  verdict: Verdict,
): string {
  if (verdict !== 'PASS') {
    return '0';
  }

  const denominator = Math.max(maxDrawdownPctVal, 1.0);
  const ratio = Math.min(Math.max(equityReturnPct / denominator, 0), 10.0);

  // ratio * 1e17 → range [0, 1e18]
  // Use BigInt arithmetic to avoid floating-point precision loss in the
  // fixed-point representation.
  const ratioBig = BigInt(Math.round(ratio * 1e17));

  return ratioBig.toString();
}
