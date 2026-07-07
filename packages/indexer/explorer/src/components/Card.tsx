/**
 * Card — shared panel/section container primitive.
 *
 * Design rules:
 *   - bg-elevated, 1px hairline border, radius-3 (10px), padding 24px
 *   - Hover: border-color transitions to border-strong
 *   - Optional `title` prop: caps-mono label + hairline divider below
 *   - Never nested (styling primitive only)
 *   - No emoji, no gradients, linear motion
 */

import type { ReactNode, CSSProperties } from 'react';

export interface CardProps {
  /** Optional caps-mono label shown at top with a hairline divider below */
  title?: string;
  children?: ReactNode;
  style?: CSSProperties;
  className?: string;
}

export function Card({ title, children, style, className }: CardProps) {
  return (
    <section
      className={className}
      style={{
        background: 'var(--bg-elevated)',
        border: '1px solid var(--border)',
        borderRadius: 'var(--radius-3)',
        padding: 24,
        transition: `border-color var(--dur-fast) var(--ease-linear)`,
        ...style,
      }}
      onMouseEnter={(e) => {
        (e.currentTarget as HTMLElement).style.borderColor = 'var(--border-strong)';
      }}
      onMouseLeave={(e) => {
        (e.currentTarget as HTMLElement).style.borderColor = 'var(--border)';
      }}
    >
      {title && (
        <>
          <div
            style={{
              fontFamily: 'var(--font-mono)',
              fontSize: 11,
              fontWeight: 500,
              letterSpacing: '0.14em',
              textTransform: 'uppercase',
              color: 'var(--fg-muted)',
              marginBottom: 16,
            }}
          >
            {title}
          </div>
          <hr
            style={{
              border: 0,
              borderTop: '1px solid var(--border)',
              margin: '0 0 20px 0',
            }}
          />
        </>
      )}
      {children}
    </section>
  );
}
