/**
 * Corpus chips — the shared visual vocabulary for corpus items (#1406).
 *
 * Two small primitives reused by the Corpus tab (index + detail) and the
 * Network-view Corpus summary card (#1407):
 *   - CorpusTierChip — the verifiability tier as a pill (user-accepted /
 *     tests-passed / evaluator-verified). Colour-on-border only, never filled.
 *     evaluator-verified uses --gold-600 (muted lamplight, the same tone the
 *     StatusChip uses for 'frozen') so a table full of tier chips never
 *     competes with the surface's one --accent-gold hero (spec §3.5).
 *   - CorpusTagChip — a neutral tag/cluster label (square-ish --radius-1).
 *
 * Design rules: no emoji, no gradients, softened-brutalist radii.
 */

const TIER_COLOR: Record<string, string> = {
  'user-accepted': 'var(--accent)',
  'tests-passed': 'var(--vow-green)',
  'evaluator-verified': 'var(--gold-600)',
};

export interface CorpusTierChipProps {
  tier: string;
}

export function CorpusTierChip({ tier }: CorpusTierChipProps) {
  const color = TIER_COLOR[tier] ?? 'var(--fg-dim)';
  const label = tier || 'untiered';
  return (
    <span
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 6,
        color,
        border: '1px solid currentColor',
        borderRadius: 'var(--radius-pill)',
        padding: '2px 9px',
        fontSize: 'var(--text-xs)',
        letterSpacing: '0.14em',
        textTransform: 'uppercase',
        fontFamily: 'var(--font-mono)',
        fontWeight: 500,
        whiteSpace: 'nowrap',
      }}
    >
      <span
        aria-hidden="true"
        style={{
          width: 5,
          height: 5,
          borderRadius: 999,
          background: 'currentColor',
          flexShrink: 0,
        }}
      />
      {label}
    </span>
  );
}

export interface CorpusTagChipProps {
  children: React.ReactNode;
}

export function CorpusTagChip({ children }: CorpusTagChipProps) {
  return (
    <span
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        border: '1px solid var(--border)',
        borderRadius: 'var(--radius-1)',
        padding: '2px 7px',
        fontFamily: 'var(--font-mono)',
        fontSize: 10,
        letterSpacing: '0.1em',
        textTransform: 'uppercase',
        color: 'var(--fg-muted)',
        whiteSpace: 'nowrap',
      }}
    >
      {children}
    </span>
  );
}
