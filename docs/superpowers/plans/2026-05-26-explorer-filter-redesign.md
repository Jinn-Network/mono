# Explorer Filter UX Redesign Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace `SolverNetView`'s five-section filter control card with a progressive-disclosure surface (Plausible/Linear-shaped): filter chips appear only when active, group-by lives as a separate dropdown, hover hints expose click-to-filter on chart legend + leaderboard rows.

**Architecture:** Five new small presentational components (`FilterChipStrip`, `GroupByDropdown`, `PersistentControlsRow`, `AddFilterPopover`, `SliceSettingsPopover`) replace the existing `ExploreControls` card. Existing `Leaderboard` and `LearningCurve` components gain hover affordances. `SolverNetView` orchestrates URL state and slot composition. Two known bugs (degenerate filter+group rendering as "No data yet"; wrong KPI hero when grouped) are fixed inline.

**Tech Stack:** TypeScript, React 18, wouter v3, Vitest, @testing-library/react, Playwright (e2e). All UI under `packages/indexer/explorer/src/`.

**Spec:** [`spec/2026-05-26-explorer-filter-redesign.md`](../../../spec/2026-05-26-explorer-filter-redesign.md).

---

## File Structure

**Create:**
- `packages/indexer/explorer/src/components/GroupByDropdown.tsx` — labeled dropdown `Group by: <dim> ▾`. Props: `value: GroupValue`, `onChange: (v: GroupValue) => void`. Stateless.
- `packages/indexer/explorer/src/components/GroupByDropdown.test.tsx`
- `packages/indexer/explorer/src/components/FilterChipStrip.tsx` — renders chips when ≥1 filter is active. Props: `filters: FilterMap`, `onRemove: (dim, value) => void`, `onAddFilter: () => void`. Returns `null` when filters empty.
- `packages/indexer/explorer/src/components/FilterChipStrip.test.tsx`
- `packages/indexer/explorer/src/components/AddFilterPopover.tsx` — two-step dimension → value picker. Props: `availableValues: Partial<Record<FilterDim, string[]>>`, `onSelect: (dim, value) => void`, `onDismiss: () => void`, `anchorRect: DOMRect | null`.
- `packages/indexer/explorer/src/components/AddFilterPopover.test.tsx`
- `packages/indexer/explorer/src/components/SliceSettingsPopover.tsx` — `⚙` popover content. Props: `includeRaw: boolean`, `onIncludeRawChange: (v: boolean) => void`, `onReset: () => void`.
- `packages/indexer/explorer/src/components/SliceSettingsPopover.test.tsx`
- `packages/indexer/explorer/src/components/PersistentControlsRow.tsx` — right-aligned row with `+ filter` chip + `GroupByDropdown`. Used when no filters are active. Props mirror the inner components.
- `packages/indexer/explorer/src/components/PersistentControlsRow.test.tsx`

**Modify:**
- `packages/indexer/explorer/src/views/SolverNetView.tsx` — replace `<ExploreControls />` block with the new component composition; absorb bug fixes 6.1 and 6.2.
- `packages/indexer/explorer/src/views/SolverNetView.test.tsx` — update assertions for the new layout; add cases for the two bug fixes.
- `packages/indexer/explorer/src/components/Leaderboard.tsx` — add `→ filter to this` hover hint after the operator address.
- `packages/indexer/explorer/src/components/Leaderboard.test.tsx` — assert hover hint renders.
- `packages/indexer/explorer/src/components/LearningCurve.tsx` — add `→ filter to this` hover hint after the legend label when `onLegendClick` is supplied.
- `packages/indexer/explorer/src/components/LearningCurve.test.tsx` — assert hover hint renders.
- `packages/indexer/explorer/test/e2e/solvernet-explore.e2e.test.ts` — extend with cold-landing → add-filter → remove flow.

**Delete:**
- `packages/indexer/explorer/src/components/ExploreControls.tsx`
- `packages/indexer/explorer/src/components/ExploreControls.test.tsx`

**Do not touch:**
- `packages/indexer/explorer/src/lib/url-state.ts` — existing primitives (`useFilterParams`, `useGroupParam`, `useNumParam`) are sufficient.
- `packages/indexer/explorer/src/lib/slice-types.ts`, `useSlice.ts`, `api.ts` — engine layer unchanged.
- `packages/indexer/src/api/slice.ts`, `explorer.ts` — backend unchanged.

---

## Task 1: `GroupByDropdown` component

**Files:**
- Create: `packages/indexer/explorer/src/components/GroupByDropdown.tsx`
- Create: `packages/indexer/explorer/src/components/GroupByDropdown.test.tsx`

- [ ] **Step 1: Write the failing test**

```tsx
// packages/indexer/explorer/src/components/GroupByDropdown.test.tsx
import { render, screen, fireEvent } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';
import { GroupByDropdown } from './GroupByDropdown';

describe('GroupByDropdown', () => {
  it('renders the current value in the trigger', () => {
    render(<GroupByDropdown value="harness" onChange={() => {}} />);
    expect(screen.getByRole('button', { name: /Group by: harness/i })).toBeInTheDocument();
  });

  it('renders "none" trigger when value is none', () => {
    render(<GroupByDropdown value="none" onChange={() => {}} />);
    expect(screen.getByRole('button', { name: /Group by: none/i })).toBeInTheDocument();
  });

  it('applies active styling when value !== none', () => {
    const { rerender } = render(<GroupByDropdown value="none" onChange={() => {}} />);
    const triggerInactive = screen.getByRole('button', { name: /Group by:/i });
    expect(triggerInactive).toHaveAttribute('data-active', 'false');
    rerender(<GroupByDropdown value="operator" onChange={() => {}} />);
    expect(screen.getByRole('button', { name: /Group by:/i })).toHaveAttribute('data-active', 'true');
  });

  it('opens menu on click and shows all six options', () => {
    render(<GroupByDropdown value="none" onChange={() => {}} />);
    fireEvent.click(screen.getByRole('button', { name: /Group by:/i }));
    expect(screen.getByRole('menuitem', { name: 'none' })).toBeInTheDocument();
    expect(screen.getByRole('menuitem', { name: 'operator' })).toBeInTheDocument();
    expect(screen.getByRole('menuitem', { name: 'harness' })).toBeInTheDocument();
    expect(screen.getByRole('menuitem', { name: 'plugin' })).toBeInTheDocument();
    expect(screen.getByRole('menuitem', { name: 'mode' })).toBeInTheDocument();
    expect(screen.getByRole('menuitem', { name: 'model' })).toBeInTheDocument();
  });

  it('calls onChange with the picked dimension and closes the menu', () => {
    const onChange = vi.fn();
    render(<GroupByDropdown value="none" onChange={onChange} />);
    fireEvent.click(screen.getByRole('button', { name: /Group by:/i }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'harness' }));
    expect(onChange).toHaveBeenCalledWith('harness');
    // Menu closes
    expect(screen.queryByRole('menuitem', { name: 'harness' })).not.toBeInTheDocument();
  });

  it('closes the menu on Escape', () => {
    render(<GroupByDropdown value="none" onChange={() => {}} />);
    fireEvent.click(screen.getByRole('button', { name: /Group by:/i }));
    expect(screen.getByRole('menuitem', { name: 'harness' })).toBeInTheDocument();
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.queryByRole('menuitem', { name: 'harness' })).not.toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/indexer/explorer && yarn vitest run src/components/GroupByDropdown.test.tsx`
Expected: FAIL — "Cannot find module './GroupByDropdown'".

