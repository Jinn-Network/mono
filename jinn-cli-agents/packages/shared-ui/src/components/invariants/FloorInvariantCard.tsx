'use client';

import type { FloorInvariant, InvariantMeasurement, HealthStatus } from '../../lib/invariant-types';
import { cn } from '../../lib/utils';
import { invariantTypeBadgeColors } from '../../lib/invariant-utils';

export interface FloorInvariantCardProps {
  invariant: FloorInvariant;
  measurement?: InvariantMeasurement;
  status?: HealthStatus;
  compact?: boolean;
  className?: string;
}

export function FloorInvariantCard({
  invariant,
  measurement,
  status = 'unknown',
  compact = false,
  className,
}: FloorInvariantCardProps) {
  const value = typeof measurement?.score === 'number' ? measurement.score : null;
  const min = invariant.min ?? 0;

  // For visual range, we need a sensible max since Floor only has a min.
  // If we have a value, we try to center the view around min/value.
  // Default range: 0 to min * 2
  const max = value !== null && value > min * 2 ? value * 1.1 : (min === 0 ? 100 : min * 2);

  // Ensure we show at least some range below min
  const buffer = (max - min) * 0.2;
  const visualMin = Math.max(0, min - buffer * 2); // Show below floor
  const visualMax = max;
  const visualRange = visualMax - visualMin || 100;

  const getPercent = (val: number) => {
    return Math.min(Math.max(((val - visualMin) / visualRange) * 100, 0), 100);
  };

  const minPos = getPercent(min);
  const valuePos = value !== null ? getPercent(value) : 0;

  const isHealthy = status === 'healthy';
  const isCritical = status === 'critical';
  const isUnknown = status === 'unknown';

  const gaugeColor = isHealthy
    ? 'bg-green-500 shadow-[0_0_8px_rgba(34,197,94,0.6)]'
    : isCritical
      ? 'bg-red-500 shadow-[0_0_8px_rgba(239,68,68,0.6)]'
      : 'bg-muted-foreground';

  if (compact) {
    return (
      <div className={cn('flex items-center justify-between gap-4 py-2 bg-card border-b border-border text-foreground font-mono', className)}>
        <div className="flex items-center gap-3 min-w-0">
          <div className="w-16 h-2 bg-muted rounded-full relative overflow-hidden border border-border">
            {/* Safe Zone (Above Floor) */}
            <div
              className="absolute top-0 bottom-0 bg-muted-foreground/30"
              style={{ left: `${minPos}%`, right: 0 }}
            />
            {value !== null && (
              <div
                className={cn("absolute top-0 bottom-0 w-1", gaugeColor)}
                style={{ left: `${valuePos}%` }}
              />
            )}
          </div>

          <code className="text-[10px] uppercase tracking-wider text-muted-foreground">
            {invariant.id}
          </code>
          <span className="text-sm truncate font-medium text-foreground">
            {invariant.metric} ≥ {invariant.min}
          </span>
        </div>

        <div className="shrink-0 font-bold tracking-widest text-xs">
          {value !== null ? value : '—'}
        </div>
      </div>
    );
  }

  return (
    <div className={cn('relative rounded overflow-hidden bg-card border-2 border-border shadow-inner', className)}>
      {/* Panel Decoration */}
      <div className="absolute top-2 left-2 w-1.5 h-1.5 rounded-full bg-muted shadow-[inset_0_1px_1px_rgba(0,0,0,0.08)]" />
      <div className="absolute top-2 right-2 w-1.5 h-1.5 rounded-full bg-muted shadow-[inset_0_1px_1px_rgba(0,0,0,0.08)]" />
      <div className="absolute bottom-2 left-2 w-1.5 h-1.5 rounded-full bg-muted shadow-[inset_0_1px_1px_rgba(0,0,0,0.08)]" />
      <div className="absolute bottom-2 right-2 w-1.5 h-1.5 rounded-full bg-muted shadow-[inset_0_1px_1px_rgba(0,0,0,0.08)]" />

      <div className="p-5">
        <div className="flex items-center justify-between mb-4 border-b border-border pb-2">
          <div className="flex items-center gap-2">
            <div className="px-1.5 py-0.5 text-[10px] font-mono rounded border border-border bg-muted text-muted-foreground shadow-sm">
              ID: {invariant.id}
            </div>
            <div className="text-[10px] uppercase tracking-wider font-bold text-muted-foreground">
              FLOOR LIMIT
            </div>
          </div>

          <div className="rounded px-2 py-1 min-w-[60px] text-right bg-background border border-border shadow-[inset_0_1px_2px_rgba(0,0,0,0.12)]">
            <span className={cn("font-mono font-bold text-lg leading-none tracking-widest", isHealthy ? "text-green-500" : isCritical ? "text-red-500" : "text-muted-foreground")}>
              {value ?? '---'}
            </span>
          </div>
        </div>

        {/* Gauge */}
        <div className="relative h-16 mb-4 rounded border border-border shadow-inner px-4 overflow-hidden bg-muted">
          <div
            className="absolute inset-0 opacity-20"
            style={{ backgroundImage: 'linear-gradient(to right, rgba(100,116,139,0.35) 1px, transparent 1px)', backgroundSize: '10% 100%' }}
          />

          {/* Safe Zone (Right of Floor) */}
          <div
            className="absolute top-2 bottom-0 bg-purple-500/10 border-l border-purple-500/30"
            style={{ left: `${minPos}%`, right: 0 }}
          >
            <div
              className="w-full h-full opacity-50 bg-[url('data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHdpZHRoPSI0IiBoZWlnaHQ9IjQiPgo8cmVjdCB3aWR0aD0iNCIgaGVpZ2h0PSI0IiBmaWxsPSIjZTZlZGVmIiBmaWxsLW9wYWNpdHk9IjAuNCIvPgo8cGF0aCBkPSJNTAgNEw0IiBzdHJva2U9IiM3YzNhZWQiIHN0cm9rZS13aWR0aD0iMSIvPgo8L3N2Zz4=')]"
            />
          </div>

          {/* Floor Marker */}
          <div className="absolute top-0 bottom-0 border-l-2 border-dashed border-purple-500 z-0" style={{ left: `${minPos}%` }}>
            <span className="absolute top-1 -left-1 text-[9px] font-mono px-1 rounded transform -translate-x-full text-purple-600 bg-background/80 border border-border">
              MIN {min}
            </span>
          </div>

          {/* Needle */}
          {value !== null && (
            <div
              className="absolute top-2 bottom-0 w-0.5 bg-yellow-500 transition-all duration-500 ease-out z-10"
              style={{ left: `${valuePos}%` }}
            >
              <div className="absolute -top-1 -left-1.5 w-0 h-0 border-l-[6px] border-r-[6px] border-t-[8px] border-l-transparent border-r-transparent border-t-yellow-500 drop-shadow-md" />
              <div className="absolute inset-0 bg-yellow-500 blur-[2px] opacity-70" />
            </div>
          )}
        </div>

        <div className="flex justify-between items-baseline">
          <h3 className="font-mono text-sm text-foreground">{invariant.metric} ≥ {invariant.min}</h3>
          <p className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
            Metric: {invariant.metric}
          </p>
        </div>

        <div className="mt-3 text-xs text-muted-foreground border-l-2 border-border pl-3">
          {invariant.assessment}
        </div>
      </div>
    </div>
  );
}
