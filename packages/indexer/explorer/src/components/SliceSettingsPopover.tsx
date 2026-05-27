/**
 * SliceSettingsPopover — content of the ⚙ popover.
 *
 * Two items only:
 *   - Include raw data — toggle. When on, ?include=raw and surface marked.
 *   - Reset to default — action. Clears all slice URL state.
 *
 * Anchor/positioning handled by the parent. Dismissal: Escape key + click
 * outside the panel (#687 bug 3).
 */
import { useEffect, useRef } from 'react';
import { useDismissOnOutsideClick } from '../hooks/useDismissOnOutsideClick';

interface Props {
  includeRaw: boolean;
  onIncludeRawChange: (v: boolean) => void;
  onReset: () => void;
  onDismiss: () => void;
}

export function SliceSettingsPopover({
  includeRaw,
  onIncludeRawChange,
  onReset,
  onDismiss,
}: Props) {
  const rootRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    function handleKey(e: KeyboardEvent) {
      if (e.key === 'Escape') onDismiss();
    }
    document.addEventListener('keydown', handleKey);
    return () => document.removeEventListener('keydown', handleKey);
  }, [onDismiss]);
  useDismissOnOutsideClick(rootRef, onDismiss);
  return (
    <div
      ref={rootRef}
      role="dialog"
      aria-label="Slice settings"
      style={{
        background: 'var(--bg-elevated)',
        border: '1px solid var(--border)',
        borderRadius: 'var(--radius-2)',
        padding: 10,
        minWidth: 200,
        boxShadow: '0 12px 32px -8px rgba(0,0,0,0.5)',
      }}
    >
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: 12,
          padding: '4px 6px',
        }}
      >
        <span
          style={{
            fontFamily: 'var(--font-mono)',
            fontSize: 10,
            letterSpacing: '0.06em',
            color: 'var(--fg)',
          }}
        >
          Include raw data
        </span>
        <button
          type="button"
          role="switch"
          aria-label="Include raw data"
          aria-checked={includeRaw}
          onClick={() => onIncludeRawChange(!includeRaw)}
          style={{
            width: 32,
            height: 18,
            border: `1px solid ${includeRaw ? 'var(--wane)' : 'var(--border)'}`,
            borderRadius: 999,
            background: includeRaw ? 'var(--wane)' : 'transparent',
            position: 'relative',
            cursor: 'pointer',
          }}
        >
          <span
            style={{
              position: 'absolute',
              top: 1,
              left: includeRaw ? 15 : 1,
              width: 14,
              height: 14,
              borderRadius: 999,
              background: includeRaw ? 'var(--bg)' : 'var(--fg-dim)',
              transition: 'left 80ms linear',
            }}
          />
        </button>
      </div>
      <div
        style={{
          height: 1,
          background: 'var(--border)',
          margin: '6px 0',
        }}
      />
      <button
        type="button"
        aria-label="Reset to default"
        onClick={onReset}
        style={{
          display: 'block',
          width: '100%',
          textAlign: 'left',
          padding: '4px 6px',
          fontFamily: 'var(--font-mono)',
          fontSize: 10,
          letterSpacing: '0.06em',
          color: 'var(--fg)',
          background: 'transparent',
          border: 'none',
          cursor: 'pointer',
          borderRadius: 'var(--radius-1)',
        }}
      >
        Reset to default
      </button>
    </div>
  );
}