- [ ] **Step 3: Write the implementation**

```tsx
// packages/indexer/explorer/src/components/GroupByDropdown.tsx
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
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd packages/indexer/explorer && yarn vitest run src/components/GroupByDropdown.test.tsx`
Expected: PASS — 6 tests.

- [ ] **Step 5: Commit**

```bash
git add packages/indexer/explorer/src/components/GroupByDropdown.tsx packages/indexer/explorer/src/components/GroupByDropdown.test.tsx
git commit -m "feat(explorer-spa): GroupByDropdown component (spec §3, §4.3)"
```

---

## Task 2: `FilterChipStrip` component

**Files:**
- Create: `packages/indexer/explorer/src/components/FilterChipStrip.tsx`
- Create: `packages/indexer/explorer/src/components/FilterChipStrip.test.tsx`

- [ ] **Step 1: Write the failing test**

```tsx
// packages/indexer/explorer/src/components/FilterChipStrip.test.tsx
import { render, screen, fireEvent } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';
import { FilterChipStrip } from './FilterChipStrip';
import type { FilterMap } from '../lib/url-state';

describe('FilterChipStrip', () => {
  it('returns null when filters are empty', () => {
    const { container } = render(
      <FilterChipStrip filters={{}} onRemove={() => {}} onAddFilter={() => {}} />,
    );
    expect(container.firstChild).toBeNull();
  });

  it('renders one chip per (dim, value) pair', () => {
    const filters: FilterMap = { harness: ['codex'], model: ['gpt-5.4-mini'] };
    render(
      <FilterChipStrip filters={filters} onRemove={() => {}} onAddFilter={() => {}} />,
    );
    expect(screen.getByText('harness:codex')).toBeInTheDocument();
    expect(screen.getByText('model:gpt-5.4-mini')).toBeInTheDocument();
  });

  it('renders multiple chips for a dim with multiple values', () => {
    const filters: FilterMap = { plugin: ['a@1.0', 'b@1.0'] };
    render(
      <FilterChipStrip filters={filters} onRemove={() => {}} onAddFilter={() => {}} />,
    );
    expect(screen.getByText('plugin:a@1.0')).toBeInTheDocument();
    expect(screen.getByText('plugin:b@1.0')).toBeInTheDocument();
  });

  it('calls onRemove(dim, value) when × is clicked', () => {
    const onRemove = vi.fn();
    render(
      <FilterChipStrip
        filters={{ harness: ['codex'] }}
        onRemove={onRemove}
        onAddFilter={() => {}}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: /Remove harness=codex/i }));
    expect(onRemove).toHaveBeenCalledWith('harness', 'codex');
  });

  it('renders a + filter chip that calls onAddFilter when clicked', () => {
    const onAddFilter = vi.fn();
    render(
      <FilterChipStrip
        filters={{ harness: ['codex'] }}
        onRemove={() => {}}
        onAddFilter={onAddFilter}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: /Add filter/i }));
    expect(onAddFilter).toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/indexer/explorer && yarn vitest run src/components/FilterChipStrip.test.tsx`
Expected: FAIL — "Cannot find module './FilterChipStrip'".

- [ ] **Step 3: Write the implementation**

```tsx
// packages/indexer/explorer/src/components/FilterChipStrip.tsx
/**
 * FilterChipStrip — chip strip above the chart showing active value filters.
 *
 * Hidden entirely when filters are empty (returns null). When ≥1 filter is
 * active, renders horizontal hairline-bordered strip with one chip per
 * (dim, value) pair plus a "+ filter" add chip at the end.
 *
 * Filter chip: dim:value × in accent-sky.
 * Add chip:    dashed border in fg-dim.
 */
import { FILTER_DIMS, type FilterDim, type FilterMap } from '../lib/url-state';

interface Props {
  filters: FilterMap;
  onRemove: (dim: FilterDim, value: string) => void;
  onAddFilter: () => void;
}

export function FilterChipStrip({ filters, onRemove, onAddFilter }: Props) {
  const flat: { dim: FilterDim; value: string }[] = [];
  for (const dim of FILTER_DIMS) {
    const values = filters[dim];
    if (values) {
      for (const v of values) flat.push({ dim, value: v });
    }
  }
  if (flat.length === 0) return null;

  return (
    <div
      role="region"
      aria-label="Active filters"
      style={{
        display: 'flex',
        gap: 6,
        flexWrap: 'wrap',
        alignItems: 'center',
      }}
    >
      {flat.map(({ dim, value }) => (
        <FilterChip
          key={`${dim}:${value}`}
          dim={dim}
          value={value}
          onRemove={() => onRemove(dim, value)}
        />
      ))}
      <button
        type="button"
        aria-label="Add filter"
        onClick={onAddFilter}
        style={{
          display: 'inline-flex',
          alignItems: 'center',
          border: '1px dashed var(--border)',
          borderRadius: 'var(--radius-pill)',
          padding: '3px 9px',
          fontFamily: 'var(--font-mono)',
          fontSize: 9,
          letterSpacing: '0.10em',
          textTransform: 'uppercase',
          color: 'var(--fg-dim)',
          background: 'transparent',
          cursor: 'pointer',
        }}
      >
        + filter
      </button>
    </div>
  );
}

function FilterChip({
  dim,
  value,
  onRemove,
}: {
  dim: FilterDim;
  value: string;
  onRemove: () => void;
}) {
  return (
    <span
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 6,
        border: '1px solid var(--accent-sky)',
        borderRadius: 'var(--radius-pill)',
        padding: '3px 9px',
        fontFamily: 'var(--font-mono)',
        fontSize: 9,
        letterSpacing: '0.10em',
        textTransform: 'uppercase',
        color: 'var(--accent-sky)',
        background: 'transparent',
      }}
    >
      {dim}:{value}
      <button
        type="button"
        aria-label={`Remove ${dim}=${value}`}
        onClick={onRemove}
        style={{
          background: 'transparent',
          border: 'none',
          color: 'var(--fg-dim)',
          cursor: 'pointer',
          padding: 0,
          marginLeft: 2,
          fontSize: 11,
          lineHeight: 1,
        }}
      >
        ×
      </button>
    </span>
  );
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd packages/indexer/explorer && yarn vitest run src/components/FilterChipStrip.test.tsx`
Expected: PASS — 5 tests.

- [ ] **Step 5: Commit**

```bash
git add packages/indexer/explorer/src/components/FilterChipStrip.tsx packages/indexer/explorer/src/components/FilterChipStrip.test.tsx
git commit -m "feat(explorer-spa): FilterChipStrip component (spec §3.2)"
```

---

## Task 3: `AddFilterPopover` component

**Files:**
- Create: `packages/indexer/explorer/src/components/AddFilterPopover.tsx`
- Create: `packages/indexer/explorer/src/components/AddFilterPopover.test.tsx`

- [ ] **Step 1: Write the failing test**

