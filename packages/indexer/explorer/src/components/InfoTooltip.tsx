/**
 * InfoTooltip — click-to-toggle `?` glyph that reveals a popover body.
 *
 * Portal-rendered (issue #905): the open body lives directly under
 * `document.body` so an ancestor with `overflow: hidden` (rounded card,
 * scrollable strip, etc.) cannot clip it. Positioning uses `position: fixed`
 * coordinates derived from the trigger's `getBoundingClientRect()`, captured
 * on open.
 *
 * Trigger / dismiss pattern matches {@link AddFilterPopover}:
 *   - `mousedown` outside the trigger AND outside the portal body dismisses.
 *   - Clicking the trigger a second time toggles it shut.
 *
 * The `children` are the body content. `label` overrides the trigger's
 * aria-label (default: "More info").
 */
import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { createPortal } from 'react-dom';

interface Props {
  children: ReactNode;
  /** Custom aria-label for the trigger; defaults to "More info". */
  label?: string;
}

/** Viewport-relative coords for the open body. */
interface PortalPosition {
  top: number;
  left: number;
}

export function InfoTooltip({ children, label = 'More info' }: Props) {
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<PortalPosition | null>(null);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const bodyRef = useRef<HTMLSpanElement | null>(null);

  // Compute coordinates on open so the portal-mounted body anchors to the
  // trigger's viewport position. `useLayoutEffect` so the body never paints
  // at (0,0) before the measurement lands.
  useLayoutEffect(() => {
    if (!open) {
      setPos(null);
      return;
    }
    const trigger = triggerRef.current;
    if (!trigger) return;
    const rect = trigger.getBoundingClientRect();
    setPos({
      top: rect.bottom + 6,
      left: rect.left,
    });
  }, [open]);

  // Dismiss on mousedown outside both the trigger AND the portaled body.
  // The trigger itself toggles in its own onClick, so the trigger element
  // is allowed to be the mousedown target without dismissing.
  useEffect(() => {
    if (!open) return;
    function handler(e: MouseEvent) {
      const target = e.target as Node | null;
      if (!target) return;
      if (triggerRef.current?.contains(target)) return;
      if (bodyRef.current?.contains(target)) return;
      setOpen(false);
    }
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [open]);

  return (
    <span style={{ display: 'inline-flex', marginLeft: 6 }}>
      <button
        ref={triggerRef}
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
      {open &&
        pos !== null &&
        createPortal(
          <span
            ref={bodyRef}
            role="tooltip"
            style={{
              position: 'fixed',
              top: pos.top,
              left: pos.left,
              zIndex: 1000,
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
          </span>,
          document.body,
        )}
    </span>
  );
}
