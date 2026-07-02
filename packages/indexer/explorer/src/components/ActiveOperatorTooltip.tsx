import type { ActiveWindow } from '../lib/api';

export function formatWindowTs(ts: number): string {
  if (!Number.isFinite(ts) || ts <= 0) return '—';
  return new Date(ts * 1000)
    .toISOString()
    .replace('T', ' ')
    .replace(/:\d\d\.\d+Z$/, ' UTC');
}

export function formatBlockWindow(window: ActiveWindow, i: number): string {
  const start = window.startTs + i * window.blockSeconds;
  const end = start + window.blockSeconds;
  return `${formatWindowTs(start).replace(/\s+UTC$/, '')} -> ${formatWindowTs(end)}`;
}

export function ActiveOperatorTooltipBody({ window }: { window: ActiveWindow }) {
  return (
    <>
      <div>
        Earned at least 3 OLAS in the most recent completed UTC 6-hour block.
        The in-progress block is excluded.
      </div>
      <div style={{ marginTop: 6 }}>
        Latest completed block: {formatWindowTs(window.endTs - window.blockSeconds)}{' -> '}
        {formatWindowTs(window.endTs)}.
      </div>
    </>
  );
}

export function SustainedOperatorTooltipBody({ window }: { window: ActiveWindow }) {
  return (
    <>
      <div>
        Earned at least 3 OLAS in each of the last 8 completed UTC 6-hour
        blocks. The in-progress block is excluded.
      </div>
      <div style={{ marginTop: 6 }}>
        Window: {formatWindowTs(window.startTs)}{' -> '}{formatWindowTs(window.endTs)}.
      </div>
    </>
  );
}

export function Milestone3TooltipBody() {
  return (
    <div>
      Distinct recipient Safes that have earned at least 25 OLAS lifetime.
      Counted per recipient Safe.
    </div>
  );
}
