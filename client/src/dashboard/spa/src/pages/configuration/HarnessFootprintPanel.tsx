/**
 * HarnessFootprintPanel — issue #815.
 *
 * Sibling of `CostEstimatePanel`; renders the projected AI-units
 * footprint for the operator's chosen harness/model so they know,
 * before joining or after changing model in Settings, what their node
 * will consume in a 6h block and a 7d window. Surfaces:
 *
 *   - per 6h block:   `X / 100 units`
 *   - per week:       `Y / 2800 units`
 *   - informational:  `~$N/day` (4 blocks/day × per-block USD)
 *
 * Subscription harnesses (claude-code, codex) render a "subscription
 * path" variant that says explicitly that the gate doesn't meter this
 * credential — the provider's own subscription quota is the cap. The
 * caps are still shown so the operator sees what the gate would do
 * on an api-key path. Unknown models render an "unavailable" state.
 *
 * Visual rules: no emoji, monospace numerics, softened-brutalist
 * corners (`--radius-2`) as the rest of the configuration surface.
 */

import type { JSX } from 'react';
import { Diamond } from 'lucide-react';
import {
  GPT_5_4_MINI_USD_PER_BLOCK,
  REFERENCE_CEILING,
  projectAiUnits,
} from '../../../../../spend/ai-units.js';
import { cn } from '../../lib/utils.js';

export interface HarnessFootprintPanelProps {
  harness: string | undefined;
  modelId: string | undefined;
  /** `'card'` (default) for the JoinFlow stack, `'inline'` for JoinedNetCard. */
  variant?: 'card' | 'inline';
  testIdPrefix?: string;
}

/** Format an AI-units count for the X/100 numerator slot. */
function formatUnits(units: number): string {
  if (units < 1) return units.toFixed(2);
  if (units < 10) return units.toFixed(1);
  return Math.round(units).toString();
}

export function HarnessFootprintPanel({
  harness,
  modelId,
  variant = 'card',
  testIdPrefix = 'harness-footprint',
}: HarnessFootprintPanelProps): JSX.Element | null {
  const projectedPerTask = projectAiUnits(harness, modelId);

  if (projectedPerTask === 0) {
    return (
      <div
        data-testid={`${testIdPrefix}-subscription`}
        className={cn(
          'flex flex-col gap-2 rounded-md border border-border bg-card',
          variant === 'card' ? 'px-4 py-3.5' : 'gap-1 px-2.5 py-2',
        )}
      >
        <div className="flex items-center gap-2">
          <Diamond aria-hidden="true" className="size-3 shrink-0 text-primary" />
          <span className="font-mono text-[11px] font-medium uppercase tracking-[0.14em] text-muted-foreground">
            AI-units footprint
          </span>
        </div>
        <div className="flex flex-col gap-1.5 font-mono text-[12px] text-foreground">
          <div className="flex items-baseline justify-between gap-3">
            <span className="text-muted-foreground">Per 6h block cap</span>
            <span className="font-medium">{REFERENCE_CEILING.units_per_block} units</span>
          </div>
          <div className="flex items-baseline justify-between gap-3">
            <span className="text-muted-foreground">Per week cap</span>
            <span className="font-medium">{REFERENCE_CEILING.units_per_week} units</span>
          </div>
        </div>
        <span className="font-mono text-[11px] text-muted-foreground">
          Subscription path — your provider's own quota is the cap. The Jinn gate
          does not meter this credential.
        </span>
      </div>
    );
  }

  // Paid harness whose model id is not in the cost table — surface
  // "unavailable" rather than a guess. Matches CostEstimatePanel's
  // unknown-model copy.
  if (projectedPerTask === null) {
    return (
      <div
        data-testid={`${testIdPrefix}-unknown`}
        className={cn(
          'flex flex-col gap-1 rounded-md border border-border bg-card',
          variant === 'card' ? 'px-4 py-3' : 'gap-1 px-2.5 py-2',
        )}
      >
        <span className="font-mono text-[11px] font-medium uppercase tracking-[0.14em] text-muted-foreground">
          AI-units footprint
        </span>
        <span className="font-mono text-[12px] text-muted-foreground">
          No pricing entry for this model id — footprint unavailable.
        </span>
      </div>
    );
  }

  // Estimated tasks per day assuming the daemon claims continuously up
  // to the per-block cap. With 4 blocks/day, max tasks/day = 4 * cap /
  // perTask, but most operators will be well under that — the daily
  // USD figure is just an informational scale, not an actual forecast.
  const perTaskUsd = (projectedPerTask / 100) * GPT_5_4_MINI_USD_PER_BLOCK;
  const tasksPerBlockAtCap = REFERENCE_CEILING.units_per_block / projectedPerTask;
  // Per-block USD at the cap; the per-day USD assumes 4 such blocks.
  const dailyUsdAtCap = perTaskUsd * tasksPerBlockAtCap * 4;
  const weeklyProjectedUnits = projectedPerTask * tasksPerBlockAtCap * 4 * 7;

  return (
    <div
      data-testid={`${testIdPrefix}-panel`}
      className={cn(
        'flex flex-col gap-2 rounded-md border border-border bg-card',
        variant === 'card' ? 'px-4 py-3.5' : 'gap-1 px-2.5 py-2',
      )}
    >
      <div className="flex items-center gap-2">
        <Diamond aria-hidden="true" className="size-3 shrink-0 text-primary" />
        <span className="font-mono text-[11px] font-medium uppercase tracking-[0.14em] text-muted-foreground">
          AI-units footprint
        </span>
      </div>
      <div className="flex flex-col gap-1.5 font-mono text-[12px] text-foreground">
        <div className="flex items-baseline justify-between gap-3">
          <span className="text-muted-foreground">Per 6h block, at cap</span>
          <span data-testid={`${testIdPrefix}-block`} className="font-medium">
            {formatUnits(projectedPerTask)} / {REFERENCE_CEILING.units_per_block} units / task
          </span>
        </div>
        <div className="flex items-baseline justify-between gap-3">
          <span className="text-muted-foreground">Per week, at cap</span>
          <span data-testid={`${testIdPrefix}-week`} className="font-medium">
            {formatUnits(weeklyProjectedUnits)} / {REFERENCE_CEILING.units_per_week} units
          </span>
        </div>
        <div className="flex items-baseline justify-between gap-3">
          <span className="text-muted-foreground">~ Daily cost at cap</span>
          <span data-testid={`${testIdPrefix}-daily-usd`} className="font-medium">
            ~${dailyUsdAtCap < 1 ? dailyUsdAtCap.toFixed(2) : dailyUsdAtCap.toFixed(1)}/day
          </span>
        </div>
      </div>
      <span className="font-mono text-[11px] text-muted-foreground">
        Node pauses claims for this credential when the 6h or 7d cap is reached, then auto-resumes.
      </span>
    </div>
  );
}
