/**
 * AddFilterPopover — two-step add-filter UI.
 *
 * Step 1: dimension picker (operator / harness / plugin / mode / model).
 * Step 2: value picker, listing the values that exist in availableValues[dim].
 * Selecting a value calls onSelect(dim, value) and parent dismisses.
 *
 * Escape and outside-click both dismiss via onDismiss.
 */
import { useEffect, useState } from 'react';
import { FILTER_DIMS, type FilterDim } from '../lib/url-state';

interface Props {
  availableValues: Partial<Record<FilterDim, string[]>>;
  onSelect: (dim: FilterDim, value: string) => void;
  onDismiss: () => void;
}

export function AddFilterPopover({ availableValues, onSelect, onDismiss }: Props) {
  const [step, setStep] = useState<'dim' | 'value'>('dim');
  const [pickedDim, setPickedDim] = useState<FilterDim | null>(null);

  useEffect(() => {
    function handleKey(e: KeyboardEvent) {
      if (e.key === 'Escape') onDismiss();
    }
    document.addEventListener('keydown', handleKey);
    return () => document.removeEventListener('keydown', handleKey);
  }, [onDismiss]);

  function pickDim(dim: FilterDim) {
    setPickedDim(dim);
    setStep('value');
  }

  function pickValue(value: string) {
    if (pickedDim) onSelect(pickedDim, value);
  }

  function goBack() {
    setStep('dim');
    setPickedDim(null);
  }

  return (
    <div
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
        <DimensionList onPick={pickDim} />
      ) : (
        <ValueList
          values={(pickedDim && availableValues[pickedDim]) || []}
          onPick={pickValue}
          onBack={goBack}
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
  onPick,
  onBack,
}: {
  values: string[];
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
      {values.length === 0 ? (
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
