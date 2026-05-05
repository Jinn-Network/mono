import { Link } from 'wouter';

/**
 * Operator-side state for one *enabled* SolverNet on Overview. Distinct
 * from NetworkCard: NetworkCard is public counters; OperatorCard is "you"
 * — your role, your live state, and a deep-link into the per-net config.
 */
export interface OperatorCardProps {
  name: string;
  role: 'solving' | 'evaluating';
  state: 'live' | 'available' | 'coming_soon';
  /** Operator-facing message describing what the node is waiting for / doing. */
  waitingMessage?: string;
}

export function OperatorCard({ name, role, state, waitingMessage }: OperatorCardProps): JSX.Element {
  const stateColor =
    state === 'live' ? 'var(--vow-green)' : state === 'available' ? 'var(--fg-muted)' : 'var(--fg-dim)';
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
        <span
          style={{
            fontSize: '11px',
            fontWeight: 500,
            letterSpacing: '0.14em',
            textTransform: 'uppercase',
            color: 'var(--fg-muted)',
          }}
        >
          Your {name}
        </span>
        <span
          style={{
            fontSize: '11px',
            color: stateColor,
            textTransform: 'uppercase',
            letterSpacing: '0.14em',
          }}
        >
          {state.replace('_', ' ')}
        </span>
      </div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '16px' }}>
        <span style={{ color: 'var(--fg)', fontSize: '14px' }}>
          Role <span style={{ color: 'var(--fg-muted)' }}>·</span> {role}
        </span>
        <Link
          href={`/configuration#solvernets/${name}`}
          style={{
            color: 'var(--accent-sky)',
            fontSize: '11px',
            textDecoration: 'none',
            letterSpacing: '0.14em',
            textTransform: 'uppercase',
          }}
        >
          Configure →
        </Link>
      </div>
      {waitingMessage && (
        <span style={{ color: 'var(--fg-muted)', fontSize: '12px' }}>{waitingMessage}</span>
      )}
    </section>
  );
}
