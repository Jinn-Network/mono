/**
 * Public network counters for a SolverNet — same data for every operator
 * on the network. Renders even when this operator is not participating.
 * No role, no state pill, no CTA — those belong on OperatorCard. This card
 * is the surface that could one day be lifted into a public explorer page.
 *
 * The single "failed" count was split per jinn-mono-0t6p: operator
 * dashboards conflated on-chain settled failures (delivery landed but the
 * marketplace/verdict marked it Fail) with local engine errors (the run
 * never reached the marketplace — SkippableError, claim-time rejects,
 * runner crashes). The two are different metrics and surfacing them
 * separately keeps operator counters aligned with the public explorer's
 * fail count while still exposing the operator's local debugging signal.
 */
export interface NetworkCardProps {
  name: string;
  totals: {
    tasks: number;
    active: number;
    solutions: number;
    verdicts: number;
    /** On-chain settled failures: delivery tx landed and the run terminated FAILED. */
    settledFailed: number;
    /** Local engine errors: FAILED runs that never reached the marketplace. */
    localErrors: number;
  };
}

function Stat({ label, value, tone }: { label: string; value: number; tone?: 'warn' }): JSX.Element {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '4px', minWidth: 0 }}>
      <span
        style={{
          fontFamily: "'JetBrains Mono', monospace",
          fontSize: '11px',
          fontWeight: 500,
          letterSpacing: '0.14em',
          textTransform: 'uppercase',
          color: 'var(--fg-muted)',
        }}
      >
        {label}
      </span>
      <span
        style={{
          fontFamily: "'JetBrains Mono', monospace",
          fontSize: '20px',
          fontWeight: 500,
          color: tone === 'warn' ? 'var(--wane)' : 'var(--fg)',
        }}
      >
        {value}
      </span>
    </div>
  );
}

export function NetworkCard({ name, totals }: NetworkCardProps): JSX.Element {
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
      <span
        style={{
          fontSize: '11px',
          fontWeight: 500,
          letterSpacing: '0.14em',
          textTransform: 'uppercase',
          color: 'var(--fg-muted)',
        }}
      >
        Network · {name}
      </span>
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fit, minmax(72px, 1fr))',
          gap: '16px 24px',
        }}
      >
        <Stat label="tasks" value={totals.tasks} />
        <Stat label="active" value={totals.active} />
        <Stat label="solutions" value={totals.solutions} />
        <Stat label="verdicts" value={totals.verdicts} />
        <Stat
          label="settled fail"
          value={totals.settledFailed}
          tone={totals.settledFailed > 0 ? 'warn' : undefined}
        />
        <Stat
          label="local err"
          value={totals.localErrors}
          tone={totals.localErrors > 0 ? 'warn' : undefined}
        />
      </div>
    </section>
  );
}
