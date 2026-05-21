import { Link } from 'wouter';

export interface OperatorPageProps {
  onRestartPending?: () => void;
}

export function OperatorPage(_props: OperatorPageProps = {}): JSX.Element {

  return (
    <div
      data-testid="operator-page"
      style={{ padding: '24px', display: 'flex', flexDirection: 'column', gap: '16px' }}
    >
      <section
        style={{
          background: 'var(--bg-elevated)',
          border: '1px solid var(--border)',
          borderRadius: '10px',
          padding: '16px 20px',
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          gap: '16px',
          fontFamily: "'JetBrains Mono', monospace",
        }}
      >
        <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
          <span
            style={{
              fontSize: '11px',
              fontWeight: 500,
              letterSpacing: '0.14em',
              textTransform: 'uppercase',
              color: 'var(--fg-muted)',
            }}
          >
            Launcher tools
          </span>
          <span style={{ color: 'var(--fg-muted)', fontSize: '12px' }}>
            Create or manage SolverNets you own.
          </span>
        </div>
        <Link
          href="/launcher"
          style={{
            color: 'var(--accent-sky)',
            fontSize: '11px',
            textDecoration: 'none',
            letterSpacing: '0.14em',
            textTransform: 'uppercase',
            whiteSpace: 'nowrap',
          }}
        >
          Open Launcher →
        </Link>
      </section>
    </div>
  );
}
