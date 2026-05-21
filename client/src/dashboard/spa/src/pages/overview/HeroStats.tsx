/**
 * Overview stat hero. Numbers are mono (data = doing, per the two-voices
 * rule); labels are ALL-CAPS-MONO eyebrows. The full live activity surface
 * lives on /operator; Overview keeps only a compact status tile.
 *
 * Funds (gasBalanceEth, gasRunwayDays, onTopUp) and Rewards (jinnClaimable,
 * onClaim) were removed in Task 3.3 — those concerns now live in FundsCard
 * and RewardsCard, which Overview renders as peer cards.
 */
import { useState } from 'react';
import type { LiveNowState } from './liveNowState.js';

export interface HeroStatsProps {
  tasksDelivered: number;
  statusLabel: string;
  statusState: LiveNowState;
  statusDot: string;
  /**
   * Human-readable reason for the current status — `deriveLiveNow().line`.
   * Rendered as a small subdued line under the status label so the operator
   * sees *why* the node is in this state (e.g. the first error diagnostic's
   * message for ATTENTION, or "waiting for next task" when idle).
   */
  statusReason: string;
  activeAction: string | null;
  /** When true, the service has been evicted from the staking proxy. */
  evicted?: boolean;
  /** Service ID of the evicted service. Required when evicted=true to wire the Re-stake CTA. */
  evictedServiceId?: number | null;
  onRestart: () => void;
  /** Called when the operator clicks "Re-stake now". Should POST to /v1/setup/restake/:serviceId. */
  onRestake?: (serviceId: number) => Promise<void> | void;
}

function ActionButton({
  children,
  action,
  activeAction,
  onClick,
  forceDisabled,
}: {
  children: string;
  action: string;
  activeAction: string | null;
  onClick: () => void;
  forceDisabled?: boolean;
}): JSX.Element {
  const busy = activeAction === action;
  const disabled = activeAction !== null || (forceDisabled ?? false);
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      style={{
        alignSelf: 'flex-start',
        marginTop: '14px',
        background: 'transparent',
        border: '1px solid var(--accent-sky)',
        borderRadius: '6px',
        color: 'var(--accent-sky)',
        cursor: busy ? 'wait' : disabled ? 'not-allowed' : 'pointer',
        fontFamily: "'JetBrains Mono', monospace",
        fontSize: '11px',
        letterSpacing: '0.14em',
        opacity: disabled && !busy ? 0.55 : 1,
        padding: '8px 10px',
        textTransform: 'uppercase',
      }}
    >
      {busy ? 'Working...' : children}
    </button>
  );
}

function EvictionNotice({
  serviceId,
  onRestake,
}: {
  serviceId?: number | null;
  onRestake?: (serviceId: number) => Promise<void> | void;
}): JSX.Element {
  const [restaking, setRestaking] = useState(false);

  function handleRestake(): void {
    if (!serviceId || !onRestake || restaking) return;
    setRestaking(true);
    Promise.resolve(onRestake(serviceId)).finally(() => setRestaking(false));
  }

  return (
    <div style={{ marginTop: '10px' }}>
      <span
        style={{
          display: 'block',
          color: 'var(--fg-warning, #e8a028)',
          fontFamily: "'JetBrains Mono', monospace",
          fontSize: '11px',
          letterSpacing: '0.1em',
        }}
      >
        Service evicted — restoring liveness
      </span>
      {serviceId != null && onRestake && (
        <button
          type="button"
          data-testid="restake-button"
          onClick={handleRestake}
          disabled={restaking}
          style={{
            marginTop: '8px',
            background: 'transparent',
            border: '1px solid var(--fg-warning, #e8a028)',
            borderRadius: '6px',
            color: 'var(--fg-warning, #e8a028)',
            cursor: restaking ? 'wait' : 'pointer',
            fontFamily: "'JetBrains Mono', monospace",
            fontSize: '11px',
            letterSpacing: '0.14em',
            opacity: restaking ? 0.55 : 1,
            padding: '6px 10px',
            textTransform: 'uppercase',
          }}
        >
          {restaking ? 'Working...' : 'Re-stake now'}
        </button>
      )}
    </div>
  );
}

