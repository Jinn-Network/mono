/**
 * SliceChrome — slice-aware chrome that wraps the learning curve.
 *
 * Extracted from SolverNetView (refactor #676) once that file crossed the
 * ~600-line extraction threshold. The helper is pure presentation and has
 * no consumers outside SolverNetView; it lives here only to keep the
 * view file readable. (The legacy ActiveSliceChips helper was deleted in
 * #687 — its surface is owned by FilterChipStrip now.)
 */

import { LearningCurve } from './LearningCurve';
import { int } from '../lib/format';

const ROLLING_FLOOR = 130;
const MILESTONE_OFFSET = 100;

/**
 * Single-series chart + below-floor empty-state + t-99 hairline label.
 *
 * The empty-state and hairline are gated by the caller — see
 * "explicit slice context?" in SolverNetView — so the surface stays clean at
 * SolverNetView defaults.
 */
export function ChartWithMilestoneMark({
  rolling,
  window,
  showMilestoneChrome,
  baseline,
}: {
  rolling: number[];
  window: number;
  showMilestoneChrome: boolean;
  /**
   * Lifetime resolved-rate forwarded to `LearningCurve` as the dashed
   * reference line + right-edge delta. #696 — surfaces #647's acceptance
   * criterion ("right edge above baseline") visibly. Hidden by the inner
   * gates when conditions don't apply (buckets mode, grouped, empty data);
   * also gated here by the below-floor empty-state path which returns early
   * before any chart renders.
   */
  baseline?: number;
}) {
  if (showMilestoneChrome && rolling.length < ROLLING_FLOOR) {
    return (
      <div
        style={{
          background: 'var(--bg-elevated)',
          border: '1px solid var(--border)',
          borderRadius: 'var(--radius-3)',
          padding: 28,
          fontFamily: 'var(--font-mono)',
          fontSize: 11,
          letterSpacing: '0.14em',
          textTransform: 'uppercase',
          color: 'var(--fg-dim)',
          textAlign: 'center',
        }}
        data-testid="explore-below-floor"
      >
        Need 130 envelope-enriched verdicts · have {int(rolling.length)}
      </div>
    );
  }

  const markIdx = rolling.length - MILESTONE_OFFSET;

  return (
    <div style={{ position: 'relative' }}>
      <LearningCurve
        buckets={[]}
        rolling={rolling}
        mode="rolling"
        baseline={baseline}
      />
      {showMilestoneChrome && rolling.length >= ROLLING_FLOOR && (
        <div
          style={{
            marginTop: 6,
            display: 'flex',
            justifyContent: 'space-between',
            fontFamily: 'var(--font-mono)',
            fontSize: 11,
            color: 'var(--fg-dim)',
            letterSpacing: '0.06em',
          }}
        >
          <span>
            Trailing-{window} over {rolling.length} envelope-enriched verdicts
          </span>
          <span style={{ color: 'var(--wane)' }}>
            t − 99 at index {markIdx}
          </span>
        </div>
      )}
    </div>
  );
}