```tsx
// packages/indexer/explorer/src/components/AddFilterPopover.test.tsx
import { render, screen, fireEvent } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';
import { AddFilterPopover } from './AddFilterPopover';

const AVAILABLE = {
  harness: ['codex', 'hermes-agent'],
  model: ['gpt-5.4-mini', 'claude-haiku-4-5'],
};

describe('AddFilterPopover', () => {
  it('renders the dimension picker at step 1', () => {
    render(
      <AddFilterPopover
        availableValues={AVAILABLE}
        onSelect={() => {}}
        onDismiss={() => {}}
      />,
    );
    expect(screen.getByText(/Add filter/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'operator' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'harness' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'plugin' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'mode' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'model' })).toBeInTheDocument();
  });

  it('moves to step 2 (value picker) when a dimension is clicked', () => {
    render(
      <AddFilterPopover
        availableValues={AVAILABLE}
        onSelect={() => {}}
        onDismiss={() => {}}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'harness' }));
    expect(screen.getByText(/harness/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'codex' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'hermes-agent' })).toBeInTheDocument();
  });

  it('shows an empty-state message when no values exist for the picked dim', () => {
    render(
      <AddFilterPopover
        availableValues={{ ...AVAILABLE, plugin: [] }}
        onSelect={() => {}}
        onDismiss={() => {}}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'plugin' }));
    expect(screen.getByText(/No values to filter by/i)).toBeInTheDocument();
  });

  it('calls onSelect(dim, value) when a value is clicked', () => {
    const onSelect = vi.fn();
    render(
      <AddFilterPopover
        availableValues={AVAILABLE}
        onSelect={onSelect}
        onDismiss={() => {}}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'harness' }));
    fireEvent.click(screen.getByRole('button', { name: 'codex' }));
    expect(onSelect).toHaveBeenCalledWith('harness', 'codex');
  });

  it('calls onDismiss on Escape', () => {
    const onDismiss = vi.fn();
    render(
      <AddFilterPopover
        availableValues={AVAILABLE}
        onSelect={() => {}}
        onDismiss={onDismiss}
      />,
    );
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(onDismiss).toHaveBeenCalled();
  });

  it('has a back button on step 2 that returns to step 1', () => {
    render(
      <AddFilterPopover
        availableValues={AVAILABLE}
        onSelect={() => {}}
        onDismiss={() => {}}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'harness' }));
    expect(screen.getByRole('button', { name: /Back/i })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /Back/i }));
    expect(screen.getByRole('button', { name: 'harness' })).toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/indexer/explorer && yarn vitest run src/components/AddFilterPopover.test.tsx`
Expected: FAIL — "Cannot find module './AddFilterPopover'".

- [ ] **Step 3: Write the implementation**

```tsx
// packages/indexer/explorer/src/components/AddFilterPopover.tsx
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
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd packages/indexer/explorer && yarn vitest run src/components/AddFilterPopover.test.tsx`
Expected: PASS — 6 tests.

- [ ] **Step 5: Commit**

```bash
git add packages/indexer/explorer/src/components/AddFilterPopover.tsx packages/indexer/explorer/src/components/AddFilterPopover.test.tsx
git commit -m "feat(explorer-spa): AddFilterPopover two-step picker (spec §4.2)"
```

---

## Task 4: `SliceSettingsPopover` component

**Files:**
- Create: `packages/indexer/explorer/src/components/SliceSettingsPopover.tsx`
- Create: `packages/indexer/explorer/src/components/SliceSettingsPopover.test.tsx`

- [ ] **Step 1: Write the failing test**

```tsx
// packages/indexer/explorer/src/components/SliceSettingsPopover.test.tsx
import { render, screen, fireEvent } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';
import { SliceSettingsPopover } from './SliceSettingsPopover';

describe('SliceSettingsPopover', () => {
  it('shows Include raw data toggle with correct initial state', () => {
    render(
      <SliceSettingsPopover
        includeRaw={false}
        onIncludeRawChange={() => {}}
        onReset={() => {}}
      />,
    );
    const toggle = screen.getByRole('switch', { name: /Include raw data/i });
    expect(toggle).toHaveAttribute('aria-checked', 'false');
  });

  it('renders toggle as checked when includeRaw is true', () => {
    render(
      <SliceSettingsPopover
        includeRaw={true}
        onIncludeRawChange={() => {}}
        onReset={() => {}}
      />,
    );
    const toggle = screen.getByRole('switch', { name: /Include raw data/i });
    expect(toggle).toHaveAttribute('aria-checked', 'true');
  });

  it('calls onIncludeRawChange(true) when toggling off→on', () => {
    const onIncludeRawChange = vi.fn();
    render(
      <SliceSettingsPopover
        includeRaw={false}
        onIncludeRawChange={onIncludeRawChange}
        onReset={() => {}}
      />,
    );
    fireEvent.click(screen.getByRole('switch', { name: /Include raw data/i }));
    expect(onIncludeRawChange).toHaveBeenCalledWith(true);
  });

  it('renders a Reset to default action and calls onReset when clicked', () => {
    const onReset = vi.fn();
    render(
      <SliceSettingsPopover
        includeRaw={false}
        onIncludeRawChange={() => {}}
        onReset={onReset}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: /Reset to default/i }));
    expect(onReset).toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/indexer/explorer && yarn vitest run src/components/SliceSettingsPopover.test.tsx`
Expected: FAIL — "Cannot find module './SliceSettingsPopover'".

- [ ] **Step 3: Write the implementation**

```tsx
// packages/indexer/explorer/src/components/SliceSettingsPopover.tsx
/**
 * SliceSettingsPopover — content of the ⚙ popover.
 *
 * Two items only:
 *   - Include raw data — toggle. When on, ?include=raw and surface marked.
 *   - Reset to default — action. Clears all slice URL state.
 *
 * Anchor/positioning handled by the parent.
 */

interface Props {
  includeRaw: boolean;
  onIncludeRawChange: (v: boolean) => void;
  onReset: () => void;
}

export function SliceSettingsPopover({
  includeRaw,
  onIncludeRawChange,
  onReset,
}: Props) {
  return (
    <div
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
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd packages/indexer/explorer && yarn vitest run src/components/SliceSettingsPopover.test.tsx`
Expected: PASS — 4 tests.

- [ ] **Step 5: Commit**

```bash
git add packages/indexer/explorer/src/components/SliceSettingsPopover.tsx packages/indexer/explorer/src/components/SliceSettingsPopover.test.tsx
git commit -m "feat(explorer-spa): SliceSettingsPopover for ⚙ menu (spec §4.4)"
```

---

## Task 5: `PersistentControlsRow` component

**Files:**
- Create: `packages/indexer/explorer/src/components/PersistentControlsRow.tsx`
- Create: `packages/indexer/explorer/src/components/PersistentControlsRow.test.tsx`

- [ ] **Step 1: Write the failing test**

```tsx
// packages/indexer/explorer/src/components/PersistentControlsRow.test.tsx
import { render, screen } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';
import { PersistentControlsRow } from './PersistentControlsRow';

describe('PersistentControlsRow', () => {
  it('renders + filter chip and Group by dropdown', () => {
    render(
      <PersistentControlsRow
        group="none"
        onGroupChange={() => {}}
        onAddFilter={() => {}}
      />,
    );
    expect(screen.getByRole('button', { name: /Add filter/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Group by: none/i })).toBeInTheDocument();
  });

  it('right-aligns content with flex', () => {
    const { container } = render(
      <PersistentControlsRow
        group="none"
        onGroupChange={() => {}}
        onAddFilter={() => {}}
      />,
    );
    const row = container.firstChild as HTMLElement;
    expect(row.style.justifyContent).toBe('flex-end');
  });

  it('calls onAddFilter when + filter chip is clicked', () => {
    const onAddFilter = vi.fn();
    render(
      <PersistentControlsRow
        group="none"
        onGroupChange={() => {}}
        onAddFilter={onAddFilter}
      />,
    );
    screen.getByRole('button', { name: /Add filter/i }).click();
    expect(onAddFilter).toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/indexer/explorer && yarn vitest run src/components/PersistentControlsRow.test.tsx`
