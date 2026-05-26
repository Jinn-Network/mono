/**
 * ExploreControls — the control card mounted above the learning curve on
 * `/solvernet/<cid>`. (Originally hosted under `/explore/<cid>`; the two
 * views were merged in refactor #676.)
 *
 * Composes:
 *   - GROUP BY chip row (none / operator / harness / plugin / mode / model)
 *   - Active filter pills with X removal affordance
 *   - Raw toggle (wane-bordered when active, with INCLUDES RAW DATA chip)
 *   - Window selector (SegmentedControl: 20 / 30 / 50 / 100 / ALL)
 *
 * Pure presentation — the parent (`SolverNetView`) owns URL state and passes
 * value/setter pairs in. No wouter dependency here.
 *
 * Design tokens per docs/design/jinn-design-system + DESIGN.md:
 *   - bg-elevated background, 1px border hairline, radius-3 panel
 *   - All labels ALL CAPS MONO 11px / 0.14em letter-spacing
 *   - No emoji, no gradients
 */

import { SegmentedControl } from './SegmentedControl';
import {
  FILTER_DIMS,
  GROUP_VALUES,
  type FilterDim,
  type FilterMap,
  type GroupValue,
} from '../lib/url-state';

const GROUP_OPTIONS: { label: string; value: GroupValue }[] = GROUP_VALUES.map(
  (v) => ({ label: v, value: v }),
);

const WINDOW_ALL = 999999;
const WINDOW_OPTIONS = [
  { label: '20', value: '20' },
  { label: '30', value: '30' },
  { label: '50', value: '50' },
  { label: '100', value: '100' },
  { label: 'ALL', value: String(WINDOW_ALL) },
];

// Caps-mono section label — re-used by GroupChipRow / FilterPills / WindowSelector.
const LABEL_STYLE = {
  fontFamily: 'var(--font-mono)',
  fontSize: 11,
  letterSpacing: '0.14em',
  textTransform: 'uppercase',
  color: 'var(--fg-dim)',
} as const;

export interface ExploreControlsProps {
  group: GroupValue;
  onGroupChange: (v: GroupValue) => void;
  filters: FilterMap;
  onFiltersChange: (v: FilterMap) => void;
  includeRaw: boolean;
  onIncludeRawChange: (v: boolean) => void;
  window: number;
  onWindowChange: (v: number) => void;
}

function GroupChipRow({
  value,
  onChange,
}: { value: GroupValue; onChange: (v: GroupValue) => void }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
      <span style={LABEL_STYLE}>Group by</span>
      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
        {GROUP_OPTIONS.map((opt) => {
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
                padding: '4px 10px',
                borderRadius: 'var(--radius-pill)',
                border: `1px solid ${active ? 'var(--accent)' : 'var(--border)'}`,
                background: 'transparent',
                color: active ? 'var(--accent)' : 'var(--fg-muted)',
                cursor: 'pointer',
              }}
            >
              {opt.label}
            </button>
          );
        })}
      </div>
    </div>
  );
}

function FilterPills({
  filters,
  onChange,
}: { filters: FilterMap; onChange: (v: FilterMap) => void }) {
  const pills: { dim: FilterDim; val: string }[] = [];
  for (const dim of FILTER_DIMS) {
    const arr = filters[dim];
    if (arr) for (const v of arr) pills.push({ dim, val: v });
  }
  if (pills.length === 0) return null;
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
      <span style={LABEL_STYLE}>Filters</span>
      {pills.map(({ dim, val }) => (
        <span
          key={`${dim}:${val}`}
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            gap: 6,
            padding: '3px 4px 3px 9px',
            borderRadius: 'var(--radius-pill)',
            border: '1px solid var(--border-strong)',
            fontFamily: 'var(--font-mono)',
            fontSize: 10,
            letterSpacing: '0.10em',
            textTransform: 'uppercase',
            color: 'var(--fg-muted)',
          }}
        >
          {dim}:{val}
          <button
            type="button"
            aria-label={`Remove ${dim}=${val}`}
            onClick={() => {
              const next: FilterMap = { ...filters };
              const remaining = (next[dim] ?? []).filter((x) => x !== val);
              if (remaining.length === 0) delete next[dim];
              else next[dim] = remaining;
              onChange(next);
            }}
            style={{
              background: 'transparent',
              border: 'none',
              color: 'var(--fg-dim)',
              cursor: 'pointer',
              fontFamily: 'var(--font-mono)',
              fontSize: 12,
              lineHeight: 1,
              padding: '0 4px',
            }}
          >
            x
          </button>
        </span>
      ))}
    </div>
  );
}

function RawToggle({
  on,
  onChange,
}: { on: boolean; onChange: (v: boolean) => void }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
      <button
        type="button"
        aria-pressed={on}
        onClick={() => onChange(!on)}
        style={{
          fontFamily: 'var(--font-mono)',
          fontSize: 10,
          letterSpacing: '0.10em',
          textTransform: 'uppercase',
          padding: '4px 10px',
          borderRadius: 'var(--radius-pill)',
          border: `1px solid ${on ? 'var(--wane)' : 'var(--border)'}`,
          background: 'transparent',
          color: on ? 'var(--wane)' : 'var(--fg-muted)',
          cursor: 'pointer',
        }}
      >
        Raw
      </button>
      {on && (
        <span
          style={{
            fontFamily: 'var(--font-mono)',
            fontSize: 10,
            letterSpacing: '0.14em',
            textTransform: 'uppercase',
            padding: '3px 9px',
            border: '1px solid var(--wane)',
            color: 'var(--wane)',
            borderRadius: 'var(--radius-pill)',
          }}
        >
          Includes raw data
        </span>
      )}
    </div>
  );
}

function WindowSelector({
  value,
  onChange,
}: { value: number; onChange: (v: number) => void }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
      <span style={LABEL_STYLE}>Window</span>
      <SegmentedControl
        options={WINDOW_OPTIONS}
        value={String(value >= WINDOW_ALL ? WINDOW_ALL : value)}
        onChange={(v) => onChange(Number(v))}
      />
    </div>
  );
}

export function ExploreControls(props: ExploreControlsProps) {
  return (
    <div
      style={{
        background: 'var(--bg-elevated)',
        border: '1px solid var(--border)',
        borderRadius: 'var(--radius-3)',
        padding: 20,
        display: 'flex',
        flexDirection: 'column',
        gap: 14,
      }}
    >
      <GroupChipRow value={props.group} onChange={props.onGroupChange} />
      <FilterPills filters={props.filters} onChange={props.onFiltersChange} />
      <div style={{ display: 'flex', alignItems: 'center', gap: 24, flexWrap: 'wrap' }}>
        <WindowSelector value={props.window} onChange={props.onWindowChange} />
        <RawToggle on={props.includeRaw} onChange={props.onIncludeRawChange} />
      </div>
    </div>
  );
}
