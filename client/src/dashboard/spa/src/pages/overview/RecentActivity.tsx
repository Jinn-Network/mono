import { useState } from 'react';

export interface ActivityEvent {
  id: string;
  ts: string;
  message: string;
  txHash?: string;
}

export interface RecentActivityProps {
  events: ActivityEvent[];
  liveBadge?: boolean;
}

/** Recent activity card on Overview. Shows the last 10 events; "View all"
 *  toggles a longer in-place list. A richer streaming feed is filed as a
 *  separate follow-up (live activity feed bd). */
export function RecentActivity({ events, liveBadge = true }: RecentActivityProps): JSX.Element {
  const [showAll, setShowAll] = useState(false);
  const visible = showAll ? events : events.slice(0, 10);
  return (
    <section
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
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <span style={{ fontSize: '11px', fontWeight: 500, letterSpacing: '0.14em', textTransform: 'uppercase', color: 'var(--fg-muted)' }}>
          Recent activity
        </span>
        {liveBadge && (
          <span style={{ fontSize: '11px', color: 'var(--vow-green)', display: 'flex', gap: '6px', alignItems: 'center' }}>
            <span style={{ width: '6px', height: '6px', borderRadius: '50%', background: 'var(--vow-green)' }} />
            live
          </span>
        )}
      </div>
      {visible.length === 0 ? (
        <span style={{ fontSize: '12px', color: 'var(--fg-muted)' }}>
          Quiet. Node running; no events to surface yet.
        </span>
      ) : (
        <ul style={{ listStyle: 'none', padding: 0, margin: 0, display: 'flex', flexDirection: 'column', gap: '8px' }}>
          {visible.map((e) => (
            <li key={e.id} style={{ display: 'grid', gridTemplateColumns: '64px 1fr 96px', gap: '16px', fontSize: '13px' }}>
              <span style={{ color: 'var(--fg-dim)' }}>{e.ts}</span>
              <span style={{ color: 'var(--fg)' }}>{e.message}</span>
              <span style={{ color: e.txHash ? 'var(--accent-sky)' : 'var(--fg-dim)', textAlign: 'right' }}>
                {e.txHash ? `${e.txHash.slice(0, 6)}…` : '—'}
              </span>
            </li>
          ))}
        </ul>
      )}
      {events.length > 10 && (
        <button
          type="button"
          onClick={() => setShowAll((s) => !s)}
          style={{
            alignSelf: 'flex-start',
            background: 'transparent',
            border: 'none',
            color: 'var(--accent-sky)',
            fontFamily: "'JetBrains Mono', monospace",
            fontSize: '11px',
            letterSpacing: '0.14em',
            textTransform: 'uppercase',
            cursor: 'pointer',
            padding: 0,
          }}
        >
          {showAll ? 'Hide' : 'View all'} →
        </button>
      )}
    </section>
  );
}
