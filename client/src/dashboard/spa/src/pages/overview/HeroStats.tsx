/**
 * Four-up stat hero on the Overview page. Numbers are mono (data = doing,
 * per the two-voices rule); labels are ALL-CAPS-MONO eyebrows.
 */
export interface HeroStatsProps {
  tasksDelivered: number;
  jinnEarned: string;
  gasRunwayDays: number | string;
  nodeStatus: string;
}

function Stat({ label, value, unit }: { label: string; value: string | number; unit?: string }): JSX.Element {
  return (
    <div
      style={{
        background: 'var(--bg-elevated)',
        border: '1px solid var(--border)',
        borderRadius: '10px',
        padding: '24px',
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
          fontSize: '28px',
          fontWeight: 500,
          color: 'var(--fg)',
          letterSpacing: '-0.01em',
        }}
      >
        {value}
        {unit && (
          <span
            style={{
              color: 'var(--fg-muted)',
              fontSize: '14px',
              marginLeft: '6px',
              fontFamily: "'JetBrains Mono', monospace",
            }}
          >
            {unit}
          </span>
        )}
      </span>
    </div>
  );
}

export function HeroStats({ tasksDelivered, jinnEarned, gasRunwayDays, nodeStatus }: HeroStatsProps): JSX.Element {
  return (
    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: '16px' }}>
      <Stat label="Tasks delivered" value={tasksDelivered} />
      <Stat label="JINN earned" value={jinnEarned} unit="JINN" />
      <Stat label="Gas runway" value={gasRunwayDays} unit="days" />
      <Stat label="Node status" value={nodeStatus} />
    </div>
  );
}
