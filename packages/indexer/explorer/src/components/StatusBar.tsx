/**
 * StatusBar — thin footer strip showing indexer freshness.
 *
 * Design:
 *   - Fixed to the bottom of the viewport
 *   - bg-sunken, 1px hairline border-top
 *   - All text: caps-mono, fg-dim, 10px, letter-spacing 0.1em
 *   - "DEGRADED" chip uses --wane colour (warning lamplight)
 *   - No emoji, no gradients
 */

import { block, relTime } from '../lib/format';

export interface StatusBarProps {
  lastIndexedBlock?: string;
  lastIndexedAt?: string;
  degraded?: boolean;
  enrichmentSharePct?: number;
}

export function StatusBar({
  lastIndexedBlock,
  lastIndexedAt,
  degraded,
  enrichmentSharePct,
}: StatusBarProps) {
  const blockStr = block(lastIndexedBlock);
  const timeStr = relTime(lastIndexedAt);

  return (
    <footer
      style={{
        position: 'fixed',
        bottom: 0,
        left: 0,
        right: 0,
        borderTop: '1px solid var(--border)',
        background: 'var(--bg-sunken)',
        padding: '5px 28px',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        fontFamily: 'var(--font-mono)',
        fontSize: 10,
        letterSpacing: '0.1em',
        color: 'var(--fg-dim)',
        textTransform: 'uppercase',
        zIndex: 'var(--z-sticky)' as unknown as number,
        fontVariantNumeric: 'tabular-nums',
        fontFeatureSettings: '"tnum" 1',
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 24 }}>
        <span>
          Indexed
          <span style={{ margin: '0 4px' }}>&middot;</span>
          Block{' '}
          <span style={{ color: 'var(--fg)' }}>{blockStr}</span>
          <span style={{ margin: '0 4px' }}>&middot;</span>
          <span style={{ color: 'var(--fg)' }}>{timeStr} ago</span>
        </span>

        {enrichmentSharePct !== undefined && (
          <span>
            <span style={{ margin: '0 4px' }}>&middot;</span>
            <span style={{ color: 'var(--fg)' }}>
              {Math.round(enrichmentSharePct)}%
            </span>
            {' '}
            <span>enriched</span>
          </span>
        )}
      </div>

      <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
        {degraded && (
          <span
            aria-label="Discovery degraded"
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: 5,
              border: '1px solid var(--wane)',
              borderRadius: 'var(--radius-pill)',
              padding: '1px 8px',
              color: 'var(--wane)',
              fontSize: 9,
              letterSpacing: '0.12em',
            }}
          >
            Discovery: Degraded
          </span>
        )}
      </div>
    </footer>
  );
}
