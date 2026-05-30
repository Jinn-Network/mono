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

export function ActiveOperatorTooltipBody({ window }: { window: ActiveWindow }) {
  return (
    <>
      <div>
        Earned ≥3 tJINN in each of the last 8 completed UTC 6-hour blocks.
        The in-progress block is excluded.
      </div>
      <div style={{ marginTop: 6 }}>
        Window: {formatWindowTs(window.startTs)} → {formatWindowTs(window.endTs)} (UTC).
      </div>
    </>
  );
}
