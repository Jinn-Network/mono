import { Link } from 'wouter';

/**
 * Gold-bordered band that surfaces "needs attention" state on Overview.
 * Single-line message + sky CTA that deep-links into the Operator
 * section that resolves the issue. Renders nothing when not active.
 *
 * The alert is the *one* gold element on the Overview page (gold-as-hint
 * rule); other affordances stay sky.
 */
export interface AlertBandProps {
  active?: boolean;
  lead: string;
  body: string;
  ctaLabel: string;
  ctaHref: string;
}

export function AlertBand({ active = true, lead, body, ctaLabel, ctaHref }: AlertBandProps): JSX.Element | null {
  if (!active) return null;
  return (
    <div
      style={{
        border: '1px solid var(--border-accent)',
        background: 'transparent',
        borderRadius: '10px',
        padding: '14px 24px',
        display: 'flex',
        justifyContent: 'space-between',
        alignItems: 'center',
        fontFamily: "'JetBrains Mono', monospace",
      }}
    >
      <span style={{ color: 'var(--fg)' }}>
        <span style={{ color: 'var(--accent-gold)', marginRight: '6px' }}>{lead}</span>
        {body}
      </span>
      <Link
        href={ctaHref}
        style={{
          fontSize: '11px',
          letterSpacing: '0.14em',
          textTransform: 'uppercase',
          color: 'var(--accent-sky)',
          textDecoration: 'none',
        }}
      >
        {ctaLabel} →
      </Link>
    </div>
  );
}
