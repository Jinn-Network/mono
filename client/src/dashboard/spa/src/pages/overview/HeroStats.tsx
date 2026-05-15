/**
 * Overview stat hero. Numbers are mono (data = doing, per the two-voices
 * rule); labels are ALL-CAPS-MONO eyebrows. The full live activity surface
 * lives on /operator; Overview keeps only a compact status tile.
 */
import type { LiveNowState } from './LiveNowBand.js';

export interface HeroStatsProps {
  tasksDelivered: number;
  jinnClaimable: string;
  gasBalanceEth: string;
  gasRunwayDays: number | string;
  statusLabel: string;
  statusState: LiveNowState;
  statusDot: string;
  activeAction: string | null;
  onClaim: () => void;
  onTopUp: () => void;
  onRestart: () => void;
}

function ActionButton({
  children,
  action,
  activeAction,
  onClick,
}: {
  children: string;
  action: string;
  activeAction: string | null;
  onClick: () => void;
}): JSX.Element {
  const busy = activeAction === action;
  const disabled = activeAction !== null;
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
  action,
}: {
  label: string;
  state: LiveNowState;
  dot: string;
  action: JSX.Element;
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
      {action}
    </div>
  );
}

export function HeroStats({
  tasksDelivered,
  jinnClaimable,
  gasBalanceEth,
  gasRunwayDays,
  statusLabel,
  statusState,
  statusDot,
  activeAction,
  onClaim,
  onTopUp,
  onRestart,
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
      <Stat
        label="JINN claimable"
        value={jinnClaimable}
        unit="JINN"
        action={(
          <ActionButton action="Claim JINN" activeAction={activeAction} onClick={onClaim}>
            Claim now
          </ActionButton>
        )}
      />
      <Stat
        label="Gas"
        value={gasBalanceEth}
        unit="ETH"
        sub={`${gasRunwayDays} days runway`}
        action={(
          <ActionButton action="Top up gas" activeAction={activeAction} onClick={onTopUp}>
            Top up
          </ActionButton>
        )}
      />
      <StatusStat
        label={statusLabel}
        state={statusState}
        dot={statusDot}
        action={(
          <ActionButton action="Restart node" activeAction={activeAction} onClick={onRestart}>
            Restart
          </ActionButton>
        )}
      />
    </div>
  );
}
