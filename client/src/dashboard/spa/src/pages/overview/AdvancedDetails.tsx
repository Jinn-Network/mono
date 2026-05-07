import { useState, type ReactNode } from 'react';

/** Collapsed disclosure at the end of Overview that holds power-user
 *  details: identity (agent ID, safe, services), harness status, and any
 *  other reference data that doesn't earn a default-open card. */
export function AdvancedDetails({ children }: { children?: ReactNode }): JSX.Element {
  const [open, setOpen] = useState(false);
  return (
    <section style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        style={{
          alignSelf: 'flex-start',
          background: 'transparent',
          border: 'none',
          color: 'var(--fg-dim)',
          fontFamily: "'JetBrains Mono', monospace",
          fontSize: '11px',
          fontWeight: 500,
          letterSpacing: '0.14em',
          textTransform: 'uppercase',
          cursor: 'pointer',
          padding: 0,
        }}
      >
        {open ? '▾' : '▸'} Advanced details
      </button>
      {open && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>
          {children ?? (
            <div
              style={{
                border: '1px solid var(--border)',
                borderRadius: '10px',
                padding: '20px 24px',
                background: 'var(--bg-elevated)',
                color: 'var(--fg-muted)',
                fontFamily: "'JetBrains Mono', monospace",
                fontSize: '12px',
              }}
            >
              No additional details available.
            </div>
          )}
        </div>
      )}
    </section>
  );
}
