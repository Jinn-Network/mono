/**
 * Integrity checks for portfolio.v0.eval — §7.4.
 *
 * impl-declared:
 *   integrity.window_bounds   (pre.capturedAt >= startTs, post.capturedAt >= endTs)
 *
 * engine-prepended (NOT this impl's job):
 *   integrity.signature
 *   integrity.signedTask_ref
 *   integrity.onchain_anchor
 *
 * FAIL in any integrity.* check → verdict FAIL per §7.3.
 */

import type { Check } from '../types.js';

// ── window_bounds ─────────────────────────────────────────────────────────────

/**
 * Check that snapshot timestamps are within the declared window bounds.
 *
 * Per §7.4:
 *   pre.capturedAt >= startTs
 *   post.capturedAt >= endTs
 *
 * (The harness should have captured these at the right times, so a violation
 * indicates the manifest was produced outside the valid window.)
 */
export function checkWindowBounds(
  preCapturedAt: number,
  postCapturedAt: number,
  startTs: number,
  endTs: number,
): Check {
  const preOk = preCapturedAt >= startTs;
  const postOk = postCapturedAt >= endTs;

  if (preOk && postOk) {
    return { name: 'integrity.window_bounds', status: 'PASS' };
  }

  const violations: string[] = [];
  if (!preOk) {
    violations.push(
      `pre.capturedAt (${preCapturedAt}) < startTs (${startTs})`,
    );
  }
  if (!postOk) {
    violations.push(
      `post.capturedAt (${postCapturedAt}) < endTs (${endTs})`,
    );
  }

  return {
    name: 'integrity.window_bounds',
    status: 'FAIL',
    detail: violations.join('; '),
  };
}
