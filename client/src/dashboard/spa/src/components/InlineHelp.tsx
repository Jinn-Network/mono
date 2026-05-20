import { useState } from 'react';

/**
 * Expandable inline help. A small "i" trigger sits next to a field label;
 * clicking it reveals a short decision-context panel below the label without
 * leaving the form (Issue #334 — operators were choosing roles / harnesses /
 * plug-ins with no trade-off context).
 *
 * The panel carries the *short* answer. The full long-form copy lives in
 * `client/docs/operator/join-form-context.md`; `docHref` points the operator
 * there when they want the complete picture.
 */
export interface InlineHelpProps {
  /** Accessible label for the trigger, e.g. "Roles help". */
  label: string;
  /** Short decision-context copy shown in the expandable panel. */
  children: React.ReactNode;
  /** Optional link to the long-form doc section. */
  docHref?: string;
  /** Visible text for the doc link. Defaults to "Read more". */
  docLabel?: string;
}

export function InlineHelp({
  label,
  children,
  docHref,
  docLabel = 'Read more',
}: InlineHelpProps): JSX.Element {
  const [open, setOpen] = useState(false);

  return (
    <span style={{ display: 'inline-flex', flexDirection: 'column', gap: '6px' }}>
      <button
        type="button"
        data-testid="inline-help-trigger"
        aria-label={label}
        aria-expanded={open}
        onClick={() => setOpen((prev) => !prev)}
        style={{
          width: '14px',
          height: '14px',
          lineHeight: '12px',
          padding: 0,
          display: 'inline-flex',
          alignItems: 'center',
          justifyContent: 'center',
          fontFamily: "'JetBrains Mono', monospace",
          fontSize: '10px',
          fontWeight: 600,
          fontStyle: 'italic',
          color: 'var(--fg-muted)',
          background: 'var(--bg-elevated)',
          border: '1px solid var(--fg-muted)',
          borderRadius: 'var(--radius-2)',
          cursor: 'pointer',
        }}
      >
        i
      </button>
      {open && (
        <span
          data-testid="inline-help-panel"
          role="note"
          style={{
            display: 'block',
            background: 'var(--bg-elevated)',
            border: '1px solid var(--border)',
            borderRadius: 'var(--radius-2)',
            padding: '10px 12px',
            fontFamily: "'JetBrains Mono', monospace",
            fontSize: '11px',
            lineHeight: 1.6,
            fontWeight: 400,
            letterSpacing: 'normal',
            textTransform: 'none',
            // `pre-line` collapses runs of spaces but keeps newlines, so help
            // copy can use blank lines (`\n\n`) to break dense paragraphs
            // into short, scannable chunks (#328 inline-help polish).
            whiteSpace: 'pre-line',
            color: 'var(--fg-muted)',
            maxWidth: '420px',
          }}
        >
          {children}
          {docHref && (
            <>
              {' '}
              <a
                data-testid="inline-help-doc-link"
                href={docHref}
                target="_blank"
                rel="noreferrer"
                style={{ color: 'var(--accent-sky)' }}
              >
                {docLabel}
              </a>
            </>
          )}
        </span>
      )}
    </span>
  );
}