Expected: FAIL — "Cannot find module './PersistentControlsRow'".

- [ ] **Step 3: Write the implementation**

```tsx
// packages/indexer/explorer/src/components/PersistentControlsRow.tsx
/**
 * PersistentControlsRow — right-aligned row with + filter chip and
 * Group by dropdown. Used at default landing when no filter chips render.
 *
 * When filters are active, the parent renders FilterChipStrip + GroupByDropdown
 * inline instead — this row is only for the empty-strip case.
 */
import { GroupByDropdown } from './GroupByDropdown';
import type { GroupValue } from '../lib/url-state';

interface Props {
  group: GroupValue;
  onGroupChange: (v: GroupValue) => void;
  onAddFilter: () => void;
}

export function PersistentControlsRow({ group, onGroupChange, onAddFilter }: Props) {
  return (
    <div
      style={{
        display: 'flex',
        gap: 8,
        alignItems: 'center',
        justifyContent: 'flex-end',
      }}
    >
      <button
        type="button"
        aria-label="Add filter"
        onClick={onAddFilter}
        style={{
          display: 'inline-flex',
          alignItems: 'center',
          border: '1px dashed var(--border)',
          borderRadius: 'var(--radius-pill)',
          padding: '3px 9px',
          fontFamily: 'var(--font-mono)',
          fontSize: 9,
          letterSpacing: '0.10em',
          textTransform: 'uppercase',
          color: 'var(--fg-dim)',
          background: 'transparent',
          cursor: 'pointer',
        }}
      >
        + filter
      </button>
      <GroupByDropdown value={group} onChange={onGroupChange} />
    </div>
  );
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd packages/indexer/explorer && yarn vitest run src/components/PersistentControlsRow.test.tsx`
Expected: PASS — 3 tests.

- [ ] **Step 5: Commit**

```bash
git add packages/indexer/explorer/src/components/PersistentControlsRow.tsx packages/indexer/explorer/src/components/PersistentControlsRow.test.tsx
git commit -m "feat(explorer-spa): PersistentControlsRow for cold-landing chrome (spec §3.1)"
```

---

## Task 6: `Leaderboard` hover affordance

**Files:**
- Modify: `packages/indexer/explorer/src/components/Leaderboard.tsx`
- Modify: `packages/indexer/explorer/src/components/Leaderboard.test.tsx`

