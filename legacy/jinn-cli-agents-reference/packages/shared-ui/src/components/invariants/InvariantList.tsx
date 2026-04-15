'use client';

import type { Invariant, LegacyInvariant, InvariantMeasurement, HealthStatus } from '../../lib/invariant-types';
import { determineHealthStatus, countByStatus } from '../../lib/invariant-utils';
import { cn } from '../../lib/utils';
import { InvariantCard } from './InvariantCard';

export interface InvariantWithStatus {
  invariant: Invariant | LegacyInvariant;
  measurement?: InvariantMeasurement;
  status: HealthStatus;
}

export interface InvariantListProps {
  invariants: (Invariant | LegacyInvariant)[];
  measurements?: Map<string, InvariantMeasurement>;
  showSummary?: boolean;
  compact?: boolean;
  className?: string;
}

/**
 * Renders a list of invariants with optional health summary.
 */
export function InvariantList({
  invariants,
  measurements,
  showSummary = true,
  compact = false,
  className,
}: InvariantListProps) {
  // Match invariants with measurements and calculate status
  const invariantsWithStatus: InvariantWithStatus[] = invariants.map((inv) => {
    const measurement = measurements?.get(inv.id);
    const status = determineHealthStatus(inv, measurement);
    return { invariant: inv, measurement, status };
  });

  const statusCounts = countByStatus(invariantsWithStatus);
  const total = invariants.length;
  const measured = total - statusCounts.unknown;
  const passing = statusCounts.healthy;

  if (invariants.length === 0) {
    return (
      <div className={cn('p-6 text-center text-muted-foreground rounded-lg border bg-card', className)}>
        No invariants found
      </div>
    );
  }

  return (
    <div className={cn('space-y-4', className)}>
      {showSummary && (
        <div className="p-4 rounded-lg border bg-card">
          <div className="flex items-center justify-between">
            <div>
              <h3 className="text-lg font-semibold">Invariants ({total})</h3>
              <p className="text-sm text-muted-foreground">
                {measured > 0
                  ? `${passing}/${measured} passing`
                  : 'No measurements yet'}
              </p>
            </div>
            <div className="flex gap-4 text-center">
              <div>
                <div className="text-2xl font-bold text-green-500">{statusCounts.healthy}</div>
                <div className="text-xs text-muted-foreground">Healthy</div>
              </div>
              <div>
                <div className="text-2xl font-bold text-yellow-500">{statusCounts.warning}</div>
                <div className="text-xs text-muted-foreground">Warning</div>
              </div>
              <div>
                <div className="text-2xl font-bold text-red-500">{statusCounts.critical}</div>
                <div className="text-xs text-muted-foreground">Critical</div>
              </div>
              <div>
                <div className="text-2xl font-bold text-muted-foreground">{statusCounts.unknown}</div>
                <div className="text-xs text-muted-foreground">Unknown</div>
              </div>
            </div>
          </div>
        </div>
      )}

      <div className={compact ? 'divide-y rounded-lg border bg-card' : 'space-y-3'}>
        {invariantsWithStatus.map(({ invariant, measurement, status }) => (
          <InvariantCard
            key={invariant.id}
            invariant={invariant}
            measurement={measurement}
            status={status}
            compact={compact}
            className={compact ? 'px-4' : undefined}
          />
        ))}
      </div>
    </div>
  );
}
