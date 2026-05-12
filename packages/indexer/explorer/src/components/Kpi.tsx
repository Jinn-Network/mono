/**
 * Kpi — a single metric tile and a flex row of them.
 *
 * Design:
 *   - KPI: caps-mono label (~11px, var(--fg-muted)), big mono value (~24px),
 *     optional sub (small var(--fg-dim)), accent? → value in var(--accent-gold)
 *   - KpiRow: flex-wrap row with hairline vertical dividers between tiles
 *   - No emoji, no gradients, tabular-nums on value, linear motion
 */

import type { ReactNode, CSSProperties } from 'react';

export interface KpiProps {
  label: string;
  value: ReactNode;
  sub?: ReactNode;
  /** When true, renders the value in var(--accent-gold) */
  accent?: boolean;
  style?: CSSProperties;
}

export function Kpi({ label, value, sub, accent, style }: KpiProps) {
  return (
    <div
      style={{
        padding: '18px 20px',
        display: 'flex',
        flexDirection: 'column',
        gap: 6,
        minWidth: 0,
        ...style,
      }}
    >
      <div
        style={{
          fontFamily: 'var(--font-mono)',
          fontSize: 'var(--text-xs)',
          fontWeight: 500,
          letterSpacing: '0.14em',
          textTransform: 'uppercase',
          color: 'var(--fg-muted)',
          lineHeight: 1,
        }}
      >
        {label}
      </div>
      <div
        className="data"
        style={{
          fontFamily: 'var(--font-mono)',
          fontSize: 'var(--text-2xl)',
          lineHeight: 1,
          color: accent ? 'var(--accent-gold)' : 'var(--fg)',
          fontVariantNumeric: 'tabular-nums',
          fontFeatureSettings: '"tnum" 1, "zero" 1',
          wordBreak: 'break-all',
        }}
      >
        {value}
      </div>
      {sub !== undefined && (
        <div
          style={{
            fontFamily: 'var(--font-mono)',
            fontSize: 'var(--text-xs)',
            color: 'var(--fg-dim)',
            lineHeight: 1.4,
          }}
        >
          {sub}
        </div>
      )}
    </div>
  );
}

export interface KpiRowProps {
  children?: ReactNode;
  style?: CSSProperties;
}

export function KpiRow({ children, style }: KpiRowProps) {
  return (
    <div
      style={{
        display: 'flex',
        flexWrap: 'wrap',
        border: '1px solid var(--border)',
        borderRadius: 'var(--radius-3)',
        background: 'var(--bg-elevated)',
        overflow: 'hidden',
        ...style,
      }}
    >
      {/* Each Kpi child gets a left hairline except the first; staggered fade-up */}
      {Array.isArray(children)
        ? (children as ReactNode[]).map((child, i) => (
            <div
              key={i}
              className="kpi-animate"
              style={{
                flex: '1 1 140px',
                borderLeft: i === 0 ? 'none' : '1px solid var(--border)',
                minWidth: 0,
                animationDelay: `${i * 40}ms`,
              }}
            >
              {child}
            </div>
          ))
        : children}
    </div>
  );
}
