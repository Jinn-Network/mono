/**
 * Portfolio grid bracketing helper.
 *
 * Hyperliquid's `portfolio` endpoint returns `accountValueHistory` on a
 * rolling ~140-minute grid. Given a target timestamp, this module finds the
 * two grid points immediately before and after it — the "bracket" — which
 * the evaluator uses to verify pre-snapshot account value.
 *
 * This module is pure (no I/O). Pass in the grid and a target; get back a
 * bracket or null if bracketing is not possible.
 */

import type { HlGridPoint } from './types.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface GridBracket {
  /** The last grid point at or before targetTs. */
  before: HlGridPoint;
  /** The first grid point strictly after targetTs. */
  after: HlGridPoint;
}

// ---------------------------------------------------------------------------
// Core helper
// ---------------------------------------------------------------------------

/**
 * Given an `accountValueHistory` array and a target timestamp, returns the two
 * grid points that bracket the target.
 *
 * - If `targetTs` is exactly on a grid point, that point is returned as
 *   `before` and the next point is `after`.
 * - Returns `null` when:
 *   - The grid is empty.
 *   - `targetTs` is before all grid points (no `before` candidate).
 *   - `targetTs` is at or after the last grid point (no `after` candidate).
 *
 * The input array does not need to be sorted — this function sorts by timestamp
 * before searching.
 *
 * @param history  Array of [timestamp_ms, value_str] grid points.
 * @param targetTs Target timestamp in epoch milliseconds.
 */
export function bracketGridPoints(
  history: HlGridPoint[],
  targetTs: number,
): GridBracket | null {
  if (history.length === 0) return null;

  // Sort ascending by timestamp.
  const sorted = [...history].sort((a, b) => a[0] - b[0]);

  // Find the last point with timestamp <= targetTs.
  let beforeIdx = -1;
  for (let i = 0; i < sorted.length; i++) {
    if (sorted[i]![0] <= targetTs) {
      beforeIdx = i;
    } else {
      break;
    }
  }

  if (beforeIdx === -1) {
    // Target is before all grid points.
    return null;
  }

  const afterIdx = beforeIdx + 1;
  if (afterIdx >= sorted.length) {
    // Target is at or after the last grid point — no after candidate.
    return null;
  }

  return {
    before: sorted[beforeIdx]!,
    after: sorted[afterIdx]!,
  };
}
