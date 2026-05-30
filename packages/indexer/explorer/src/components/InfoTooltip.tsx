/**
 * InfoTooltip — click-to-toggle `?` glyph that reveals an inline popover.
 *
 * Mirrors the trigger / dismiss pattern of {@link AddFilterPopover}:
 *   - `mousedown` outside the popover root dismisses (via
 *     {@link useDismissOnOutsideClick}).
 *   - Clicking the trigger a second time toggles it shut.
 *   - No backdrop, no portal — it renders inline so callers can drop it next
 *     to a column header / KPI label without layout surgery.
 *
 * The `children` are the body content. `label` overrides the trigger's
 * aria-label (default: "More info").
 */
import { useRef, useState, type ReactNode } from 'react';
import { useDismissOnOutsideClick } from '../hooks/useDismissOnOutsideClick';

interface Props {
  children: ReactNode;
  /** Custom aria-label for the trigger; defaults to "More info". */
  label?: string;
}

export function InfoTooltip({ children, label = 'More info' }: Props) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLSpanElement | null>(null);

  useDismissOnOutsideClick(rootRef, () => setOpen(false));

  return (
    <span
      ref={rootRef}
      style={{ position: 'relative', display: 'inline-flex', marginLeft: 6 }}
    >
      <button
        type="button"
        aria-label={label}
        aria-expanded={open}
        onClick={() => setOpen((prev) => !prev)}
        style={{
          display: 'inline-flex',
          alignItems: 'center',
          justifyContent: 'center',
          width: 14,
          height: 14,
          padding: 0,
          fontFamily: 'var(--font-mono)',
          fontSize: 9,
          lineHeight: 1,
          color: 'var(--fg-dim)',
          background: 'transparent',
          border: '1px solid var(--border)',
          borderRadius: 'var(--radius-pill)',
          cursor: 'pointer',
        }}
      >
        ?
      </button>
      {open && (
        <span
          role="tooltip"
          style={{
            position: 'absolute',
            top: 'calc(100% + 6px)',
            left: 0,
            zIndex: 20,
            minWidth: 240,
            maxWidth: 320,
            padding: '10px 12px',
            background: 'var(--bg-elevated)',
            border: '1px solid var(--border)',
            borderRadius: 'var(--radius-2)',
            boxShadow: '0 12px 32px -8px rgba(0,0,0,0.5)',
            fontFamily: 'var(--font-mono)',
            fontSize: 11,
            lineHeight: 1.5,
            color: 'var(--fg-muted)',
            letterSpacing: '0.02em',
            textTransform: 'none',
          }}
        >
          {children}
        </span>
      )}
    </span>
  );
}
