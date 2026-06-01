/**
 * Canonical "active operator" tooltip body — kept in one place so the
 * `/operators` stat strip, the `Active?` column header, and the `/network`
 * activity strip render the same definition copy verbatim.
 *
 * The spec (`docs/superpowers/specs/2026-05-30-active-operator-explorer-design.md`)
 * mandates a single definition surfaced verbatim on every active-operator
 * surface; this module is that surface.
 */
import type { ActiveWindow } from '../lib/api';

/** UTC seconds → `YYYY-MM-DD HH:MM UTC`. Falls back to `—` for non-finite / ≤0. */
export function formatWindowTs(ts: number): string {
  if (!Number.isFinite(ts) || ts <= 0) return '—';
  return new Date(ts * 1000)
    .toISOString()
    .replace('T', ' ')
    .replace(/:\d\d\.\d+Z$/, ' UTC');
}

/**
 * Native-`title` formatter for one Activity-blocks cell —
 * `2026-05-29 06:00 → 2026-05-29 12:00 UTC`. Only the close end carries
 * the `UTC` suffix so the title doesn't read it twice.
 *
 * `i` is the cell's index into `recentBlocks` (0 = oldest, blockCount-1 = newest).
 */
export function formatBlockWindow(window: ActiveWindow, i: number): string {
  const start = window.startTs + i * window.blockSeconds;
  const end = start + window.blockSeconds;
  return `${formatWindowTs(start).replace(/\s+UTC$/, '')} → ${formatWindowTs(end)}`;
}

/**
 * Liveness body (issue #926) — used wherever the word "Active" appears: the
 * `/operators` stat strip, the `Active?` column header, and the `/network`
 * activity strip. "Active" means earning in the newest completed block, NOT
 * the 48h-sustained gate (see {@link SustainedOperatorTooltipBody}).
 */
export function ActiveOperatorTooltipBody({ window }: { window: ActiveWindow }) {
  return (
    <>
      <div>
        Earned ≥3 tJINN in the most recent completed UTC 6-hour block. The
        in-progress block is excluded. "Active now" — not the 48h gate.
      </div>
      <div style={{ marginTop: 6 }}>
        Latest completed block: {formatWindowTs(window.endTs - window.blockSeconds)} →{' '}
        {formatWindowTs(window.endTs)} (UTC).
      </div>
    </>
  );
}

/**
 * Sustained body (issue #926) — the 48h Milestone-1 gate: qualified in EVERY
 * one of the 8 completed blocks. Used by the `/operators` "Sustained (48h)"
 * stat.
 */
export function SustainedOperatorTooltipBody({ window }: { window: ActiveWindow }) {
  return (
    <>
      <div>
        Earned ≥3 tJINN in each of the last 8 completed UTC 6-hour blocks (the
        48h Milestone-1 gate). The in-progress block is excluded.
      </div>
      <div style={{ marginTop: 6 }}>
        Window: {formatWindowTs(window.startTs)} → {formatWindowTs(window.endTs)} (UTC).
      </div>
    </>
  );
}
