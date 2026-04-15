'use client';

import type { LegacyInvariant, InvariantMeasurement, HealthStatus } from '../../lib/invariant-types';
import { getHealthStatusColor, getLegacyInvariantText } from '../../lib/invariant-utils';
import { cn } from '../../lib/utils';

export interface LegacyInvariantCardProps {
  invariant: LegacyInvariant;
  measurement?: InvariantMeasurement;
  status?: HealthStatus;
  compact?: boolean;
  className?: string;
}

export function LegacyInvariantCard({
  invariant,
  measurement,
  status = 'unknown',
  compact = false,
  className,
}: LegacyInvariantCardProps) {
  const formatScore = (score: number | boolean | undefined): string => {
    if (score === undefined) return '—';
    if (typeof score === 'boolean') return score ? 'PASS' : 'FAIL';
    return String(score);
  };

  const text = getLegacyInvariantText(invariant);
  const isHealthy = status === 'healthy';
  const isCritical = status === 'critical';

  // Retro Terminal Colors
  const terminalColor = isHealthy ? 'text-green-500' : isCritical ? 'text-red-500' : 'text-muted-foreground';
  const terminalBorder = isHealthy ? 'border-green-500' : isCritical ? 'border-red-500' : 'border-border';

  if (compact) {
    return (
      <div className={cn('flex items-center justify-between gap-4 py-2 bg-card border-b border-border text-foreground font-mono', className)}>
        <div className="flex items-center gap-3 min-w-0">
          <div className="w-2 h-2 rounded animate-pulse bg-muted-foreground/70" />
          <code className="text-[10px] uppercase tracking-wider text-muted-foreground">
            {invariant.id}
          </code>
          <span className="text-sm truncate font-medium font-mono text-foreground">
            {text}
          </span>
        </div>

        <div className="shrink-0 font-bold tracking-widest text-xs">
          {formatScore(measurement?.score)}
        </div>
      </div>
    );
  }

  return (
    <div className={cn('relative rounded overflow-hidden bg-card border-2 border-border shadow-inner group', className)}>
      {/* CRT Scanline Effect (subtle) */}
      <div
        className="absolute inset-0 pointer-events-none opacity-[0.03] bg-[linear-gradient(rgba(18,16,16,0)_50%,rgba(0,0,0,0.18)_50%),linear-gradient(90deg,rgba(0,0,0,0.05),rgba(0,0,0,0.02),rgba(0,0,0,0.05))]"
        style={{ backgroundSize: '100% 2px, 3px 100%' }}
      />

      <div className="p-5 font-mono">
        <div className="flex items-center justify-between mb-4 border-b border-border pb-2">
          <div className="flex items-center gap-2">
            <div className="w-3 h-3 border border-border bg-muted flex items-center justify-center">
              <div className={cn("w-1.5 h-1.5 rounded-full", isHealthy ? "bg-green-500" : isCritical ? "bg-red-500" : "bg-muted-foreground")} />
            </div>
            <div className="text-[10px] uppercase tracking-wider font-bold text-muted-foreground">
              LEGACY TERMINAL
            </div>
          </div>

          <div className={cn("text-xs uppercase px-2 py-0.5 border rounded-sm tracking-widest", terminalBorder, terminalColor)}>
            {status}
          </div>
        </div>

        {/* Terminal Content */}
        <div className="space-y-4 relative z-10">
          <div>
            <span className="mr-2 text-muted-foreground">$</span>
            <span className="font-bold text-sm tracking-tight text-foreground">{text}</span>
          </div>

          {(invariant.measurement || invariant.description) && (
            <div className="pl-4 border-l border-border space-y-2">
              {invariant.measurement && (
                <p className="text-xs text-muted-foreground">
                  <span className="uppercase text-[9px] tracking-widest opacity-70">MEASUREMENT:</span><br />
                  {invariant.measurement}
                </p>
              )}
              {invariant.description && (
                <p className="text-xs text-muted-foreground">
                  <span className="uppercase text-[9px] tracking-widest opacity-70">DESC:</span><br />
                  {invariant.description}
                </p>
              )}
            </div>
          )}

          {invariant.examples && (
            <div className="grid grid-cols-2 gap-4 text-[10px] mt-4 pt-4 border-t border-dashed border-border">
              <div className="text-green-800/80">
                <span className="block mb-1 font-bold text-green-700">DO &gt;&gt;</span>
                {invariant.examples.do?.join('; ')}
              </div>
              <div className="text-red-800/80">
                <span className="block mb-1 font-bold text-red-700">DON'T &gt;&gt;</span>
                {invariant.examples.dont?.join('; ')}
              </div>
            </div>
          )}

          {measurement && (
            <div className="mt-4 p-2 border border-border rounded-sm bg-muted">
              <div className="flex justify-between items-center">
                <span className="text-xs text-muted-foreground">OUTPUT:</span>
                <span className={cn("font-bold text-lg", terminalColor)}>{formatScore(measurement.score)}</span>
              </div>
              {measurement.context && (
                <div className="mt-1 pt-1 border-t border-border text-xs font-mono opacity-80 text-muted-foreground">
                  {measurement.context}
                </div>
              )}
            </div>
          )}
        </div>

        {invariant.commentary && (
          <div className="mt-4 pt-2 border-t border-border text-[10px] italic text-muted-foreground">
               // {invariant.commentary}
          </div>
        )}
      </div>
    </div>
  );
}
