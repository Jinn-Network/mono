/**
 * StatusBar — thin footer strip showing indexer freshness.
 *
 * Design:
 *   - Fixed to the bottom of the viewport
 *   - bg-sunken, 1px hairline border-top
 *   - All text: caps-mono, fg-dim, 10px, letter-spacing 0.1em
 *   - "DEGRADED" chip uses --wane colour (warning lamplight)
 *   - "N BLOCKS BEHIND HEAD" shown when behindHead > 0; "WANE" chip when behindHead > 100
 *   - No emoji, no gradients
 */

import { block, int, relTime } from '../lib/format';

export interface StatusBarProps {
  lastIndexedBlock?: string;
  lastIndexedAt?: string;
  degraded?: boolean;
  enrichmentSharePct?: number;
  /** Number of blocks the indexer is behind the chain head; null when RPC unavailable. */
  behindHead?: number | null;
}

/** Threshold above which we show the wane chip warning the indexer is falling behind. */
const BEHIND_HEAD_WARN_THRESHOLD = 100;

export function StatusBar({
  lastIndexedBlock,
  lastIndexedAt,
  degraded,
  enrichmentSharePct,
  behindHead,
}: StatusBarProps) {
  const blockStr = block(lastIndexedBlock);
  const timeStr = relTime(lastIndexedAt);
  const isBehind = typeof behindHead === 'number' && behindHead > 0;
  const isWane = typeof behindHead === 'number' && behindHead > BEHIND_HEAD_WARN_THRESHOLD;

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
          {isBehind && (
            <>
              <span style={{ margin: '0 4px' }}>&middot;</span>
              <span
                aria-label={`${behindHead} blocks behind head`}
                style={{ color: isWane ? 'var(--wane)' : 'var(--fg-muted)' }}
              >
                ~{int(behindHead)} blocks behind head
              </span>
            </>
          )}
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
        {isWane && (
          <span
            aria-label="Indexer falling behind head"
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
            Wane
          </span>
        )}
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
