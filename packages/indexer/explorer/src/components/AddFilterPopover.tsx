/**
 * AddFilterPopover — two-step add-filter UI.
 *
 * Step 1: dimension picker (operator / harness / plugin / mode / model).
 * Step 2: value picker, listing the values for the picked dimension.
 *
 * Controlled component: the parent owns `pickedDim` so it can fire a lookup
 * slice fetch when the user picks a dim that isn't the current group (#687
 * bug 2 — cold-landing `+ filter` no longer dead-ends). The popover renders
 * the dim list at step 1 and either a loading state, an empty state, or the
 * value list at step 2, gated by the `values` and `loading` props.
 *
 * Escape and outside-click both dismiss via onDismiss.
 */
import { useEffect, useRef } from 'react';
import { FILTER_DIMS, type FilterDim } from '../lib/url-state';
import { useDismissOnOutsideClick } from '../hooks/useDismissOnOutsideClick';

interface Props {
  /** Currently-picked dimension, or null for step 1 (dim picker). */
  pickedDim: FilterDim | null;
  /** Called when the user picks a dim in step 1. */
  onPickDim: (dim: FilterDim) => void;
  /** Called when the user clicks Back from step 2 → step 1. */
  onBack: () => void;
  /** Values to render in step 2 for the picked dim. */
  values: string[];
  /** True while values are being fetched. */
  loading: boolean;
  /** Called when the user picks a value in step 2. */
  onSelect: (dim: FilterDim, value: string) => void;
  /** Called on Escape key or outside-click. */
  onDismiss: () => void;
}

export function AddFilterPopover({
  pickedDim,
  onPickDim,
  onBack,
  values,
  loading,
  onSelect,
  onDismiss,
}: Props) {
  const step: 'dim' | 'value' = pickedDim === null ? 'dim' : 'value';
  const rootRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    function handleKey(e: KeyboardEvent) {
      if (e.key === 'Escape') onDismiss();
    }
    document.addEventListener('keydown', handleKey);
    return () => document.removeEventListener('keydown', handleKey);
  }, [onDismiss]);

  useDismissOnOutsideClick(rootRef, onDismiss);

  function pickValue(value: string) {
    if (pickedDim) onSelect(pickedDim, value);
  }

  return (
    <div
      ref={rootRef}
      role="dialog"
      aria-label="Add filter"
      style={{
        background: 'var(--bg-elevated)',
        border: '1px solid var(--border)',
        borderRadius: 'var(--radius-2)',
        padding: 12,
        minWidth: 200,
        maxHeight: 320,
        overflow: 'auto',
        boxShadow: '0 12px 32px -8px rgba(0,0,0,0.5)',
      }}
    >
      <div
        style={{
          fontFamily: 'var(--font-mono)',
          fontSize: 9,
          letterSpacing: '0.14em',
          textTransform: 'uppercase',
          color: 'var(--fg-dim)',
          marginBottom: 8,
        }}
      >
        Add filter{step === 'value' && pickedDim ? ` · ${pickedDim}` : ''}
      </div>
      {step === 'dim' ? (
        <DimensionList onPick={onPickDim} />
      ) : (
        <ValueList
          values={values}
          loading={loading}
          onPick={pickValue}
          onBack={onBack}
        />
      )}
    </div>
  );
}

function DimensionList({ onPick }: { onPick: (d: FilterDim) => void }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
      {FILTER_DIMS.map((d) => (
        <button
          key={d}
          type="button"
          aria-label={d}
          onClick={() => onPick(d)}
          style={menuItemStyle}
        >
          {d}
        </button>
      ))}
    </div>
  );
}

function ValueList({
  values,
  loading,
  onPick,
  onBack,
}: {
  values: string[];
  loading: boolean;
  onPick: (v: string) => void;
  onBack: () => void;
}) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
      <button
        type="button"
        aria-label="Back"
        onClick={onBack}
        style={{ ...menuItemStyle, color: 'var(--fg-dim)' }}
      >
        ← Back
      </button>
      {loading ? (
        <div
          role="status"
          aria-label="Loading values"
          style={{
            padding: '8px 10px',
            fontFamily: 'var(--font-mono)',
            fontSize: 10,
            color: 'var(--fg-dim)',
          }}
        >
          Loading…
        </div>
      ) : values.length === 0 ? (
        <div
          style={{
            padding: '8px 10px',
            fontFamily: 'var(--font-mono)',
            fontSize: 10,
            color: 'var(--fg-dim)',
          }}
        >
          No values to filter by
        </div>
      ) : (
        values.map((v) => (
          <button
            key={v}
            type="button"
            aria-label={v}
            onClick={() => onPick(v)}
            style={menuItemStyle}
          >
            {v}
          </button>
        ))
      )}
    </div>
  );
}

const menuItemStyle: React.CSSProperties = {
  display: 'block',
  width: '100%',
  textAlign: 'left',
  padding: '4px 10px',
  fontFamily: 'var(--font-mono)',
  fontSize: 10,
  letterSpacing: '0.10em',
  textTransform: 'uppercase',
  color: 'var(--fg)',
  background: 'transparent',
  border: 'none',
  cursor: 'pointer',
  borderRadius: 'var(--radius-1)',
};