Phase 3 (#676) made operator cells buttons. We add an inline `→ filter to this` hint that appears on hover after the address.

- [ ] **Step 1: Add the failing test for the hover hint**

In `packages/indexer/explorer/src/components/Leaderboard.test.tsx`, append:

```tsx
describe('Leaderboard hover affordance', () => {
  // (Reuse the existing test setup — fixture, render helper.)
  it('renders a sibling hint element after the operator address with "→ filter to this"', () => {
    const onOperatorClick = vi.fn();
    render(
      <Leaderboard
        ranked={[
          {
            rank: 1,
            operator: '0xaaa…bbb',
            attempts: 10,
            settledContribution: 8,
            verdictsTotal: 10,
            verdictsPass: 7,
            resolvedRate: 0.7,
            jinnEarned: '0',
          },
        ]}
        lowVolume={[]}
        onOperatorClick={onOperatorClick}
      />,
    );
    const hint = screen.getByText(/→ filter to this/i);
    expect(hint).toBeInTheDocument();
    expect(hint).toHaveAttribute('data-hover-hint', 'true');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/indexer/explorer && yarn vitest run src/components/Leaderboard.test.tsx -t "hover affordance"`
Expected: FAIL — "Unable to find an element with the text: → filter to this".

- [ ] **Step 3: Add the hint to Leaderboard.tsx**

Find the row-rendering JSX in `Leaderboard.tsx` (the section where the operator address `<button>` is rendered when `onOperatorClick` is supplied) and append, immediately after the address text within the button (or as a sibling span):

```tsx
<span
  data-hover-hint="true"
  className="leaderboard-row-hint"
  style={{
    marginLeft: 6,
    fontFamily: 'var(--font-mono)',
    fontSize: 8,
    letterSpacing: '0.04em',
    color: 'var(--fg-dim)',
    opacity: 0,
    transition: 'opacity 80ms linear',
    pointerEvents: 'none',
  }}
>
  → filter to this
</span>
```

And add a global stylesheet rule (in the existing CSS file or via a `<style>` block within the component module) so the hint becomes visible on hover:

```css
button[aria-label^="Filter chart to"]:hover .leaderboard-row-hint {
  opacity: 1;
}
```

Alternatively (preferred if the row uses inline-styles only), set the hint's opacity via React state on `onMouseEnter` / `onMouseLeave`:

```tsx
const [hoveredOperator, setHoveredOperator] = useState<string | null>(null);
// In the row:
<button
  aria-label={`Filter chart to operator ${row.operator}`}
  onMouseEnter={() => setHoveredOperator(row.operator)}
  onMouseLeave={() => setHoveredOperator(null)}
  ...
>
  {shortAddr(row.operator)}
  <span
    data-hover-hint="true"
    style={{
      ...hintStyle,
      opacity: hoveredOperator === row.operator ? 1 : 0,
    }}
  >
    → filter to this
  </span>
</button>
```

The implementer picks whichever pattern matches the existing file's hover-affordance convention. Both satisfy the test.

- [ ] **Step 4: Run test to verify it passes**

Run: `cd packages/indexer/explorer && yarn vitest run src/components/Leaderboard.test.tsx -t "hover affordance"`
Expected: PASS — 1 test.

- [ ] **Step 5: Re-run full Leaderboard test suite to confirm no regression**

Run: `cd packages/indexer/explorer && yarn vitest run src/components/Leaderboard.test.tsx`
Expected: PASS — all existing tests still pass plus the new one.

- [ ] **Step 6: Commit**

```bash
git add packages/indexer/explorer/src/components/Leaderboard.tsx packages/indexer/explorer/src/components/Leaderboard.test.tsx
git commit -m "feat(explorer-spa): Leaderboard hover hint '→ filter to this' (spec §4.1)"
```

---

## Task 7: `LearningCurve` legend hover affordance

**Files:**
- Modify: `packages/indexer/explorer/src/components/LearningCurve.tsx`
- Modify: `packages/indexer/explorer/src/components/LearningCurve.test.tsx`

Symmetric to Task 6: legend buttons gain the same `→ filter to this` hover hint when `onLegendClick` is supplied.

- [ ] **Step 1: Add the failing test for the legend hover hint**

In `packages/indexer/explorer/src/components/LearningCurve.test.tsx`, append:

```tsx
describe('LearningCurve legend hover affordance', () => {
  // Reuse the existing render helper from this file's existing tests.
  // The exact prop shape must match LearningCurve's actual props.
  it('renders a sibling hint after each legend label when onLegendClick is supplied', () => {
    const onLegendClick = vi.fn();
    render(
      <LearningCurve
        series={[
          { groupValue: 'codex', buckets: [], rolling: [], kpis: null },
          { groupValue: 'hermes-agent', buckets: [], rolling: [], kpis: null },
        ]}
        groupBy="harness"
        windowSize={50}
        onLegendClick={onLegendClick}
      />,
    );
    const hints = screen.getAllByText(/→ filter to this/i);
    expect(hints).toHaveLength(2);
  });

  it('does NOT render legend hints when onLegendClick is not supplied', () => {
    render(
      <LearningCurve
        series={[
          { groupValue: 'codex', buckets: [], rolling: [], kpis: null },
        ]}
        groupBy="harness"
        windowSize={50}
      />,
    );
    expect(screen.queryByText(/→ filter to this/i)).not.toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/indexer/explorer && yarn vitest run src/components/LearningCurve.test.tsx -t "hover affordance"`
Expected: FAIL — "Unable to find an element with the text: → filter to this".

- [ ] **Step 3: Add the hint to LearningCurve.tsx**

Locate the legend-rendering JSX (line ~301-340 per current source: the block that renders one `<button>` per series when `onLegendClick` is supplied). Inside each legend `<button>`, append immediately after the label:

```tsx
{onLegendClick ? (
  <span
    data-hover-hint="true"
    style={{
      marginLeft: 6,
      fontFamily: 'var(--font-mono)',
      fontSize: 8,
      letterSpacing: '0.04em',
      color: 'var(--fg-dim)',
      opacity: 0,
      transition: 'opacity 80ms linear',
      pointerEvents: 'none',
    }}
    className="legend-hover-hint"
  >
    → filter to this
  </span>
) : null}
```

And in the existing inline styles (or via a small `<style>` block at the top of LearningCurve.tsx if it does inline-only), add the hover rule:

```tsx
<style>{`
  button[data-legend-item="true"]:hover .legend-hover-hint {
    opacity: 1;
  }
`}</style>
```

The button rendering the legend label should already have a stable selector — add `data-legend-item="true"` if not already present.

- [ ] **Step 4: Run test to verify it passes**

Run: `cd packages/indexer/explorer && yarn vitest run src/components/LearningCurve.test.tsx -t "hover affordance"`
Expected: PASS — 2 tests.

- [ ] **Step 5: Re-run full LearningCurve test suite**

Run: `cd packages/indexer/explorer && yarn vitest run src/components/LearningCurve.test.tsx`
Expected: PASS — all existing tests still pass plus the new ones.

- [ ] **Step 6: Commit**

```bash
git add packages/indexer/explorer/src/components/LearningCurve.tsx packages/indexer/explorer/src/components/LearningCurve.test.tsx
git commit -m "feat(explorer-spa): LearningCurve legend hover hint '→ filter to this' (spec §4.1)"
```

---

## Task 8: Bug fix 6.1 — chart renders single-series with degenerate filter+group

**Files:**
- Modify: `packages/indexer/explorer/src/views/SolverNetView.tsx`
- Modify: `packages/indexer/explorer/src/views/SolverNetView.test.tsx`

Spec §6.1: visiting `?group=harness&filter[harness]=codex` returns one series from the engine but the chart panel shows "No data yet." The spec allows either (a) render the single-series chart correctly, or (b) auto-clear `group` when its dim is filtered to one value. Pick **(b)** — auto-clear — because it's the more surgical fix (a one-line useEffect) and matches what an operator would expect (filtering to one value of a group is degenerate; the URL becomes cleaner).

- [ ] **Step 1: Add a failing test for the auto-clear behavior**

In `packages/indexer/explorer/src/views/SolverNetView.test.tsx`, add:

```tsx
import { Router } from 'wouter';
import { memoryLocation } from 'wouter/memory-location';

describe('SolverNetView — degenerate filter+group auto-clears group (bug 6.1)', () => {
  it('does not render the legacy "No data yet" empty-state when group=harness && filter[harness]=codex', async () => {
    const { hook, navigate } = memoryLocation({
      path: '/solvernet/bafkreictest?group=harness&filter%5Bharness%5D=codex',
    });
    // Stub useSlice to return a single series for this scenario.
    // (Spy implementation must match the existing test file's pattern; reuse it.)
    renderWithStubbedSlice(
      <Router hook={hook}>
        <SolverNetView />
      </Router>,
      {
        series: [{ groupValue: 'codex', buckets: [{ x: 1, y: 0.6 }], rolling: [0.6], kpis: { resolvedRate: 0.6, attempts: 1, verdicts: 1, verdictsPass: 1, jinnEarned: '0' } }],
        kpis: { resolvedRate: 0.6, attempts: 1, verdicts: 1, verdictsPass: 1, jinnEarned: '0' },
      },
    );
    // The chart should render; "No data yet" empty-state should not.
    expect(screen.queryByText(/No data yet/i)).not.toBeInTheDocument();
  });

  it('drops group=harness from the URL when filter[harness] is added', async () => {
    const { hook, location } = memoryLocation({
      path: '/solvernet/bafkreictest?group=harness',
    });
    // Render with no filter yet. The effect should not change the URL.
    const { rerender } = renderWithStubbedSlice(
      <Router hook={hook}>
        <SolverNetView />
      </Router>,
      { /* default stubs */ },
    );
    expect(location.toString()).toMatch(/group=harness/);

    // Simulate the user adding filter[harness]=codex. Update the URL & rerender.
    hook[1]('/solvernet/bafkreictest?group=harness&filter[harness]=codex', { replace: true });
    rerender(
      <Router hook={hook}>
        <SolverNetView />
      </Router>,
    );
    // After the auto-clear effect fires, group= should be gone.
    expect(location.toString()).not.toMatch(/group=harness/);
    expect(location.toString()).toMatch(/filter\[harness\]=codex/);
  });
});
```

If the existing test file does not have `renderWithStubbedSlice` and `memoryLocation` patterns wired, follow the existing per-test setup in `SolverNetView.test.tsx` (e.g. the existing `useSlice` mock via `vi.mock('../lib/api', () => ({...}))`).

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/indexer/explorer && yarn vitest run src/views/SolverNetView.test.tsx -t "bug 6.1"`
Expected: FAIL — "No data yet" still rendered, group= not dropped.

- [ ] **Step 3: Add the auto-clear effect to SolverNetView.tsx**

In `SolverNetView.tsx`, near the top of the `SolverNetView()` function (just below the existing `useGroupParam`/`useFilterParams` calls), add:

```tsx
// Bug fix 6.1 (spec §6.1): when filter[<dim>] is set AND group === <dim>,
// the group is degenerate (one series, equals what group=none would show).
// Auto-clear group to keep the URL clean and the chart correctly rendered.
useEffect(() => {
  if (group !== 'none' && filters[group] && filters[group]!.length > 0) {
    setGroup('none');
  }
}, [group, filters, setGroup]);
```

(Use the actual names of the `useGroupParam`/`useFilterParams` return values from this file.)

- [ ] **Step 4: Run test to verify it passes**

Run: `cd packages/indexer/explorer && yarn vitest run src/views/SolverNetView.test.tsx -t "bug 6.1"`
Expected: PASS — 2 tests.

- [ ] **Step 5: Commit**

```bash
git add packages/indexer/explorer/src/views/SolverNetView.tsx packages/indexer/explorer/src/views/SolverNetView.test.tsx
git commit -m "fix(explorer-spa): auto-clear group when filter narrows it to one value (spec §6.1, bug fix)"
```

---

## Task 9: Bug fix 6.2 — KPI hero uses aggregate `kpis.resolvedRate` regardless of group

**Files:**
- Modify: `packages/indexer/explorer/src/views/SolverNetView.tsx`
- Modify: `packages/indexer/explorer/src/views/SolverNetView.test.tsx`

Spec §6.2: visiting `?group=harness` shows the gold KPI hero as `2.6%` because the headline math goes off the rails when `series` is multi-element. Fix: KPI hero always reads `slice.kpis.resolvedRate` (the engine-returned aggregate), regardless of grouping.

- [ ] **Step 1: Add a failing test for the KPI hero**

In `packages/indexer/explorer/src/views/SolverNetView.test.tsx`, add:

```tsx
describe('SolverNetView — KPI hero uses aggregate kpis.resolvedRate (bug 6.2)', () => {
  it('shows aggregate rate (slice.kpis.resolvedRate) when group !== none', async () => {
    const { hook } = memoryLocation({ path: '/solvernet/bafkreictest?group=harness' });
    renderWithStubbedSlice(
      <Router hook={hook}>
        <SolverNetView />
      </Router>,
      {
        kpis: { resolvedRate: 0.635, attempts: 200, verdicts: 200, verdictsPass: 127, jinnEarned: '0' },
        series: [
          { groupValue: 'codex', kpis: { resolvedRate: 0.7, attempts: 100, verdicts: 100, verdictsPass: 70, jinnEarned: '0' } },
          { groupValue: 'hermes-agent', kpis: { resolvedRate: 0.4, attempts: 50, verdicts: 50, verdictsPass: 20, jinnEarned: '0' } },
          { groupValue: '(unknown)', kpis: { resolvedRate: 0.74, attempts: 50, verdicts: 50, verdictsPass: 37, jinnEarned: '0' } },
        ],
      },
    );
    // 63.5% is the engine's aggregate (slice.kpis.resolvedRate).
    // The hero must show this — not the first series rate, not 2.6%, not 0%.
    const heroRate = screen.getByTestId('kpi-hero-resolved-rate');
    expect(heroRate).toHaveTextContent('63.5%');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/indexer/explorer && yarn vitest run src/views/SolverNetView.test.tsx -t "bug 6.2"`
Expected: FAIL — KPI hero shows wrong value when grouped.

- [ ] **Step 3: Fix the KPI hero in SolverNetView.tsx**

Find the line in `SolverNetView.tsx` that feeds the gold KPI hero's value (currently something like `useCountUp(slice?.series[0].kpis?.resolvedRate ?? 0, 400)` or similar grouped-incorrect form). Change it to read the slice's top-level aggregate:

```tsx
// Bug fix 6.2 (spec §6.2): KPI hero ALWAYS reflects the slice's aggregate
// `kpis.resolvedRate`, regardless of grouping. The series array shapes the
// chart; the headline reflects the slice as a whole.
const animatedRate = useCountUp(slice?.kpis?.resolvedRate ?? 0, 400);
```

Also ensure the rendered KPI value has `data-testid="kpi-hero-resolved-rate"` so the test can find it (add it to the existing `<span>` or `<div>` rendering the rate).

- [ ] **Step 4: Run test to verify it passes**

Run: `cd packages/indexer/explorer && yarn vitest run src/views/SolverNetView.test.tsx -t "bug 6.2"`
Expected: PASS — 1 test.

- [ ] **Step 5: Commit**

```bash
git add packages/indexer/explorer/src/views/SolverNetView.tsx packages/indexer/explorer/src/views/SolverNetView.test.tsx
git commit -m "fix(explorer-spa): KPI hero reads slice.kpis.resolvedRate, not per-series (spec §6.2, bug fix)"
```

---

## Task 10: `SolverNetView` migration — swap `ExploreControls` for new composition

**Files:**
- Modify: `packages/indexer/explorer/src/views/SolverNetView.tsx`
- Modify: `packages/indexer/explorer/src/views/SolverNetView.test.tsx`

Now wire the new components into SolverNetView. The shape per spec §3 is:

1. Header + KPI strip (unchanged).
2. Either `<FilterChipStrip>` (when filters active) **with** `<GroupByDropdown>` inline at right, OR `<PersistentControlsRow>` (when filters empty) — choose one based on filter-count.
3. Chart panel with existing window selector + ⚙ button (the ⚙ now opens `<SliceSettingsPopover>` via a small wrapper).
4. Leaderboard, CheckpointTimeline, FreezeIntegrity (unchanged).

- [ ] **Step 1: Add tests for the new composition**

In `packages/indexer/explorer/src/views/SolverNetView.test.tsx`, add:

```tsx
describe('SolverNetView — new filter chrome (spec §3)', () => {
  it('renders PersistentControlsRow when no filters are active', () => {
    const { hook } = memoryLocation({ path: '/solvernet/bafkreictest' });
    renderWithStubbedSlice(
      <Router hook={hook}>
        <SolverNetView />
      </Router>,
      { kpis: { resolvedRate: 0.63 } },
    );
    expect(screen.getByRole('button', { name: /Add filter/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Group by: none/i })).toBeInTheDocument();
    // FilterChipStrip should NOT render
    expect(screen.queryByRole('region', { name: /Active filters/i })).not.toBeInTheDocument();
  });

  it('renders FilterChipStrip + inline GroupByDropdown when filters are active', () => {
    const { hook } = memoryLocation({
      path: '/solvernet/bafkreictest?filter%5Bharness%5D=codex&filter%5Bmodel%5D=gpt-5.4-mini&window=30',
    });
    renderWithStubbedSlice(
      <Router hook={hook}>
        <SolverNetView />
      </Router>,
      { kpis: { resolvedRate: 0.63 } },
    );
    expect(screen.getByRole('region', { name: /Active filters/i })).toBeInTheDocument();
    expect(screen.getByText('harness:codex')).toBeInTheDocument();
    expect(screen.getByText('model:gpt-5.4-mini')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Group by: none/i })).toBeInTheDocument();
  });

  it('removes a filter when its × is clicked', () => {
    const { hook, location } = memoryLocation({
      path: '/solvernet/bafkreictest?filter%5Bharness%5D=codex',
    });
    renderWithStubbedSlice(
      <Router hook={hook}>
        <SolverNetView />
      </Router>,
      { kpis: { resolvedRate: 0.63 } },
    );
    fireEvent.click(screen.getByRole('button', { name: /Remove harness=codex/i }));
    expect(location.toString()).not.toMatch(/filter\[harness\]/);
  });

  it('does NOT render the legacy ExploreControls section labels', () => {
    const { hook } = memoryLocation({ path: '/solvernet/bafkreictest' });
    renderWithStubbedSlice(
      <Router hook={hook}>
        <SolverNetView />
      </Router>,
      { kpis: { resolvedRate: 0.63 } },
    );
    // The old card had explicit "GROUP BY" + "FILTERS" + "WINDOW" + "RAW" section labels.
    // After migration, "GROUP BY" / "FILTERS" / "RAW" must NOT appear as section labels.
    // (Note: "WINDOW" still appears in the chart-caption inline selector — that's allowed.)
    expect(screen.queryByText(/^GROUP BY$/)).not.toBeInTheDocument();
    expect(screen.queryByText(/^FILTERS$/)).not.toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd packages/indexer/explorer && yarn vitest run src/views/SolverNetView.test.tsx -t "new filter chrome"`
Expected: FAIL — old ExploreControls is still rendered.

- [ ] **Step 3: Replace `<ExploreControls>` with the new composition**

In `SolverNetView.tsx`:

(a) Remove the `import { ExploreControls } from '../components/ExploreControls';` line.

(b) Add imports:

```tsx
import { FilterChipStrip } from '../components/FilterChipStrip';
import { GroupByDropdown } from '../components/GroupByDropdown';
import { PersistentControlsRow } from '../components/PersistentControlsRow';
import { AddFilterPopover } from '../components/AddFilterPopover';
import { SliceSettingsPopover } from '../components/SliceSettingsPopover';
```

(c) Add small state for popover open/closed flags:

```tsx
const [addFilterOpen, setAddFilterOpen] = useState(false);
const [settingsOpen, setSettingsOpen] = useState(false);
```

(d) Compute `hasFilters` and the `availableValues` for the popover:

```tsx
const hasFilters = Object.keys(filters).length > 0;

// Available values for the add-filter popover come from the slice engine's
// series array when the user has grouped by a dimension. The engine emits
// one series per distinct value of the group dimension, so series[].groupValue
// is exactly the list of values available to filter on for that dim.
//
// For dimensions the user hasn't grouped on, we have no per-SolverNet value
// list to draw from (the slice doesn't return those). The popover falls back
// to the "No values to filter by" empty state, and the operator can either
// group by the dim first OR click a leaderboard row / chart legend item to
// add the filter that way. Populating values for all dims via /explorer/network
// composition is a follow-up enhancement; not blocking for v1.
const availableValues: Partial<Record<FilterDim, string[]>> = {};
if (slice && group !== 'none') {
  const dim = group as FilterDim;
  const values = slice.series
    .map((s) => s.groupValue)
    .filter((v): v is string => v !== null && v !== '');
  if (values.length > 0) {
    availableValues[dim] = values;
  }
}
```

(e) Replace the `<ExploreControls ... />` JSX block with:

```tsx
<div style={{ position: 'relative', marginBottom: 8 }}>
  {hasFilters ? (
    <div
      style={{
        display: 'flex',
        gap: 12,
        alignItems: 'center',
        justifyContent: 'space-between',
        padding: '8px 0',
        borderTop: '1px solid var(--border)',
        borderBottom: '1px solid var(--border)',
        background: 'rgba(122,167,220,0.04)',
      }}
    >
      <FilterChipStrip
        filters={filters}
        onRemove={(dim, value) => {
          const next = { ...filters };
          const arr = (next[dim] || []).filter((v) => v !== value);
          if (arr.length === 0) {
            delete next[dim];
          } else {
            next[dim] = arr;
          }
          setFilters(next);
        }}
        onAddFilter={() => setAddFilterOpen(true)}
      />
      <GroupByDropdown value={group} onChange={setGroup} />
    </div>
  ) : (
    <PersistentControlsRow
      group={group}
      onGroupChange={setGroup}
      onAddFilter={() => setAddFilterOpen(true)}
    />
  )}
  {addFilterOpen ? (
    <div style={{ position: 'absolute', top: '100%', right: 0, zIndex: 10 }}>
      <AddFilterPopover
        availableValues={availableValues}
        onSelect={(dim, value) => {
          const next = { ...filters };
          next[dim] = [...(next[dim] || []), value];
          setFilters(next);
          setAddFilterOpen(false);
        }}
        onDismiss={() => setAddFilterOpen(false)}
      />
    </div>
  ) : null}
</div>
```

(f) Wire up the ⚙ button — find the existing `⚙` rendering inside the chart-header row and convert it into a button that toggles `settingsOpen`:

```tsx
<button
  type="button"
  aria-label="Slice settings"
  onClick={() => setSettingsOpen((p) => !p)}
  style={{
    border: '1px solid var(--border)',
    borderRadius: 'var(--radius-pill)',
    background: 'transparent',
    color: 'var(--fg-dim)',
    padding: '3px 7px',
    cursor: 'pointer',
    marginLeft: 8,
  }}
>
  ⚙
</button>
{settingsOpen ? (
  <div style={{ position: 'absolute', top: '100%', right: 0, zIndex: 10 }}>
    <SliceSettingsPopover
      includeRaw={includeRaw}
      onIncludeRawChange={(v) => {
        setIncludeRaw(v ? 'raw' : null);
        setSettingsOpen(false);
      }}
      onReset={() => {
        setFilters({});
        setGroup('none');
        setWindowSize(null);
        setIncludeRaw(null);
        setSettingsOpen(false);
      }}
    />
  </div>
) : null}
```

(The exact ref names — `includeRaw`, `setIncludeRaw`, `setWindowSize`, etc. — must match the existing URL-state hook names in this file.)

- [ ] **Step 4: Run all SolverNetView tests**

Run: `cd packages/indexer/explorer && yarn vitest run src/views/SolverNetView.test.tsx`
Expected: PASS — all new tests pass; existing tests still pass.

- [ ] **Step 5: Commit**

```bash
git add packages/indexer/explorer/src/views/SolverNetView.tsx packages/indexer/explorer/src/views/SolverNetView.test.tsx
git commit -m "feat(explorer-spa): SolverNetView migrates to progressive-disclosure filter chrome (spec §3, §4)"
```

---

## Task 11: Remove `ExploreControls`

**Files:**
- Delete: `packages/indexer/explorer/src/components/ExploreControls.tsx`
- Delete: `packages/indexer/explorer/src/components/ExploreControls.test.tsx`

- [ ] **Step 1: Verify nothing imports ExploreControls**

Run: `cd packages/indexer/explorer && grep -rn "ExploreControls" src/ 2>&1 | head -10`
Expected: zero matches (after Task 10's import removal).

- [ ] **Step 2: Delete the files**

```bash
rm packages/indexer/explorer/src/components/ExploreControls.tsx
rm packages/indexer/explorer/src/components/ExploreControls.test.tsx
```

- [ ] **Step 3: Run the full explorer test suite to confirm no regression**

Run: `cd packages/indexer/explorer && yarn vitest run`
Expected: PASS — all tests still pass without the deleted file.

- [ ] **Step 4: Run typecheck**

Run: `cd packages/indexer/explorer && yarn typecheck`
Expected: PASS — no type errors.

- [ ] **Step 5: Commit**

```bash
git add -A packages/indexer/explorer/src/components/
git commit -m "refactor(explorer-spa): delete deprecated ExploreControls (superseded by progressive-disclosure chrome)"
```

---

## Task 12: Extend Playwright e2e for cold-landing → add-filter flow

**Files:**
- Modify: `packages/indexer/explorer/test/e2e/solvernet-explore.e2e.test.ts`

- [ ] **Step 1: Add the e2e test cases**

Append to `packages/indexer/explorer/test/e2e/solvernet-explore.e2e.test.ts`:

```ts
test.describe('Cold landing → add filter → remove filter', () => {
  test('cold landing has no chip strip; + filter and Group by ▾ are visible', async ({ page }) => {
    await page.goto(`/solvernet/${CID}`);
    await expect(page.getByRole('region', { name: /Active filters/i })).toHaveCount(0);
    await expect(page.getByRole('button', { name: /Add filter/i })).toBeVisible();
    await expect(page.getByRole('button', { name: /Group by: none/i })).toBeVisible();
  });

  test('clicking + filter opens dimension picker, then picking value adds chip', async ({ page }) => {
    await page.goto(`/solvernet/${CID}`);
    await page.getByRole('button', { name: /Add filter/i }).click();
    await expect(page.getByRole('dialog', { name: /Add filter/i })).toBeVisible();
    await page.getByRole('button', { name: 'harness' }).click();
    // Wait for value list (engine response).
    await expect(page.getByRole('button', { name: 'codex' })).toBeVisible();
    await page.getByRole('button', { name: 'codex' }).click();
    // Popover dismisses, chip appears in the strip.
    await expect(page.getByText('harness:codex')).toBeVisible();
  });

  test('clicking × on a chip removes the filter and the strip collapses if last', async ({ page }) => {
    await page.goto(`/solvernet/${CID}?filter[harness]=codex`);
    await expect(page.getByText('harness:codex')).toBeVisible();
    await page.getByRole('button', { name: /Remove harness=codex/i }).click();
    await expect(page.getByRole('region', { name: /Active filters/i })).toHaveCount(0);
    await expect(page).toHaveURL(new RegExp(`/solvernet/${CID}$`));
  });

  test('Group by dropdown opens, picking dim changes group, picking none resets', async ({ page }) => {
    await page.goto(`/solvernet/${CID}`);
    await page.getByRole('button', { name: /Group by: none/i }).click();
    await page.getByRole('menuitem', { name: 'harness' }).click();
    await expect(page.getByRole('button', { name: /Group by: harness/i })).toBeVisible();
    await expect(page).toHaveURL(/group=harness/);
    // Reset
    await page.getByRole('button', { name: /Group by: harness/i }).click();
    await page.getByRole('menuitem', { name: 'none' }).click();
    await expect(page).not.toHaveURL(/group=/);
  });

  test('legend click on grouped chart adds filter', async ({ page }) => {
    await page.goto(`/solvernet/${CID}?group=harness`);
    // Wait for chart legend buttons.
    await expect(page.getByRole('button', { name: 'codex' }).first()).toBeVisible();
    await page.getByRole('button', { name: 'codex' }).first().click();
    await expect(page).toHaveURL(/filter\[harness\]=codex/);
    // Bug fix 6.1: group=harness auto-clears once filter[harness] is set.
    await expect(page).not.toHaveURL(/group=harness/);
  });

  test('leaderboard row click adds operator filter', async ({ page }) => {
    await page.goto(`/solvernet/${CID}`);
    // Click the first operator row (operator button).
    const firstRow = page.locator('button[aria-label*="Filter chart to operator"]').first();
    await firstRow.click();
    await expect(page).toHaveURL(/filter\[operator\]=/);
  });

  test('⚙ Reset to default clears all slice params', async ({ page }) => {
    await page.goto(`/solvernet/${CID}?filter[harness]=codex&group=mode&window=30&include=raw`);
    await page.getByRole('button', { name: /Slice settings/i }).click();
    await page.getByRole('button', { name: /Reset to default/i }).click();
    await expect(page).toHaveURL(new RegExp(`/solvernet/${CID}$`));
  });
});
```

- [ ] **Step 2: Run the e2e suite**

Run: `cd packages/indexer/explorer && JINN_INDEXER_URL=https://jinn-indexer-production.up.railway.app yarn test:e2e -- --grep "Cold landing"`
Expected: PASS — 7 tests against the live indexer.

If the indexer isn't reachable, the suite skips per its existing `beforeAll` health-check pattern. That's an acceptable result for CI; the smoke is a hand-run gate, not a contract test.

- [ ] **Step 3: Commit**

```bash
git add packages/indexer/explorer/test/e2e/solvernet-explore.e2e.test.ts
git commit -m "test(explorer-spa): e2e cold-landing → add-filter → remove flow (spec §8)"
```

---

## Task 13: Final full-suite verification

- [ ] **Step 1: Vitest unit suite**

Run: `cd packages/indexer/explorer && yarn vitest run`
Expected: PASS — all unit tests green, no regressions.

- [ ] **Step 2: Typecheck**

Run: `cd packages/indexer/explorer && yarn typecheck`
Expected: PASS — zero TS errors.

- [ ] **Step 3: Build**

Run: `cd packages/indexer/explorer && yarn build`
Expected: PASS — SPA bundles without warnings.

- [ ] **Step 4: Visual smoke against the milestone URL**

(Manual.) Run the dev server with `JINN_INDEXER_URL=https://jinn-indexer-production.up.railway.app yarn dev`, navigate to:

`http://localhost:5173/solvernet/bafkreichdzxtjav3rh5boyybgx6wolh7boqedxix4vvw44slfppwppshpi?filter[harness]=codex&filter[model]=gpt-5.4-mini&window=30`

Verify:
- Filter chip strip shows `harness:codex × model:gpt-5.4-mini ×` with `+ filter` add chip.
- `Group by: none ▾` dropdown right-aligned within the strip.
- Window selector inline with chart caption shows `30` pressed.
- Hovering a leaderboard row highlights the row and shows `→ filter to this` hint.
- KPI hero shows ~62-63% (aggregate of slice, not a wrong 2.6%).
- Navigating to `/solvernet/<cid>?group=harness` shows three series; clicking `codex` in the legend filters to single-series; URL becomes `/solvernet/<cid>?filter[harness]=codex` (auto-cleared group).
- ⚙ button opens popover with `Include raw data` toggle and `Reset to default` action; Reset clears all URL params.

- [ ] **Step 5: Open PR**

```bash
git push -u origin <branch-name>
gh pr create --title "refactor(explorer-spa): progressive-disclosure filter UX redesign (spec 2026-05-26)" --body "$(cat <<'EOF'
Implements `spec/2026-05-26-explorer-filter-redesign.md`. Replaces SolverNetView's five-section ExploreControls card with a Plausible/Linear-shaped progressive-disclosure surface: filter chips appear only when active, group-by lives as a separate dropdown, hover hints expose click-to-filter on chart legend + leaderboard rows. Includes inline fixes for bugs 6.1 and 6.2.

## Summary

- Five new components: FilterChipStrip, GroupByDropdown, PersistentControlsRow, AddFilterPopover, SliceSettingsPopover.
- ExploreControls deleted.
- Bug 6.1 fixed: visiting `?group=harness&filter[harness]=codex` no longer shows "No data yet"; the group=harness clause auto-clears since it's degenerate.
- Bug 6.2 fixed: KPI hero reads `slice.kpis.resolvedRate` (engine aggregate) regardless of grouping.
- Vitest coverage on all new components.
- Playwright e2e covers cold-landing → add-filter → remove + legend-click + leaderboard-row-click + reset flows.

## Test plan

- [ ] `cd packages/indexer/explorer && yarn vitest run` — green
- [ ] `cd packages/indexer/explorer && yarn typecheck` — green
- [ ] `cd packages/indexer/explorer && yarn build` — green
- [ ] Manual smoke per plan §Task 13 step 4

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

---

## Done

After the PR merges, Sprint 3's milestone-arc UX is complete. The locked-config URL is the canonical visible artifact for Milestone #2; the redesign makes it accessible from clicks alone, no URL editing required. The two known bugs from #676's review are gone. The page is materially cleaner.

Follow-up work (out of scope for this plan):
- Snapshot to [#647](https://github.com/Jinn-Network/mono/issues/647) tracking issue once the chart shows a real trend.
- Spike [#659](https://github.com/Jinn-Network/mono/issues/659) — investigate whether agents are actually learning given the plateau.
- Check-script [#648](https://github.com/Jinn-Network/mono/issues/648) for numeric milestone-progress reporting.
