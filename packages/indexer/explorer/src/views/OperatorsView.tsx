/**
 * OperatorsView — the global leaderboard of all operators.
 *
 * Gold element: none on this surface (all sky) — resolved-rate col is bold
 * but not gold. The one-per-surface gold rule reserves gold for the Operator
 * detail view's resolved-rate total KPI.
 *
 * Faceted filter bar:
 *   - mode: all | train | frozen (segmented control)
 *   - harness: free-text / select populated from network composition
 *   - minVerdicts: numeric threshold
 *
 * All filters write to URL-state (replace:true), so copying the URL reproduces
 * the filtered view.
 */

import { useOperators, useNetwork } from '../lib/api';
import { StatusBar } from '../components/StatusBar';
import { Leaderboard } from '../components/Leaderboard';
import { StatusChip } from '../components/StatusChip';
import { useEnumParam, useQueryParam, useNumParam } from '../lib/url-state';

// ── Segmented control (inline — shared pattern with SolverNetView) ─────────────

function SegmentedControl<T extends string>({
  options,
  value,
  onChange,
}: {
  options: { label: string; value: T }[];
  value: T;
  onChange: (v: T) => void;
}) {
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
      {options.map((opt, i) => {
        const active = opt.value === value;
        return (
          <button
            key={opt.value}
            onClick={() => onChange(opt.value)}
            style={{
              fontFamily: 'var(--font-mono)',
              fontSize: 10,
              letterSpacing: '0.10em',
              textTransform: 'uppercase',
              padding: '5px 14px',
              border: 'none',
              borderRight: i < options.length - 1 ? '1px solid var(--border)' : 'none',
              cursor: 'pointer',
              background: active ? 'var(--bg-sunken)' : 'transparent',
              color: active ? 'var(--fg)' : 'var(--fg-dim)',
              transition: `background var(--dur-fast) var(--ease-linear), color var(--dur-fast) var(--ease-linear)`,
            }}
          >
            {opt.label}
          </button>
        );
      })}
    </div>
  );
}

// ── Input styling ─────────────────────────────────────────────────────────────

const inputStyle: React.CSSProperties = {
  fontFamily: 'var(--font-mono)',
  fontSize: 11,
  letterSpacing: '0.06em',
  background: 'var(--bg-sunken)',
  border: '1px solid var(--border)',
  borderRadius: 'var(--radius-2)',
  color: 'var(--fg)',
  padding: '5px 10px',
  outline: 'none',
  transition: 'border-color var(--dur-fast) var(--ease-linear)',
};

const labelStyle: React.CSSProperties = {
  fontFamily: 'var(--font-mono)',
  fontSize: 9,
  letterSpacing: '0.14em',
  textTransform: 'uppercase',
  color: 'var(--fg-dim)',
  fontWeight: 500,
};

// ── Skeleton ──────────────────────────────────────────────────────────────────

function FilterSkeleton() {
  return (
    <div
      style={{
        display: 'flex',
        gap: 16,
        flexWrap: 'wrap',
        alignItems: 'flex-end',
        marginBottom: 28,
      }}
    >
      {[80, 140, 80].map((w, i) => (
        <div
          key={i}
          style={{
            height: 32,
            width: w,
            background: 'var(--bg-elevated)',
            border: '1px solid var(--border)',
            borderRadius: 'var(--radius-2)',
          }}
        />
      ))}
    </div>
  );
}

function LeaderboardSkeleton() {
  return (
    <div
      style={{
        border: '1px solid var(--border)',
        borderRadius: 'var(--radius-3)',
        background: 'var(--bg-elevated)',
        height: 240,
        display: 'flex',
        flexDirection: 'column',
        gap: 1,
        overflow: 'hidden',
      }}
    >
      {/* Header row */}
      <div
        style={{
          height: 36,
          background: 'var(--bg-sunken)',
          borderBottom: '1px solid var(--border)',
        }}
      />
      {/* Skeleton data rows */}
      {[1, 2, 3].map((i) => (
        <div
          key={i}
          style={{
            height: 44,
            background: 'var(--bg-elevated)',
            borderBottom: '1px solid var(--border)',
            display: 'flex',
            alignItems: 'center',
            padding: '0 16px',
            gap: 16,
          }}
        >
          <div
            style={{
              width: 30,
              height: 12,
              background: 'var(--bg-sunken)',
              borderRadius: 'var(--radius-1)',
            }}
          />
          <div
            style={{
              flex: 1,
              height: 12,
              background: 'var(--bg-sunken)',
              borderRadius: 'var(--radius-1)',
            }}
          />
        </div>
      ))}
    </div>
  );
}

