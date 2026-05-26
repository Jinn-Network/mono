/**
 * SegmentedControl — a row of buttons where exactly one is active.
 *
 * Lifted out of SolverNetView (commit 1992ac3f) so ExploreControls and other
 * views can reuse the chip-row pattern. No visual change from the previous
 * in-file definition.
 *
 * Design:
 *   - 1px var(--border) hairline outline, var(--radius-1) corners, overflow:hidden
 *   - Caps-mono 10px labels, 0.10em letter-spacing
 *   - Active option: bg-sunken background + fg text
 *   - Inactive: transparent background + fg-dim text
 *   - aria-pressed reflects active state for assistive tech.
 */

export interface SegmentedControlProps<T extends string> {
  options: { label: string; value: T }[];
  value: T;
  onChange: (v: T) => void;
}

export function SegmentedControl<T extends string>({
  options,
  value,
  onChange,
}: SegmentedControlProps<T>) {
  return (
    <div
      role="group"
      style={{
        display: 'inline-flex',
        border: '1px solid var(--border)',
        borderRadius: 'var(--radius-1)',
        overflow: 'hidden',
      }}
    >
      {options.map((opt) => {
        const active = opt.value === value;
        return (
          <button
            key={opt.value}
            type="button"
            aria-pressed={active}
            onClick={() => onChange(opt.value)}
            style={{
              fontFamily: 'var(--font-mono)',
              fontSize: 10,
              letterSpacing: '0.10em',
              textTransform: 'uppercase',
              padding: '5px 12px',
              border: 'none',
              borderRight: '1px solid var(--border)',
              cursor: 'pointer',
              background: active ? 'var(--bg-sunken)' : 'transparent',
              color: active ? 'var(--fg)' : 'var(--fg-dim)',
              transition:
                'background var(--dur-fast) var(--ease-linear), color var(--dur-fast) var(--ease-linear)',
            }}
          >
            {opt.label}
          </button>
        );
      })}
    </div>
  );
}
