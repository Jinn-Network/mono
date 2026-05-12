/**
 * HBars — horizontal bar chart for composition data.
 *
 * Design:
 *   - Flex-div rows (no SVG overhead needed)
 *   - First bar: var(--accent) fill @ 0.18 opacity + full border
 *   - Rest: var(--fg-dim) fill @ 0.10 opacity + border
 *   - Label left (mono 12px), value + pct right
 *   - Hairline divider between rows
 *   - No gradients, no glow
 */

import { pct, int } from '../lib/format';

export interface HBarsEntry {
  label: string;
  value: number;
  share: number;
}

export interface HBarsProps {
  data: HBarsEntry[];
  title?: string;
}

export function HBars({ data, title }: HBarsProps) {
  if (!data || data.length === 0) {
    return (
      <div
        style={{
          fontFamily: 'var(--font-mono)',
          fontSize: 'var(--text-xs)',
          color: 'var(--fg-dim)',
          padding: '8px 0',
        }}
      >
        No data
      </div>
    );
  }

  return (
    <div>
      {title && (
        <div
          style={{
            fontFamily: 'var(--font-mono)',
            fontSize: 'var(--text-xs)',
            fontWeight: 500,
            letterSpacing: '0.14em',
            textTransform: 'uppercase',
            color: 'var(--fg-muted)',
            marginBottom: 10,
          }}
        >
          {title}
        </div>
      )}
      <div>
        {data.map((entry, i) => {
          const isFirst = i === 0;
          const barColor = isFirst
            ? 'rgba(122,167,220,0.18)' // --accent sky, low opacity
            : 'rgba(125,139,163,0.10)'; // --fg-dim, low opacity
          const barBorderColor = isFirst
            ? 'rgba(122,167,220,0.55)'
            : 'rgba(125,139,163,0.30)';

          return (
            <div
              key={entry.label}
              style={{
                borderTop: i === 0 ? 'none' : '1px solid var(--border)',
                padding: '8px 0',
              }}
            >
              {/* Label row */}
              <div
                style={{
                  display: 'flex',
                  justifyContent: 'space-between',
                  alignItems: 'center',
                  marginBottom: 5,
                  gap: 8,
                }}
              >
                <span
                  style={{
                    fontFamily: 'var(--font-mono)',
                    fontSize: 12,
                    color: isFirst ? 'var(--fg)' : 'var(--fg-muted)',
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    whiteSpace: 'nowrap',
                    minWidth: 0,
                  }}
                >
                  {entry.label}
                </span>
                <span
                  className="data"
                  style={{
                    fontFamily: 'var(--font-mono)',
                    fontSize: 11,
                    color: 'var(--fg-muted)',
                    flexShrink: 0,
                    fontVariantNumeric: 'tabular-nums',
                  }}
                >
                  {int(entry.value)}
                  <span
                    style={{ color: 'var(--fg-dim)', marginLeft: 6 }}
                  >
                    {pct(entry.share)}
                  </span>
                </span>
              </div>
              {/* Bar */}
              <div
                style={{
                  height: 6,
                  background: 'var(--bg-sunken)',
                  border: '1px solid var(--border)',
                  borderRadius: 'var(--radius-1)',
                  overflow: 'hidden',
                }}
              >
                <div
                  style={{
                    height: '100%',
                    width: `${Math.max(entry.share * 100, 1)}%`,
                    background: barColor,
                    border: `1px solid ${barBorderColor}`,
                    borderRadius: 'var(--radius-1)',
                    transition: `width var(--dur-slow) var(--ease-linear)`,
                  }}
                />
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
