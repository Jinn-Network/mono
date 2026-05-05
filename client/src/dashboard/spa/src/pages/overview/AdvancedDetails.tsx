import { useState } from 'react';

/** Collapsed disclosure at the end of Overview that holds power-user
 *  details (raw fleet state, full claim history, env provenance). Empty
 *  for now — content lifts in as we identify what genuinely belongs here
 *  vs in Configuration vs in a future Activity page. */
export function AdvancedDetails(): JSX.Element {
  const [open, setOpen] = useState(false);
  return (
    <section style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
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
          Reserved for future power-user details (raw fleet state, claim history, env provenance).
        </div>
      )}
    </section>
  );
}
