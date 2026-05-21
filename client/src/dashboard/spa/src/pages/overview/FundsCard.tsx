import { useState } from 'react';

export interface FundsCardProps {
  /** Sum of ETH across master / agent / Safe, formatted as decimal string */
  totalEth: string;
  /** Estimated days of runway at current burn rate */
  runwayDays: number;
  /** Per-role ETH balances, formatted as decimal strings */
  perRole: {
    master: string;
    agent: string;
    safe: string;
  };
  /** ISO timestamp of last password rotation, or null if never rotated */
  lastPasswordRotationAt: string | null;
  onTopUp: () => void;
  onChangePassword: () => void;
}

export function FundsCard({
  totalEth,
  runwayDays,
  perRole,
  lastPasswordRotationAt,
  onTopUp,
  onChangePassword,
}: FundsCardProps): JSX.Element {
  const [open, setOpen] = useState(false);

  return (
    <article
      role="region"
      aria-label="Funds"
      style={{
        background: 'var(--bg-elevated)',
        border: '1px solid var(--border)',
        borderRadius: '10px',
        padding: '20px 24px',
        display: 'flex',
        flexDirection: 'column',
        gap: '12px',
        fontFamily: "'JetBrains Mono', monospace",
      }}
    >
      {/* Eyebrow */}
      <span
        style={{
          fontSize: '11px',
          fontWeight: 500,
          letterSpacing: '0.14em',
          textTransform: 'uppercase',
          color: 'var(--fg-muted)',
        }}
      >
        Funds
      </span>

      {/* Primary balance row */}
      <div style={{ display: 'flex', alignItems: 'baseline', gap: '8px', flexWrap: 'wrap' }}>
        <span
          style={{
            fontSize: '28px',
            fontWeight: 500,
            color: 'var(--fg)',
            fontFamily: "'JetBrains Mono', monospace",
            letterSpacing: '-0.02em',
          }}
        >
          {totalEth}
        </span>
        <span
          style={{
            fontSize: '13px',
            color: 'var(--fg-muted)',
            fontWeight: 500,
          }}
        >
          ETH
        </span>
        <span style={{ fontSize: '13px', color: 'var(--fg-dim)' }}>·</span>
        <span
          style={{
            fontSize: '13px',
            color: 'var(--fg-muted)',
          }}
        >
          {runwayDays}d runway
        </span>
      </div>

      {/* Per-role drill-down toggle */}
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
        style={{
          alignSelf: 'flex-start',
          fontSize: '10px',
          letterSpacing: '0.12em',
          textTransform: 'uppercase',
          fontFamily: "'JetBrains Mono', monospace",
          border: '1px solid var(--border)',
          color: 'var(--fg-muted)',
          background: 'transparent',
          borderRadius: '999px',
          padding: '2px 8px',
          cursor: 'pointer',
        }}
      >
        {open ? 'hide' : 'per role'}
      </button>

      {/* Per-role breakdown */}
      {open && (
        <dl
          style={{
            margin: 0,
            padding: '12px 14px',
            border: '1px solid var(--border)',
            borderRadius: '6px',
            background: 'var(--bg-sunken, rgba(0,0,0,0.15))',
            display: 'flex',
            flexDirection: 'column',
            gap: '8px',
          }}
        >
          {(
            [
              { key: 'master', label: 'Master', value: perRole.master },
              { key: 'agent', label: 'Agent', value: perRole.agent },
              { key: 'safe', label: 'Safe', value: perRole.safe },
            ] as const
          ).map(({ key, label, value }) => (
            <div
              key={key}
              style={{
                display: 'flex',
                justifyContent: 'space-between',
                alignItems: 'baseline',
                gap: '12px',
              }}
            >
              <dt
                style={{
                  fontSize: '11px',
                  letterSpacing: '0.12em',
                  textTransform: 'uppercase',
                  color: 'var(--fg-dim)',
                  margin: 0,
                }}
              >
                {label}
              </dt>
              <dd
                style={{
                  fontSize: '13px',
                  color: 'var(--fg)',
                  margin: 0,
                  fontFamily: "'JetBrains Mono', monospace",
                }}
              >
                {value}
              </dd>
            </div>
          ))}
        </dl>
      )}

      {/* Footer: last password cycle + actions */}
      <div
        style={{
          display: 'flex',
          flexDirection: 'column',
          gap: '10px',
          marginTop: '4px',
          paddingTop: '12px',
          borderTop: '1px solid var(--border)',
        }}
      >
        <span style={{ fontSize: '11px', color: 'var(--fg-dim)' }}>
          last password cycle:{' '}
          {lastPasswordRotationAt ? (
            <time dateTime={lastPasswordRotationAt} style={{ color: 'var(--fg-muted)' }}>
              {lastPasswordRotationAt}
            </time>
          ) : (
            <span style={{ color: 'var(--fg-muted)' }}>never</span>
          )}
        </span>

        <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap' }}>
          <button
            type="button"
            aria-label="Top up"
            onClick={onTopUp}
            style={{
              border: '1px solid var(--accent-sky)',
              color: 'var(--accent-sky)',
              background: 'transparent',
              borderRadius: '6px',
              padding: '6px 12px',
              fontFamily: "'JetBrains Mono', monospace",
              fontSize: '11px',
              letterSpacing: '0.1em',
              textTransform: 'uppercase',
              cursor: 'pointer',
            }}
          >
            Top up
          </button>
          <button
            type="button"
            aria-label="Change password"
            onClick={onChangePassword}
            style={{
              border: '1px solid var(--border)',
              color: 'var(--fg-muted)',
              background: 'transparent',
              borderRadius: '6px',
              padding: '6px 12px',
              fontFamily: "'JetBrains Mono', monospace",
              fontSize: '11px',
              letterSpacing: '0.1em',
              textTransform: 'uppercase',
              cursor: 'pointer',
            }}
          >
            Change password
          </button>
        </div>
      </div>
    </article>
  );
}
