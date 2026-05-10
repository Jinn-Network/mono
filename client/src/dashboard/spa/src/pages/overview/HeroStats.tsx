/**
 * Overview stat hero. Numbers are mono (data = doing, per the two-voices
 * rule); labels are ALL-CAPS-MONO eyebrows. The full live activity surface
 * lives on /operator; Overview keeps only a compact status tile.
 */
import type { LiveNowState } from './LiveNowBand.js';

export interface HeroStatsProps {
  tasksDelivered: number;
  jinnEarned: string;
  gasRunwayDays: number | string;
  statusLabel: string;
  statusState: LiveNowState;
  statusDot: string;
}

function Stat({ label, value, unit }: { label: string; value: string | number; unit?: string }): JSX.Element {
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
    </div>
  );
}

function StatusStat({ label, state, dot }: { label: string; state: LiveNowState; dot: string }): JSX.Element {
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
    </div>
  );
}

export function HeroStats({
  tasksDelivered,
  jinnEarned,
  gasRunwayDays,
  statusLabel,
  statusState,
  statusDot,
}: HeroStatsProps): JSX.Element {
  return (
    <div
      style={{
        display: 'grid',
        gridTemplateColumns: 'repeat(auto-fit, minmax(140px, 1fr))',
        gap: '16px',
      }}
    >
      <Stat label="Tasks delivered" value={tasksDelivered} />
      <Stat label="JINN earned" value={jinnEarned} unit="JINN" />
      <Stat label="Gas runway" value={gasRunwayDays} unit="days" />
      <StatusStat label={statusLabel} state={statusState} dot={statusDot} />
    </div>
  );
}
