/**
 * SliceChrome — slice-aware chrome that wraps the learning curve.
 *
 * Extracted from SolverNetView (refactor #676) once that file crossed the
 * ~600-line extraction threshold. Both helpers are pure presentation and
 * have no consumers outside SolverNetView; they live here only to keep the
 * view file readable.
 */

import { LearningCurve } from './LearningCurve';
import { int } from '../lib/format';
import type { FilterMap } from '../lib/url-state';

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
}: {
  rolling: number[];
  window: number;
  showMilestoneChrome: boolean;
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
      <LearningCurve buckets={[]} rolling={rolling} mode="rolling" />
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

export function ActiveSliceChips({
  group,
  filters,
  window,
}: {
  group: string;
  filters: FilterMap;
  window: number;
}) {
  const chips: string[] = [];
  if (group !== 'none') chips.push(`group:${group}`);
  for (const [dim, vals] of Object.entries(filters)) {
    if (vals) for (const v of vals) chips.push(`${dim}:${v}`);
  }
  chips.push(`window:${window}`);
  return (
    <div
      style={{
        display: 'flex',
        flexWrap: 'wrap',
        gap: 8,
        fontFamily: 'var(--font-mono)',
        fontSize: 11,
        color: 'var(--fg-muted)',
        letterSpacing: '0.10em',
        textTransform: 'uppercase',
      }}
      data-testid="active-slice-chips"
    >
      {chips.map((c) => (
        <span
          key={c}
          style={{
            padding: '2px 8px',
            border: '1px solid var(--border)',
            borderRadius: 'var(--radius-pill)',
          }}
        >
          {c}
        </span>
      ))}
    </div>
  );
}
