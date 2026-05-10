import { Link } from 'wouter';

/**
 * Operator-side state for one *enabled* SolverNet on Overview. Distinct
 * from NetworkCard: NetworkCard is public counters; OperatorCard is "you"
 * — your active roles, your live state, and a deep-link into the per-net
 * config. The card renders one or both of "Solver" / "Evaluator" pills
 * based on the operator's current configuration.
 */
export type OperatorCardRole = 'solving' | 'evaluating';

export interface OperatorCardProps {
  name: string;
  /** Stable config key for the joined SolverNet, preferably its manifest CID. */
  configId?: string;
  /** Active operator roles. Empty array renders a placeholder rather than
   *  inventing a role — that situation indicates a misconfigured net. */
  roles: OperatorCardRole[];
  state: 'live' | 'available' | 'coming_soon';
  /** Operator-facing message describing what the node is waiting for / doing. */
  waitingMessage?: string;
}

function roleLabel(role: OperatorCardRole): string {
  return role === 'solving' ? 'Solver' : 'Evaluator';
}

export function OperatorCard({ name, configId, roles, state, waitingMessage }: OperatorCardProps): JSX.Element {
  const stateColor =
    state === 'live' ? 'var(--vow-green)' : state === 'available' ? 'var(--fg-muted)' : 'var(--fg-dim)';
  const configTarget = encodeURIComponent(configId ?? name);
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
        <span style={{ display: 'flex', alignItems: 'center', gap: '8px', color: 'var(--fg)', fontSize: '14px' }}>
          <span style={{ color: 'var(--fg-muted)' }}>{roles.length > 1 ? 'Roles' : 'Role'}</span>
          <span style={{ color: 'var(--fg-muted)' }}>·</span>
          {roles.length === 0 ? (
            <span style={{ color: 'var(--fg-dim)' }}>none</span>
          ) : (
            roles.map((role, idx) => (
              <span
                key={role}
                data-role={role}
                style={{
                  fontSize: '11px',
                  letterSpacing: '0.14em',
                  textTransform: 'uppercase',
                  color: 'var(--fg)',
                  border: '1px solid var(--border)',
                  borderRadius: '999px',
                  padding: '2px 10px',
                  marginLeft: idx === 0 ? 0 : '4px',
                }}
              >
                {roleLabel(role)}
              </span>
            ))
          )}
        </span>
        <Link
          href={`/operator#solvernets/${configTarget}`}
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
