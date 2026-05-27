/**
 * GroupByDropdown — labeled dropdown reading "Group by: <dim> ▾".
 *
 * Inactive (value === 'none'): default border + fg-muted color.
 * Active (value !== 'none'): accent-sky border + accent-sky color.
 *
 * Stateless: parent owns the URL state via useGroupParam.
 */
import { useEffect, useRef, useState } from 'react';
import { GROUP_VALUES, type GroupValue } from '../lib/url-state';

interface Props {
  value: GroupValue;
  onChange: (v: GroupValue) => void;
}

export function GroupByDropdown({ value, onChange }: Props) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const active = value !== 'none';

  useEffect(() => {
    if (!open) return;
    function handleKey(e: KeyboardEvent) {
      if (e.key === 'Escape') setOpen(false);
    }
    function handleClickOutside(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener('keydown', handleKey);
    document.addEventListener('mousedown', handleClickOutside);
    return () => {
      document.removeEventListener('keydown', handleKey);
      document.removeEventListener('mousedown', handleClickOutside);
    };
  }, [open]);

  function pick(v: GroupValue) {
    onChange(v);
    setOpen(false);
  }

  const triggerColor = active ? 'var(--accent-sky)' : 'var(--fg-muted)';
  const triggerBorder = active ? 'var(--accent-sky)' : 'var(--border)';

  return (
    <div ref={ref} style={{ position: 'relative', display: 'inline-block' }}>
      <button
        type="button"
        data-active={active}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={`Group by: ${value}`}
        onClick={() => setOpen((p) => !p)}
        style={{
          display: 'inline-flex',
          alignItems: 'center',
          gap: 6,
          border: `1px solid ${triggerBorder}`,
          borderRadius: 'var(--radius-2)',
          padding: '4px 10px',
          fontFamily: 'var(--font-mono)',
          fontSize: 9,
          letterSpacing: '0.10em',
          textTransform: 'uppercase',
          color: triggerColor,
          background: 'var(--bg)',
          cursor: 'pointer',
        }}
      >
        Group by: {value} <span style={{ color: 'var(--fg-dim)' }}>▾</span>
      </button>
      {open ? (
        <div
          role="menu"
          style={{
            position: 'absolute',
            top: 'calc(100% + 4px)',
            right: 0,
            background: 'var(--bg-elevated)',
            border: '1px solid var(--border)',
            borderRadius: 'var(--radius-2)',
            padding: 4,
            minWidth: 140,
            zIndex: 10,
          }}
        >
          {GROUP_VALUES.map((v) => (
            <button
              key={v}
              type="button"
              role="menuitem"
              aria-label={v}
              onClick={() => pick(v)}
              style={{
                display: 'block',
                width: '100%',
                textAlign: 'left',
                padding: '4px 10px',
                fontFamily: 'var(--font-mono)',
                fontSize: 10,
                letterSpacing: '0.10em',
                textTransform: 'uppercase',
                color: v === value ? 'var(--accent-sky)' : 'var(--fg)',
                background: 'transparent',
                border: 'none',
                cursor: 'pointer',
                borderRadius: 'var(--radius-1)',
              }}
            >
              {v}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}
