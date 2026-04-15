'use client';

import type { BooleanInvariant, InvariantMeasurement, HealthStatus } from '../../lib/invariant-types';
import { cn } from '../../lib/utils';

export interface BooleanInvariantCardProps {
  invariant: BooleanInvariant;
  measurement?: InvariantMeasurement;
  status?: HealthStatus;
  compact?: boolean;
  className?: string;
}

export function BooleanInvariantCard({
  invariant,
  measurement,
  status = 'unknown',
  compact = false,
  className,
}: BooleanInvariantCardProps) {
  const isPass = measurement?.score === true;
  const isFail = measurement?.score === false;
  // If undefined/unknown, we consider it "off" or "neutral"

  // -- RETRO STYLES --
  // We use standard Tailwind colors but applied to simulate glowing lights/plastic switches.

  // Pilot Light Colors
  const lightColors = {
    pass: 'bg-green-500 shadow-[0_0_8px_2px_rgba(34,197,94,0.5)] border-green-600',
    fail: 'bg-red-600 shadow-[0_0_8px_2px_rgba(220,38,38,0.5)] border-red-700',
    unknown: 'bg-muted-foreground/50 border-border opacity-60',
  };

  const currentLightClass = isPass
    ? lightColors.pass
    : isFail
      ? lightColors.fail
      : lightColors.unknown;

  // Toggle Switch Position
  // UP = Pass (True), DOWN = Fail (False), MIDDLE/NEUTRAL = Unknown
  // We'll simulate a 2-position switch for boolean. 
  // If unknown, maybe just show it in a "neutral" state or just "off".
  const switchPosition = isPass ? 'translate-x-6' : 'translate-x-0';
  const switchColor = isPass ? 'bg-stone-200' : 'bg-stone-300';

  if (compact) {
    return (
      <div className={cn('flex items-center justify-between gap-4 py-2 bg-card border-b border-border text-foreground font-mono', className)}>
        <div className="flex items-center gap-3 min-w-0">
          {/* Pilot Light (Mini) */}
          <div className={cn('w-3 h-3 rounded-full border', currentLightClass)} />

          <code className="text-[10px] uppercase tracking-wider text-muted-foreground">
            {invariant.id}
          </code>
          <span className="text-sm truncate font-medium text-foreground">{invariant.condition}</span>
        </div>

        {/* Status Text (Retro Terminal Style) */}
        <div className="shrink-0 font-bold tracking-widest text-xs">
          {status === 'healthy' ? (
            <span className="text-green-500 drop-shadow-sm">PASSED</span>
          ) : status === 'critical' ? (
            <span className="text-red-500 drop-shadow-sm">FAILED</span>
          ) : (
            <span className="text-muted-foreground">NO SIGNAL</span>
          )}
        </div>
      </div>
    );
  }

  // Full Card: Retro Control Panel Module
  return (
    <div className={cn('relative rounded overflow-hidden bg-card border-2 border-border shadow-inner', className)}>
      {/* Panel Screw Holes (Cosmetic) */}
      <div className="absolute top-2 left-2 w-1.5 h-1.5 rounded-full bg-muted shadow-[inset_0_1px_1px_rgba(0,0,0,0.08)]" />
      <div className="absolute top-2 right-2 w-1.5 h-1.5 rounded-full bg-muted shadow-[inset_0_1px_1px_rgba(0,0,0,0.08)]" />
      <div className="absolute bottom-2 left-2 w-1.5 h-1.5 rounded-full bg-muted shadow-[inset_0_1px_1px_rgba(0,0,0,0.08)]" />
      <div className="absolute bottom-2 right-2 w-1.5 h-1.5 rounded-full bg-muted shadow-[inset_0_1px_1px_rgba(0,0,0,0.08)]" />

      <div className="p-5 flex items-start gap-6">

        {/* Left Control Group: Status Light & Switch */}
        <div className="flex flex-col items-center gap-3 shrink-0 pt-1">
          {/* Pilot Light Label */}
          <span className="text-[9px] uppercase font-bold tracking-widest text-center w-full block mb-[-4px] text-muted-foreground">
            STATUS
          </span>

          {/* Pilot Light Assembly */}
          <div className="relative flex items-center justify-center p-2 rounded-full border border-border bg-muted shadow-[inset_0_1px_2px_rgba(0,0,0,0.12)]">
            <div className={cn('w-4 h-4 rounded-full transition-all duration-300', currentLightClass)} />
            {/* Glass Reflection effect */}
            <div className="absolute top-[25%] left-[25%] w-1.5 h-1.5 rounded-full bg-white opacity-50" />
          </div>

          {/* Toggle Switch */}
          <div className="mt-2 flex flex-col items-center gap-1">
            <div
              className="w-12 h-6 rounded-full border border-border relative p-1 bg-background shadow-[inset_0_1px_2px_rgba(0,0,0,0.2)]"
              title={isPass ? "System Active/Passed" : "System Fault/Failed"}
            >
              <div className={cn('w-4 h-4 rounded-full shadow-md transition-transform duration-200 border border-stone-400 bg-gradient-to-t from-stone-400 to-stone-100', switchPosition, switchColor)} />
            </div>
            <span className="text-[8px] font-mono uppercase text-muted-foreground">
              {isPass ? 'ON' : 'OFF'}
            </span>
          </div>
        </div>

        {/* Main Content Area: LCD Screen / Label Plate */}
        <div className="flex-1 min-w-0 flex flex-col gap-2">
          {/* Metadata Plate */}
          <div className="flex items-center gap-2 border-b border-border pb-2 mb-1">
            <div className="px-1.5 py-0.5 text-[10px] font-mono rounded border border-border bg-muted text-muted-foreground shadow-sm">
              ID: {invariant.id}
            </div>
            <div className="w-1 h-1 rounded-full bg-muted-foreground/70" />
            <div className="text-[10px] uppercase tracking-wider font-bold text-muted-foreground">
              BOOLEAN CHECK
            </div>
          </div>

          {/* Main Condition Text */}
          <h3 className="font-mono text-sm leading-relaxed tracking-tight text-foreground">
            {invariant.condition}
          </h3>

          {/* LCD Output for Context */}
          {measurement?.context && (
            <div className="mt-3 p-2 border border-border rounded-sm bg-muted">
              <p className="font-mono text-xs text-green-600 opacity-90 truncate">
                {'>'} {measurement.context}
              </p>
            </div>
          )}

          {!measurement && (
            <div className="mt-3 p-2 border border-border rounded-sm bg-muted">
              <p className="font-mono text-xs text-muted-foreground animate-pulse">
                WAITING FOR SIGNAL...
              </p>
            </div>
          )}
        </div>
      </div>

      {/* Assessment Plate at Bottom */}
      <div className="border-t-2 border-border bg-muted/60 px-4 py-2">
        <p className="text-[11px] font-medium leading-normal text-muted-foreground">
          {invariant.assessment}
        </p>
      </div>
    </div>
  );
}