// ── OperatorsView ─────────────────────────────────────────────────────────────

export function OperatorsView() {
  // Filter state — all write to URL via replace:true
  const [mode, setMode] = useEnumParam('mode', 'all', ['all', 'train', 'frozen']);
  const [harness, setHarness] = useQueryParam('harness', '');
  const [minVerdicts, setMinVerdicts] = useNumParam('minVerdicts', 5);

  // Fetch network data to populate harness dropdown
  const { data: networkData } = useNetwork();
  const harnessOptions = networkData?.composition.byHarness.map((h) => h.value) ?? [];

  // Fetch operators with active filters
  const { data, isLoading, isError } = useOperators({
    minVerdicts,
    mode: mode === 'all' ? undefined : mode,
    harness: harness || undefined,
  });

  const appliedFilters = data?.appliedFilters;

  return (
    <div
      style={{
        padding: '40px 28px 80px',
        display: 'flex',
        flexDirection: 'column',
        gap: 28,
      }}
    >
      {/* ── Page heading ── */}
      <div>
        <h1
          style={{
            fontFamily: 'var(--font-display)',
            fontStyle: 'italic',
            fontSize: 'var(--text-3xl)',
            lineHeight: 1.05,
            color: 'var(--fg)',
            margin: 0,
            marginBottom: 6,
            fontWeight: 400,
          }}
        >
          Operators
        </h1>
        <p
          style={{
            fontFamily: 'var(--font-mono)',
            fontSize: 12,
            color: 'var(--fg-dim)',
            margin: 0,
            letterSpacing: '0.04em',
          }}
        >
          Global quality ranking across all SolverNets.
        </p>
      </div>

      {/* ── Filter bar ── */}
      <div
        style={{
          display: 'flex',
          gap: 24,
          flexWrap: 'wrap',
          alignItems: 'flex-end',
          padding: '16px 20px',
          background: 'var(--bg-elevated)',
          border: '1px solid var(--border)',
          borderRadius: 'var(--radius-3)',
        }}
      >
        {/* Mode segmented control */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          <span style={labelStyle}>Mode</span>
          <SegmentedControl
            options={[
              { label: 'All', value: 'all' },
              { label: 'Train', value: 'train' },
              { label: 'Frozen', value: 'frozen' },
            ]}
            value={mode as 'all' | 'train' | 'frozen'}
            onChange={(v) => setMode(v === 'all' ? null : v)}
          />
        </div>

        {/* Harness selector */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          <label
            htmlFor="harness-select"
            style={labelStyle}
          >
            Harness
          </label>
          <select
            id="harness-select"
            value={harness}
            onChange={(e) => setHarness(e.target.value || null)}
            style={{
              ...inputStyle,
              minWidth: 140,
              cursor: 'pointer',
            }}
            onFocus={(e) => { (e.target as HTMLSelectElement).style.borderColor = 'var(--accent)'; }}
            onBlur={(e) => { (e.target as HTMLSelectElement).style.borderColor = 'var(--border)'; }}
          >
            <option value="">All harnesses</option>
            {harnessOptions.map((h) => (
              <option key={h} value={h}>{h}</option>
            ))}
          </select>
        </div>

        {/* Min verdicts numeric input */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          <label
            htmlFor="min-verdicts-input"
            style={labelStyle}
          >
            Min verdicts
          </label>
          <input
            id="min-verdicts-input"
            type="number"
            min={0}
            step={1}
            value={minVerdicts}
            onChange={(e) => {
              const v = parseInt(e.target.value, 10);
              setMinVerdicts(Number.isFinite(v) && v >= 0 ? v : null);
            }}
            style={{
              ...inputStyle,
              width: 88,
            }}
            onFocus={(e) => { (e.target as HTMLInputElement).style.borderColor = 'var(--accent)'; }}
            onBlur={(e) => { (e.target as HTMLInputElement).style.borderColor = 'var(--border)'; }}
          />
        </div>

        {/* Clear-all shortcut when any non-default filter is active */}
        {(mode !== 'all' || harness !== '' || minVerdicts !== 5) && (
          <button
            onClick={() => {
              setMode(null);
              setHarness(null);
              setMinVerdicts(null);
            }}
            style={{
              fontFamily: 'var(--font-mono)',
              fontSize: 10,
              letterSpacing: '0.10em',
              textTransform: 'uppercase',
              background: 'transparent',
              border: '1px dashed var(--border)',
              borderRadius: 'var(--radius-1)',
              color: 'var(--fg-dim)',
              padding: '5px 12px',
              cursor: 'pointer',
              alignSelf: 'flex-end',
              transition: 'border-color var(--dur-fast) var(--ease-linear), color var(--dur-fast) var(--ease-linear)',
            }}
            onMouseEnter={(e) => {
              (e.currentTarget as HTMLButtonElement).style.color = 'var(--fg-muted)';
              (e.currentTarget as HTMLButtonElement).style.borderColor = 'var(--border-strong)';
            }}
            onMouseLeave={(e) => {
              (e.currentTarget as HTMLButtonElement).style.color = 'var(--fg-dim)';
              (e.currentTarget as HTMLButtonElement).style.borderColor = 'var(--border)';
            }}
          >
            Clear filters
          </button>
        )}
      </div>

      {/* ── Applied-filter chips ── */}
      {appliedFilters && (appliedFilters.mode || appliedFilters.harness) && (
        <div
          style={{
            display: 'flex',
            gap: 8,
            flexWrap: 'wrap',
            alignItems: 'center',
          }}
        >
          <span
            style={{
              fontFamily: 'var(--font-mono)',
              fontSize: 9,
              letterSpacing: '0.14em',
              textTransform: 'uppercase',
              color: 'var(--fg-dim)',
            }}
          >
            Filtered by
          </span>
          {appliedFilters.mode && (
            <span
              style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}
            >
              <StatusChip
                kind={appliedFilters.mode as 'train' | 'frozen'}
                label={`mode: ${appliedFilters.mode}`}
              />
              <button
                onClick={() => setMode(null)}
                style={{
                  background: 'none',
                  border: 'none',
                  cursor: 'pointer',
                  color: 'var(--fg-dim)',
                  fontFamily: 'var(--font-mono)',
                  fontSize: 11,
                  padding: '0 2px',
                  lineHeight: 1,
                }}
                aria-label="Clear mode filter"
              >
                x
              </button>
            </span>
          )}
          {appliedFilters.harness && (
            <span
              style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}
            >
              <StatusChip kind="unknown" label={`harness: ${appliedFilters.harness}`} />
              <button
                onClick={() => setHarness(null)}
                style={{
                  background: 'none',
                  border: 'none',
                  cursor: 'pointer',
                  color: 'var(--fg-dim)',
                  fontFamily: 'var(--font-mono)',
                  fontSize: 11,
                  padding: '0 2px',
                  lineHeight: 1,
                }}
                aria-label="Clear harness filter"
              >
                x
              </button>
            </span>
          )}
        </div>
      )}

      {/* ── Loading state ── */}
      {isLoading && (
        <>
          <FilterSkeleton />
          <LeaderboardSkeleton />
        </>
      )}

      {/* ── Error state ── */}
      {isError && (
        <div
          style={{
            fontFamily: 'var(--font-mono)',
            fontSize: 'var(--text-sm)',
            color: 'var(--break-red)',
            border: '1px solid var(--break-red)',
            borderRadius: 'var(--radius-2)',
            padding: '20px 24px',
          }}
        >
          Failed to load operators.
        </div>
      )}

      {/* ── Leaderboard ── */}
      {data && (
        <Leaderboard
          ranked={data.ranked}
          lowVolume={data.lowVolume}
          minVerdicts={data.minVerdicts}
          meta={data.meta}
        />
      )}

      <StatusBar
        lastIndexedBlock={data?.lastIndexedBlock}
        lastIndexedAt={data?.lastIndexedAt}
        degraded={isError}
      />
    </div>
  );
}
