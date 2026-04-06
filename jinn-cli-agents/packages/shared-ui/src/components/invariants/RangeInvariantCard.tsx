'use client';

import type { RangeInvariant, InvariantMeasurement, HealthStatus } from '../../lib/invariant-types';
import { cn } from '../../lib/utils';

export interface RangeInvariantCardProps {
  invariant: RangeInvariant;
  measurement?: InvariantMeasurement;
  status?: HealthStatus;
  compact?: boolean;
  className?: string;
}

export function RangeInvariantCard({
  invariant,
  measurement,
  status = 'unknown',
  compact = false,
  className,
}: RangeInvariantCardProps) {
  const value = typeof measurement?.score === 'number' ? measurement.score : null;
  const min = invariant.min ?? 0;
  const max = invariant.max ?? 100;

  // Calculate relative positions for the gauge
  // We add some buffer visual space below min and above max
  const range = max - min;
  const buffer = range * 0.2; // 20% buffer
  const visualMin = min - buffer;
  const visualMax = max + buffer;
  const visualRange = visualMax - visualMin;

  const getPercent = (val: number) => {
    return Math.min(Math.max(((val - visualMin) / visualRange) * 100, 0), 100);
  };

  const minPos = getPercent(min);
  const maxPos = getPercent(max);
  const valuePos = value !== null ? getPercent(value) : 0;

  // Colors
  const isHealthy = status === 'healthy';
  const isCritical = status === 'critical';

  const gaugeColor = isHealthy
    ? 'bg-green-500 shadow-[0_0_8px_rgba(34,197,94,0.6)]'
    : isCritical
      ? 'bg-red-500 shadow-[0_0_8px_rgba(239,68,68,0.6)]'
      : 'bg-muted-foreground';

  // Compact View
  if (compact) {
    return (
      <div className={cn('flex items-center justify-between gap-4 py-2 bg-card border-b border-border text-foreground font-mono', className)}>
        <div className="flex items-center gap-3 min-w-0">
          <div className="w-16 h-2 bg-muted rounded-full relative overflow-hidden border border-border">
            {/* Safe Zone */}
            <div
              className="absolute top-0 bottom-0 bg-muted-foreground/30"
              style={{ left: `${minPos}%`, width: `${maxPos - minPos}%` }}
            />
            {/* Needle */}
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
            {invariant.metric}: {value ?? '—'}
          </span>
        </div>

        <div className="shrink-0 font-bold tracking-widest text-xs">
          {value !== null ? value : '—'}
        </div>
      </div>
    );
  }

  // Full Retro Gauge View
  return (
    <div className={cn('relative rounded overflow-hidden bg-card border-2 border-border shadow-inner', className)}>
      {/* Panel Decoration */}
      <div className="absolute top-2 left-2 w-1.5 h-1.5 rounded-full bg-muted shadow-[inset_0_1px_1px_rgba(0,0,0,0.08)]" />
      <div className="absolute top-2 right-2 w-1.5 h-1.5 rounded-full bg-muted shadow-[inset_0_1px_1px_rgba(0,0,0,0.08)]" />
      <div className="absolute bottom-2 left-2 w-1.5 h-1.5 rounded-full bg-muted shadow-[inset_0_1px_1px_rgba(0,0,0,0.08)]" />
      <div className="absolute bottom-2 right-2 w-1.5 h-1.5 rounded-full bg-muted shadow-[inset_0_1px_1px_rgba(0,0,0,0.08)]" />

      <div className="p-5">
        {/* Header Plate */}
        <div className="flex items-center justify-between mb-4 border-b border-border pb-2">
          <div className="flex items-center gap-2">
            <div className="px-1.5 py-0.5 text-[10px] font-mono rounded border border-border bg-muted text-muted-foreground shadow-sm">
              ID: {invariant.id}
            </div>
            <div className="text-[10px] uppercase tracking-wider font-bold text-muted-foreground">
              ANALOG METER
            </div>
          </div>

          {/* Digital Readout */}
          <div className="rounded px-2 py-1 min-w-[60px] text-right bg-background border border-border shadow-[inset_0_1px_2px_rgba(0,0,0,0.12)]">
            <span className={cn("font-mono font-bold text-lg leading-none tracking-widest", isHealthy ? "text-green-500" : isCritical ? "text-red-500" : "text-muted-foreground")}>
              {value ?? '---'}
            </span>
          </div>
        </div>

        {/* Gauge Assembly */}
        <div className="relative h-16 mb-4 rounded border border-border shadow-inner px-4 overflow-hidden bg-muted">
          {/* Grid Lines (Background) */}
          <div
            className="absolute inset-0 opacity-20"
            style={{ backgroundImage: 'linear-gradient(to right, rgba(100,116,139,0.35) 1px, transparent 1px)', backgroundSize: '10% 100%' }}
          />

          {/* Safe Zone Indicator */}
          <div
            className="absolute top-2 bottom-0 bg-green-500/10 border-x border-green-500/30"
            style={{ left: `${minPos}%`, width: `${maxPos - minPos}%` }}
          >
            <div
              className="w-full h-full opacity-50 bg-[url('data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHdpZHRoPSI0IiBoZWlnaHQ9IjQiPgo8cmVjdCB3aWR0aD0iNCIgaGVpZ2h0PSI0IiBmaWxsPSIjZTVmYmU1IiBmaWxsLW9wYWNpdHk9IjAuNiIvPgo8cGF0aCBkPSJNTAgNEw0IiBzdHJva2U9IiMxNmE0MzQiIHN0cm9rZS13aWR0aD0iMSIvPgo8L3N2Zz4=')]"
            />
          </div>

          {/* Threshold Markings */}
          <div className="absolute top-0 bottom-0 border-l border-dashed border-border opacity-50" style={{ left: `${minPos}%` }}>
            <span className="absolute top-1 left-1 text-[9px] font-mono text-muted-foreground">{min}</span>
          </div>
          <div className="absolute top-0 bottom-0 border-l border-dashed border-border opacity-50" style={{ left: `${maxPos}%` }}>
            <span className="absolute top-1 -left-4 text-[9px] font-mono w-3 text-right text-muted-foreground">{max}</span>
          </div>

          {/* The Needle/Pointer */}
          {value !== null && (
            <div
              className="absolute top-2 bottom-0 w-0.5 bg-red-500 transition-all duration-500 ease-out z-10"
              style={{ left: `${valuePos}%` }}
            >
              {/* Needle Head */}
              <div className="absolute -top-1 -left-1.5 w-0 h-0 border-l-[6px] border-r-[6px] border-t-[8px] border-l-transparent border-r-transparent border-t-red-500 drop-shadow-md" />
              {/* Needle Glow */}
              <div className="absolute inset-0 bg-red-500 blur-[2px] opacity-70" />
            </div>
          )}
        </div>

        {/* Labels */}
        <div className="flex justify-between items-baseline">
          <h3 className="font-mono text-sm text-foreground">{invariant.min} ≤ {invariant.metric} ≤ {invariant.max}</h3>
          <p className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
            Metric: {invariant.metric}
          </p>
        </div>

        {/* Assessment */}
        <div className="mt-3 text-xs text-muted-foreground border-l-2 border-border pl-3">
          {invariant.assessment}
        </div>
      </div>
    </div>
  );
}
