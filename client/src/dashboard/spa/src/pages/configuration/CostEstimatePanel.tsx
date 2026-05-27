/**
 * Shared cost-estimate surface used by `JoinFlow` (operator catalog) and
 * `JoinedNetCard` (Settings). Billing path (`usesPaidApiKey`) comes from
 * daemon `GET /v1/status` `costSurface`; model pricing heuristics from
 * `client/src/harnesses/cost-estimates.ts`.
 *
 * Issue #331 (P0 tier). The component:
 *   - Renders nothing for subscription billing paths — callers see
 *     `decision.showEstimate === false` and the parent omits this panel.
 *     We still render a tiny "Included in subscription" reassurance row
 *     when `mode='inline'` so the operator gets explicit confirmation.
 *   - For paid-API-key paths, surfaces the per-task USD estimate and
 *     the heuristic that produced it.
 *   - When the estimate trips the configured high-cost threshold the
 *     confirmation gate ("I understand — I have a budget for this") must
 *     be rendered by the caller; this component exposes `data-cost-*`
 *     attributes so tests can assert the gate condition.
 */

import type { JSX } from 'react';
import { Diamond } from 'lucide-react';
import {
  decideCostSurface,
  DEFAULT_HIGH_COST_THRESHOLD_USD,
  formatUsd,
  type CostSurfaceDecision,
} from '../../../../../harnesses/cost-estimates.js';
import { cn } from '../../lib/utils.js';

export interface CostEstimatePanelProps {
  harness: string | undefined;
  modelId: string | undefined;
  /** Daemon-resolved billing path from `/v1/status` `costSurface`. */
  usesPaidApiKey: boolean;
  /** Override the gate threshold. Defaults to $1/task. */
  thresholdUsd?: number;
  /**
   * `'card'` (default) renders the panel inside its own card-style
   * container suitable for the JoinFlow's stacked layout. `'inline'`
   * renders a compact two-line variant for the JoinedNetCard edit form.
   */
  variant?: 'card' | 'inline';
  /** testid prefix — defaults to `cost-estimate`. */
  testIdPrefix?: string;
}

export function useCostSurfaceDecision(
  usesPaidApiKey: boolean,
  modelId: string | undefined,
  thresholdUsd: number = DEFAULT_HIGH_COST_THRESHOLD_USD,
): CostSurfaceDecision {
  return decideCostSurface(usesPaidApiKey, modelId, thresholdUsd);
}

export function CostEstimatePanel({
  harness: _harness,
  modelId,
  usesPaidApiKey,
  thresholdUsd = DEFAULT_HIGH_COST_THRESHOLD_USD,
  variant = 'card',
  testIdPrefix = 'cost-estimate',
}: CostEstimatePanelProps): JSX.Element | null {
  const decision = decideCostSurface(usesPaidApiKey, modelId, thresholdUsd);

  if (!decision.showEstimate) {
    return (
      <div
        data-testid={`${testIdPrefix}-subscription`}
        data-cost-mode="subscription"
        className={cn(
          'flex items-center gap-2.5 font-mono',
          variant === 'card'
            ? 'rounded-md border border-border bg-card px-3.5 py-2.5'
            : 'py-1.5',
        )}
      >
        <Diamond
          aria-hidden="true"
          className="size-3 shrink-0 text-primary"
        />
        <span className="text-[12px] text-muted-foreground">
          {decision.suppressedReason ?? 'Included in subscription, no per-task API cost.'}
        </span>
      </div>
    );
  }

  const estimate = decision.estimate;
  const usd = estimate?.usd ?? null;
  const isHighCost = decision.requiresConfirmation;

  return (
    <div
      data-testid={`${testIdPrefix}-panel`}
      data-cost-mode="paid-api"
      data-cost-usd={usd !== null ? usd.toFixed(4) : 'unknown'}
      data-cost-high-cost={isHighCost ? 'true' : 'false'}
      className={cn(
        'flex flex-col gap-2 rounded-md border bg-card',
        isHighCost ? 'border-destructive' : 'border-border',
        variant === 'card' ? 'px-4 py-3.5' : 'gap-1 px-2.5 py-2',
      )}
    >
      <div className="flex items-baseline justify-between gap-3">
        <span className="font-mono text-[11px] font-medium uppercase tracking-[0.14em] text-muted-foreground">
          Estimated cost per task
        </span>
        <span
          data-testid={`${testIdPrefix}-amount`}
          className={cn(
            'font-mono font-medium',
            variant === 'card' ? 'text-[18px]' : 'text-[14px]',
            isHighCost ? 'text-destructive' : 'text-foreground',
          )}
        >
          {usd !== null ? `~${formatUsd(usd)}` : 'unavailable'}
        </span>
      </div>
      {estimate && (
        <span
          data-testid={`${testIdPrefix}-heuristic`}
          className="font-mono text-[11px] text-muted-foreground"
        >
          Rough estimate — actual cost varies.
        </span>
      )}
      {usd === null && (
        <span
          data-testid={`${testIdPrefix}-unknown`}
          className="font-mono text-[11px] text-muted-foreground"
        >
          No pricing entry for this model id — confirm rates with your provider before joining.
        </span>
      )}
      {isHighCost && (
        <span
          data-testid={`${testIdPrefix}-warning`}
          className="font-mono text-[11px] text-destructive"
        >
          This model is above ${thresholdUsd.toFixed(2)}/task. You will be asked to confirm before joining.
        </span>
      )}
    </div>
  );
}