function Stat({
  label,
  value,
  unit,
  sub,
  action,
}: {
  label: string;
  value: string | number;
  unit?: string;
  sub?: string;
  action?: JSX.Element;
}): JSX.Element {
  return (
    <div
      style={{
        background: 'var(--bg-elevated)',
        border: '1px solid var(--border)',
        borderRadius: '10px',
        padding: '20px',
        minWidth: 0,
      }}
    >
      <span
        style={{
          fontFamily: "'JetBrains Mono', monospace",
          fontSize: '11px',
          fontWeight: 500,
          letterSpacing: '0.14em',
          textTransform: 'uppercase',
          color: 'var(--fg-muted)',
          display: 'block',
          marginBottom: '12px',
        }}
      >
        {label}
      </span>
      <span
        style={{
          fontFamily: "'JetBrains Mono', monospace",
          fontSize: '24px',
          fontWeight: 500,
          color: 'var(--fg)',
          letterSpacing: 0,
          display: 'block',
        }}
      >
        {value}
      </span>
      {unit && (
        <span
          style={{
            color: 'var(--fg-muted)',
            fontSize: '14px',
            marginTop: '4px',
            display: 'block',
            fontFamily: "'JetBrains Mono', monospace",
          }}
        >
          {unit}
        </span>
      )}
      {sub && (
        <span
          style={{
            color: 'var(--fg-muted)',
            fontSize: '12px',
            marginTop: '6px',
            display: 'block',
            fontFamily: "'JetBrains Mono', monospace",
          }}
        >
          {sub}
        </span>
      )}
      {action}
    </div>
  );
}

function StatusStat({
  label,
  state,
  dot,
  reason,
  action,
  evicted,
  evictedServiceId,
  onRestake,
}: {
  label: string;
  state: LiveNowState;
  dot: string;
  reason: string;
  action: JSX.Element;
  evicted?: boolean;
  evictedServiceId?: number | null;
  onRestake?: (serviceId: number) => Promise<void> | void;
}): JSX.Element {
  return (
    <div
      data-testid="overview-status-stat"
      data-state={state}
      style={{
        background: 'var(--bg-elevated)',
        border: '1px solid var(--border)',
        borderRadius: '10px',
        padding: '20px',
        minWidth: 0,
      }}
    >
      <span
        style={{
          fontFamily: "'JetBrains Mono', monospace",
          fontSize: '11px',
          fontWeight: 500,
          letterSpacing: '0.14em',
          textTransform: 'uppercase',
          color: 'var(--fg-muted)',
          display: 'block',
          marginBottom: '12px',
        }}
      >
        Status
      </span>
      <span
        style={{
          fontFamily: "'JetBrains Mono', monospace",
          fontSize: '18px',
          fontWeight: 500,
          color: 'var(--fg)',
          letterSpacing: 0,
          display: 'flex',
          alignItems: 'center',
          gap: '10px',
          minHeight: '29px',
        }}
      >
        <span aria-hidden="true" style={{ color: dot, fontSize: '16px', lineHeight: 1 }}>
          ●
        </span>
        {label}
      </span>
      {reason && (
        <span
          data-testid="overview-status-reason"
          style={{
            color: 'var(--fg-muted)',
            fontFamily: "'JetBrains Mono', monospace",
            fontSize: '12px',
            lineHeight: 1.4,
            marginTop: '6px',
            display: 'block',
            wordBreak: 'break-word',
          }}
        >
          {reason}
        </span>
      )}
      {evicted ? <EvictionNotice serviceId={evictedServiceId} onRestake={onRestake} /> : null}
      {action}
    </div>
  );
}

export function HeroStats({
  tasksDelivered,
  statusLabel,
  statusState,
  statusDot,
  statusReason,
  activeAction,
  evicted = false,
  evictedServiceId,
  onRestart,
  onRestake,
}: HeroStatsProps): JSX.Element {
  return (
    <div
      style={{
        display: 'grid',
        gridTemplateColumns: 'repeat(auto-fit, minmax(140px, 1fr))',
        gap: '16px',
      }}
    >
      <Stat label="Solutions delivered" value={tasksDelivered} />
      <StatusStat
        label={statusLabel}
        state={statusState}
        dot={statusDot}
        reason={statusReason}
        evicted={evicted}
        evictedServiceId={evictedServiceId}
        onRestake={onRestake}
        action={(
          <ActionButton action="Restart node" activeAction={activeAction} onClick={onRestart}>
            Restart
          </ActionButton>
        )}
      />
    </div>
  );
}
