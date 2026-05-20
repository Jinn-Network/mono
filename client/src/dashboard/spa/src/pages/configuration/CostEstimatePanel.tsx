/**
 * Shared cost-estimate surface used by `JoinFlow` (operator catalog) and
 * `JoinedNetCard` (Settings). Reads the harness/model billing model from
 * `client/src/harnesses/cost-estimates.ts`.
 *
 * Issue #331 (P0 tier). The component:
 *   - Renders nothing for subscription harnesses (Claude Code, Codex) —
 *     callers see `decision.showEstimate === false` and the parent omits
 *     this panel. We still render a tiny "Included in subscription"
 *     reassurance row when `mode='inline'` so the operator gets explicit
 *     confirmation instead of an absent UI.
 *   - For paid-API-key harnesses, surfaces the per-task USD estimate and
 *     the heuristic that produced it.
 *   - When the estimate trips the configured high-cost threshold the
 *     confirmation gate ("I understand — I have a budget for this") must
 *     be rendered by the caller; this component exposes `data-cost-*`
 *     attributes so tests can assert the gate condition.
 */

import type { JSX } from 'react';
import {
  decideCostSurface,
  DEFAULT_HIGH_COST_THRESHOLD_USD,
  formatUsd,
  type CostSurfaceDecision,
} from '../../../../../harnesses/cost-estimates.js';

export interface CostEstimatePanelProps {
  harness: string | undefined;
  modelId: string | undefined;
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
  harness: string | undefined,
  modelId: string | undefined,
  thresholdUsd: number = DEFAULT_HIGH_COST_THRESHOLD_USD,
): CostSurfaceDecision {
  return decideCostSurface(harness, modelId, thresholdUsd);
}

export function CostEstimatePanel({
  harness,
  modelId,
  thresholdUsd = DEFAULT_HIGH_COST_THRESHOLD_USD,
  variant = 'card',
  testIdPrefix = 'cost-estimate',
}: CostEstimatePanelProps): JSX.Element | null {
  const decision = decideCostSurface(harness, modelId, thresholdUsd);

  if (!decision.showEstimate) {
    // Subscription harness — render the explicit reassurance row so the
    // operator gets confirmation that there is no per-task API cost.
    return (
      <div
        data-testid={`${testIdPrefix}-subscription`}
        data-cost-mode="subscription"
        style={variant === 'card' ? subscriptionCardStyle : subscriptionInlineStyle}
      >
        <span style={iconStyle} aria-hidden="true">
          ◆
        </span>
        <span style={subscriptionTextStyle}>
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
      style={variant === 'card' ? paidCardStyle(isHighCost) : paidInlineStyle(isHighCost)}
    >
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: '12px' }}>
        <span style={labelStyle}>Estimated cost per task</span>
        <span
          data-testid={`${testIdPrefix}-amount`}
          style={{
            fontFamily: "'JetBrains Mono', monospace",
            fontSize: variant === 'card' ? '18px' : '14px',
            fontWeight: 500,
            color: isHighCost ? 'var(--break-red)' : 'var(--fg)',
          }}
        >
          {usd !== null ? `~${formatUsd(usd)}` : 'unavailable'}
        </span>
      </div>
      {estimate && (
        <span
          data-testid={`${testIdPrefix}-heuristic`}
          style={{
            fontFamily: "'JetBrains Mono', monospace",
            fontSize: '11px',
            color: 'var(--fg-muted)',
          }}
        >
          Rough estimate — actual cost varies.
        </span>
      )}
      {usd === null && (
        <span
          data-testid={`${testIdPrefix}-unknown`}
          style={{
            fontFamily: "'JetBrains Mono', monospace",
            fontSize: '11px',
            color: 'var(--fg-muted)',
          }}
        >
          No pricing entry for this model id — confirm rates with your provider before joining.
        </span>
      )}
      {isHighCost && (
        <span
          data-testid={`${testIdPrefix}-warning`}
          style={{
            fontFamily: "'JetBrains Mono', monospace",
            fontSize: '11px',
            color: 'var(--break-red)',
          }}
        >
          This model is above ${thresholdUsd.toFixed(2)}/task. You will be asked to confirm before joining.
        </span>
      )}
    </div>
  );
}

const labelStyle: React.CSSProperties = {
  fontFamily: "'JetBrains Mono', monospace",
  fontSize: '11px',
  fontWeight: 500,
  letterSpacing: '0.14em',
  textTransform: 'uppercase',
  color: 'var(--fg-muted)',
};

const iconStyle: React.CSSProperties = {
  color: 'var(--accent-sky)',
  fontSize: '12px',
};

const subscriptionTextStyle: React.CSSProperties = {
  fontFamily: "'JetBrains Mono', monospace",
  fontSize: '12px',
  color: 'var(--fg-muted)',
};

const subscriptionCardStyle: React.CSSProperties = {
  background: 'var(--bg-elevated)',
  border: '1px solid var(--border)',
  borderRadius: 'var(--radius-2)',
  padding: '10px 14px',
  display: 'flex',
  alignItems: 'center',
  gap: '10px',
};

const subscriptionInlineStyle: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: '8px',
  padding: '6px 0',
};

function paidCardStyle(highCost: boolean): React.CSSProperties {
  return {
    background: 'var(--bg-elevated)',
    border: `1px solid ${highCost ? 'var(--break-red)' : 'var(--border)'}`,
    borderRadius: 'var(--radius-2)',
    padding: '14px 16px',
    display: 'flex',
    flexDirection: 'column',
    gap: '8px',
  };
}

function paidInlineStyle(highCost: boolean): React.CSSProperties {
  return {
    border: `1px solid ${highCost ? 'var(--break-red)' : 'var(--border)'}`,
    borderRadius: 'var(--radius-2)',
    padding: '8px 10px',
    display: 'flex',
    flexDirection: 'column',
    gap: '4px',
  };
}
