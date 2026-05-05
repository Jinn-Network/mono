import { useState, type ReactNode } from 'react';

/**
 * Shared collapsed/expanded section pattern used across the Configuration
 * page. Head shows title + summary + optional meta chip; body renders only
 * when expanded. When `dirty` is supplied, a per-section save footer
 * surfaces with Cancel + Save changes — no global save button.
 */

export type SectionCardVariant = 'default' | 'danger';

export interface SectionCardProps {
  title: string;
  summary: string;
  metaChip?: { label: string; tone?: 'default' | 'live' | 'attention' | 'danger' };
  defaultExpanded?: boolean;
  variant?: SectionCardVariant;
  dirty?: {
    pendingSummary: string;
    saving?: boolean;
    error?: string;
    onSave: () => void;
    onCancel: () => void;
  };
  children?: ReactNode;
}

const TONE_COLORS: Record<NonNullable<NonNullable<SectionCardProps['metaChip']>['tone']>, { color: string; border: string }> = {
  default: { color: 'var(--fg-dim)', border: 'var(--border)' },
  live: { color: 'var(--vow-green)', border: 'var(--vow-green)' },
  attention: { color: 'var(--wane)', border: 'var(--wane)' },
  danger: { color: 'var(--break-red)', border: 'var(--break-red)' },
};

export function SectionCard({
  title,
  summary,
  metaChip,
  defaultExpanded = false,
  variant = 'default',
  dirty,
  children,
}: SectionCardProps): JSX.Element {
  const [expanded, setExpanded] = useState(defaultExpanded);
  const tone = TONE_COLORS[metaChip?.tone ?? 'default'];
  const borderColor = variant === 'danger' ? 'var(--break-red)' : 'var(--border)';
  return (
    <section
      style={{
        background: 'var(--bg-elevated)',
        border: `1px solid ${borderColor}`,
        borderRadius: '10px',
        overflow: 'hidden',
      }}
    >
      <button
        type="button"
        onClick={() => setExpanded((prev) => !prev)}
        style={{
          display: 'grid',
          gridTemplateColumns: '1fr auto auto',
          gap: '16px',
          alignItems: 'center',
          padding: '20px 24px',
          width: '100%',
          background: 'transparent',
          border: 'none',
          color: 'inherit',
          textAlign: 'left',
          cursor: 'pointer',
          fontFamily: "'JetBrains Mono', monospace",
        }}
      >
        <span>
          <span
            style={{
              display: 'block',
              fontSize: '17px',
              fontWeight: 500,
              color: variant === 'danger' ? 'var(--break-red)' : 'var(--fg)',
              letterSpacing: '-0.01em',
              marginBottom: '4px',
            }}
          >
            {title}
          </span>
          <span style={{ fontSize: '13px', color: 'var(--fg-muted)' }}>{summary}</span>
        </span>
        {metaChip && (
          <span
            style={{
              fontSize: '11px',
              fontWeight: 500,
              textTransform: 'uppercase',
              letterSpacing: '0.14em',
              color: tone.color,
              border: `1px solid ${tone.border}`,
              borderRadius: '4px',
              padding: '2px 8px',
            }}
          >
            {metaChip.label}
          </span>
        )}
        <span style={{ color: expanded ? 'var(--fg)' : 'var(--fg-dim)', fontSize: '14px', width: '16px', textAlign: 'right' }}>
          {expanded ? '▾' : '▸'}
        </span>
      </button>
      {expanded && (
        <div
          style={{
            borderTop: '1px solid var(--border)',
            padding: '24px',
            display: 'flex',
            flexDirection: 'column',
            gap: '14px',
          }}
        >
          {children}
          {dirty && (
            <div
              style={{
                display: 'flex',
                justifyContent: 'space-between',
                alignItems: 'center',
                paddingTop: '14px',
                marginTop: '4px',
                borderTop: '1px solid var(--border)',
                fontFamily: "'JetBrains Mono', monospace",
              }}
            >
              <span style={{ fontSize: '12px', color: dirty.error ? 'var(--break-red)' : 'var(--accent-sky)' }}>
                {dirty.error ?? (dirty.saving ? 'Saving…' : dirty.pendingSummary)}
              </span>
              <span style={{ display: 'flex', gap: '8px' }}>
                <button
                  type="button"
                  onClick={dirty.onCancel}
                  disabled={dirty.saving}
                  style={{
                    border: '1px solid var(--border)',
                    borderRadius: '6px',
                    padding: '10px 20px',
                    background: 'transparent',
                    color: 'var(--fg)',
                    fontFamily: "'JetBrains Mono', monospace",
                    fontSize: '14px',
                    cursor: dirty.saving ? 'wait' : 'pointer',
                  }}
                >
                  Cancel
                </button>
                <button
                  type="button"
                  onClick={dirty.onSave}
                  disabled={dirty.saving}
                  style={{
                    border: '1px solid var(--accent-sky)',
                    background: 'var(--accent-sky)',
                    color: 'var(--bg-sunken)',
                    borderRadius: '6px',
                    padding: '10px 20px',
                    fontFamily: "'JetBrains Mono', monospace",
                    fontSize: '14px',
                    cursor: dirty.saving ? 'wait' : 'pointer',
                  }}
                >
                  Save changes
                </button>
              </span>
            </div>
          )}
        </div>
      )}
    </section>
  );
}
