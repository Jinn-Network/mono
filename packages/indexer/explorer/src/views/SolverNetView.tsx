/**
 * SolverNetView — per-SolverNet detail with the Learning panel.
 *
 * After the /explore merge (refactor #676), this view owns the full engine
 * control surface. The progressive-disclosure filter chrome (spec §3) is
 * composed of FilterChipStrip + GroupByDropdown + PersistentControlsRow +
 * AddFilterPopover above the chart; the WINDOW SegmentedControl sits inline
 * next to the chart caption (it's chart-shaping, not slice-defining), and the
 * ⚙ Slice settings popover holds Raw + Reset. The active-slice chip strip
 * stays below the chrome. The legacy /explore/<cid> route redirects here
 * preserving its query string.
 *
 * Gold element: the big headline resolved-rate (ONE gold per surface rule).
 * URL state owned here: window, group, filters, include, bucket, curveMode, board.
 * Legacy `?k=N` query is migrated once-per-mount to `?window=N`.
 */

import { useEffect, useRef, useState } from 'react';
import { Link, useParams, useSearchParams } from 'wouter';
import {
  useSlice,
  useSolverNet,
  type SliceParams,
  type SliceResponseLeaderboardRow,
} from '../lib/api';
import type {
  LeaderboardRankedRow,
  LeaderboardLowVolumeRow,
} from '../components/Leaderboard';
import { StatusBar } from '../components/StatusBar';
import { Card } from '../components/Card';
import { Kpi, KpiRow } from '../components/Kpi';
import { StatusChip } from '../components/StatusChip';
import { Milestone2GateSection } from '../components/Milestone2GateSection';
import {
  LearningCurve,
  LEARNING_CURVE_SERIES_COLORS,
} from '../components/LearningCurve';
import { CheckpointTimeline } from '../components/CheckpointTimeline';
import { FreezeIntegrity } from '../components/FreezeIntegrity';
import { Leaderboard } from '../components/Leaderboard';
import { SegmentedControl } from '../components/SegmentedControl';
import { FilterChipStrip } from '../components/FilterChipStrip';
import { GroupByDropdown } from '../components/GroupByDropdown';
import { PersistentControlsRow } from '../components/PersistentControlsRow';
import { AddFilterPopover } from '../components/AddFilterPopover';
import { SliceSettingsPopover } from '../components/SliceSettingsPopover';
import { ChartWithMilestoneMark } from '../components/SliceChrome';
import {
  useNumParam,
  useEnumParam,
  useGroupParam,
  useFilterParams,
  FILTER_DIMS,
  type FilterDim,
  type FilterMap,
} from '../lib/url-state';
import { useCountUp } from '../hooks/useCountUp';
import { pct, int, shortAddr, shortCid } from '../lib/format';
import { MILESTONE2_MANIFEST_CID } from '../lib/milestone2';

// ── Sentinel & constants ─────────────────────────────────────────────────────

const WINDOW_ALL = 999999;
const DEFAULT_WINDOW = 50;
const MAX_SERIES = 5;

// WINDOW SegmentedControl options — kept inline next to the chart caption.
// The new filter chrome (spec §3) removes the GROUP BY / FILTERS labels from
// the panel but leaves window inline because it's a chart-shaping control,
// not a slice-defining one.
const WINDOW_OPTIONS = [
  { label: '20', value: '20' },
  { label: '30', value: '30' },
  { label: '50', value: '50' },
  { label: '100', value: '100' },
  { label: 'ALL', value: String(WINDOW_ALL) },
];

// ── Slice leaderboard → Leaderboard component row adapter ────────────────────

// Phase 2 ships an unpartitioned list (no ranked/lowVolume split). We render
// every row as "ranked" and synthesize the rank from position; `lowVolume` is
// always empty. settledContribution isn't carried on SliceResponse; we surface
// attempts as a best-effort proxy (the column is informational).
function toRankedRow(
  r: SliceResponseLeaderboardRow,
  idx: number,
): LeaderboardRankedRow {
  return {
    rank: idx + 1,
    operator: r.operator,
    attempts: r.attempts,
    settledContribution: r.attempts,
    verdictsTotal: r.verdictsTotal,
    verdictsPass: r.verdictsPass,
    resolvedRate: r.resolvedRate,
    jinnEarned: '0',
    // SliceResponseLeaderboardRow has no `active` flag (slice rows pre-date
    // the active-operator surface). Default to false; the canonical surface
    // lives on /operators and the network view.
    active: false,
    dominantMode: r.dominantMode,
    dominantHarness: r.dominantHarness,
  };
}

// ── Skeleton ──────────────────────────────────────────────────────────────────

function SkeletonBlock({
  height = 80,
  label,
}: {
  height?: number;
  label?: string;
}) {
  return (
    <div
      style={{
        background: 'var(--bg-elevated)',
        border: '1px solid var(--border)',
        borderRadius: 'var(--radius-3)',
        height,
        padding: 24,
        display: 'flex',
        flexDirection: 'column',
        gap: 12,
      }}
    >
      {label && (
        <div
          style={{
            fontFamily: 'var(--font-mono)',
            fontSize: 9,
            letterSpacing: '0.14em',
            textTransform: 'uppercase',
            color: 'var(--fg-dim)',
          }}
        >
          {label}
        </div>
      )}
      <div
        style={{
          flex: 1,
          background: 'var(--bg-sunken)',
          borderRadius: 'var(--radius-1)',
        }}
      />
    </div>
  );
}

// ── SolverNetView ─────────────────────────────────────────────────────────────

export function SolverNetView() {
  const params = useParams<{ cid: string }>();
  const cid = decodeURIComponent(params?.cid ?? '');
  const [searchParams, setSearchParams] = useSearchParams();

  // URL state — the explore control surface owns these.
  const [window, setWindow] = useNumParam('window', DEFAULT_WINDOW);
  const [group, setGroup] = useGroupParam();
  const [filters, setFilters] = useFilterParams();
  const [include, setInclude] = useEnumParam('include', 'enriched', [
    'enriched',
    'raw',
  ]);
  const [bucket] = useEnumParam('bucket', 'auto', [
    'auto',
    'per-block',
    'per-day',
    'per-week',
  ]);
  const [curveMode, setCurveMode] = useEnumParam('curveMode', 'rolling', [
    'rolling',
    'buckets',
  ]);
  const [board, setBoard] = useEnumParam('board', 'train', ['train', 'frozen']);

  // Progressive-disclosure filter chrome (spec §3) — popover open state.
  const [addFilterOpen, setAddFilterOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  // #687 bug 2: lift the add-filter popover's picked-dim state up so we can
  // fire a lookup slice for the picked dim when it differs from the current
  // group. Without this, the popover dead-ends on cold landing because the
  // primary slice has no per-dim values to surface.
  const [pickedDim, setPickedDim] = useState<FilterDim | null>(null);

  // Bug fix 6.1 (spec §6.1): when filter[<dim>] is set AND group === <dim>,
  // the group is degenerate (one series, equals what group=none would show).
  // Auto-clear group to keep the URL clean and the chart correctly rendered.
  useEffect(() => {
    if (group !== 'none' && filters[group] && filters[group]!.length > 0) {
      setGroup('none');
    }
  }, [group, filters, setGroup]);

  // Legacy ?k=N → ?window=N migration. Fires once per mount (URL stays at the
  // current location for the rest of the session unless the user navigates).
  const migratedRef = useRef(false);
  useEffect(() => {
    if (migratedRef.current) return;
    migratedRef.current = true;
    const kRaw = searchParams.get('k');
    if (kRaw === null) return;
    const shouldSetWindow = !searchParams.has('window');
    setSearchParams(
      (prev) => {
        const next = new URLSearchParams(prev);
        next.delete('k');
        if (shouldSetWindow) next.set('window', kRaw);
        return next;
      },
      { replace: true },
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const includeUnenriched = include === 'raw';
  const hasExplicitSlice =
    group !== 'none' ||
    Object.keys(filters).length > 0 ||
    searchParams.has('window');
  const hasFilters = Object.keys(filters).length > 0;

  // Engine consumer. SolverNetView is now the engine's reference consumer
  // for the full surface — no more parallel /explore view.
  const sliceParams: SliceParams = {
    manifestDigest: cid,
    group,
    filter: filters,
    includeUnenriched,
    bucket: bucket as SliceParams['bucket'],
    window: window >= WINDOW_ALL ? undefined : window,
  };
  const {
    data: slice,
    isLoading: sliceLoading,
    isError: sliceError,
  } = useSlice(sliceParams);

  // #687 bug 2 — Lookup slice for the add-filter popover. Fires only when the
  // user opens the popover and picks a dim that differs from the current
  // group; otherwise we already have the values in `slice.series`.
  const needsDimLookup = pickedDim !== null && pickedDim !== group;
  const lookupSliceParams: SliceParams = needsDimLookup
    ? { ...sliceParams, group: pickedDim as FilterDim }
    : sliceParams;
  const dimLookup = useSlice(lookupSliceParams, { enabled: needsDimLookup });
  const dimValues: string[] = (() => {
    if (pickedDim === null) return [];
    if (pickedDim === group) {
      // Primary slice already groups on this dim — read values directly.
      return (slice?.series ?? [])
        .map((s) => s.groupValue)
        .filter((v): v is string => v !== null && v !== '');
    }
    return (dimLookup.data?.series ?? [])
      .map((s) => s.groupValue)
      .filter((v): v is string => v !== null && v !== '');
  })();
  const dimLoading = needsDimLookup && dimLookup.isLoading;

  // useSolverNet still serves the legacy metadata fields (name, status,
  // launcherAgentId, checkpointTimeline, freezeIntegrity, lastIndexed*). The
  // meta endpoint's result is independent of window / bucket — no need to
  // wire those args anymore.
  const {
    data: meta,
    isLoading: metaLoading,
    isError: metaError,
  } = useSolverNet(cid);

  // Milestone 2 gate (#647) renders only on the M2 SolverNet; the section owns
  // its own pinned slice so the extra fetch never touches other nets.
  const isMilestone2Net = cid === MILESTONE2_MANIFEST_CID;

  const isLoading = sliceLoading || metaLoading;
  const isError = sliceError || metaError;

  // Animate the gold headline resolved-rate; respects prefers-reduced-motion.
  // Bug fix 6.2 (spec §6.2): KPI hero ALWAYS reflects the slice's aggregate
  // `kpis.resolvedRate`, regardless of grouping. The series array shapes the
  // chart; the headline reflects the slice as a whole.
  const animatedRate = useCountUp(slice?.kpis.resolvedRate ?? 0, 400);

  return (
    <div
      style={{
        padding: '40px 28px 80px',
        display: 'flex',
        flexDirection: 'column',
        gap: 28,
      }}
    >
      {/* Breadcrumb */}
      <div
        style={{
          fontFamily: 'var(--font-mono)',
          fontSize: 'var(--text-xs)',
          letterSpacing: '0.08em',
          color: 'var(--fg-dim)',
          display: 'flex',
          alignItems: 'center',
          gap: 8,
        }}
      >
        <Link
          href="/solvernets"
          style={{
            color: 'var(--fg-dim)',
            textDecoration: 'none',
          }}
        >
          SolverNets
        </Link>
        <span aria-hidden="true">/</span>
        <span
          style={{
            color: 'var(--fg-muted)',
            fontVariantNumeric: 'tabular-nums',
          }}
        >
          {cid ? shortCid(cid) : '…'}
        </span>
      </div>

      {/* Loading state */}
      {isLoading && (
        <>
          {/* Big headline skeleton */}
          <div
            style={{
              height: 100,
              background: 'var(--bg-elevated)',
              border: '1px solid var(--border)',
              borderRadius: 'var(--radius-3)',
              padding: 24,
            }}
          />
          <SkeletonBlock height={60} />
          <SkeletonBlock height={280} label="Learning curve" />
          <SkeletonBlock height={120} label="Checkpoint timeline" />
          <SkeletonBlock height={100} label="Freeze integrity" />
        </>
      )}

      {/* Error / unknown state */}
      {isError && (
        <div
          style={{
            fontFamily: 'var(--font-mono)',
            fontSize: 'var(--text-sm)',
            color: 'var(--break-red)',
            border: '1px solid var(--break-red)',
            borderRadius: 'var(--radius-2)',
            padding: '20px 24px',
            display: 'flex',
            flexDirection: 'column',
            gap: 12,
          }}
        >
          <div>Unknown SolverNet or failed to load.</div>
          <Link
            href="/solvernets"
            style={{
              color: 'var(--accent)',
              fontFamily: 'var(--font-mono)',
              fontSize: 12,
            }}
          >
            Back to SolverNets list
          </Link>
        </div>
      )}

      {/* Data — gated on slice (engine source). meta is best-effort metadata. */}
      {slice && (
        <>
          {/* ── Header: cid + status + launcher ── */}
          <div
            style={{
              display: 'flex',
              alignItems: 'flex-start',
              justifyContent: 'space-between',
              flexWrap: 'wrap',
              gap: 16,
            }}
          >
            <div>
              <h1
                style={{
                  fontFamily: 'var(--font-display)',
                  fontStyle: 'italic',
                  fontSize: 'var(--text-3xl)',
                  lineHeight: 1.05,
                  color: 'var(--fg)',
                  margin: 0,
                  marginBottom: 8,
                  fontWeight: 400,
                }}
              >
                {meta?.name || shortCid(cid)}
              </h1>
              {/* Subtitle: cid (when name is present) + optional description.
                  Both empty until IPFS manifest enrichment lands. */}
              {meta?.name && (
                <div
                  style={{
                    fontFamily: 'var(--font-mono)',
                    fontSize: 11,
                    color: 'var(--fg-dim)',
                    marginBottom: 8,
                    letterSpacing: '0.04em',
                  }}
                >
                  {shortCid(cid)}
                </div>
              )}
              {meta?.description && (
                <div
                  style={{
                    fontFamily: 'var(--font-mono)',
                    fontSize: 'var(--text-sm)',
                    color: 'var(--fg-muted)',
                    marginBottom: 12,
                    maxWidth: 720,
                    lineHeight: 1.5,
                  }}
                >
                  {meta.description}
                </div>
              )}
              <div
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 12,
                  flexWrap: 'wrap',
                }}
              >
                {meta?.status && (
                  <StatusChip
                    kind={meta.status as 'launched' | 'paused' | 'retired'}
                    label={meta.status}
                  />
                )}
                {meta?.launcherAgentId && (
                  <span
                    style={{
                      fontFamily: 'var(--font-mono)',
                      fontSize: 11,
                      color: 'var(--fg-dim)',
                    }}
                  >
                    Launcher: {shortAddr(meta.launcherAgentId)}
                  </span>
                )}
              </div>
            </div>

            {/* ── THE headline: GOLD resolved-rate (ONE accent per surface) ── */}
            <div style={{ textAlign: 'right' }}>
              <div
                className="data"
                data-testid="kpi-hero-resolved-rate"
                style={{
                  fontFamily: 'var(--font-display)',
                  fontSize: 'var(--text-6xl)',
                  lineHeight: 0.9,
                  color: 'var(--accent-gold)',
                  fontVariantNumeric: 'tabular-nums',
                  fontFeatureSettings: '"tnum" 1',
                }}
                aria-label={`Resolved rate: ${pct(slice.kpis.resolvedRate)}`}
              >
                {slice.kpis.resolvedRate === null ? '—' : pct(animatedRate)}
              </div>
              <div
                style={{
                  fontFamily: 'var(--font-mono)',
                  fontSize: 9,
                  letterSpacing: '0.14em',
                  textTransform: 'uppercase',
                  color: 'var(--fg-dim)',
                  marginTop: 6,
                }}
              >
                Verdict-success rate
              </div>
            </div>
          </div>

          {/* ── Supporting KPIs ──
              tasksPosted / tasksSettled stay on the legacy meta endpoint;
              attempts / verdicts / verdictsPass come from the slice KPIs. */}
          <KpiRow>
            <Kpi label="Tasks posted" value={int(meta?.tasksPosted ?? 0)} />
            <Kpi label="Settled" value={int(meta?.tasksSettled ?? 0)} />
            <Kpi label="Attempts" value={int(slice.kpis.attempts)} />
            <Kpi label="Verdicts" value={int(slice.kpis.verdicts)} />
            <Kpi label="Verdicts passed" value={int(slice.kpis.verdictsPass)} />
          </KpiRow>

          {/* ── Milestone 2 gate (#647) — only on the M2 SolverNet ── */}
          {isMilestone2Net && <Milestone2GateSection cid={cid} />}

          {/* ── Progressive-disclosure filter chrome (spec §3) ──
              - Empty filters: PersistentControlsRow (+ filter chip + Group by ▾).
              - Active filters: FilterChipStrip on the left, GroupByDropdown
                right-aligned, both inside a hairline-bordered band.
              The ⚙ settings popover lives in the chart-caption row below. */}
          <div style={{ position: 'relative' }}>
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
                    const next: FilterMap = { ...filters };
                    const arr = (next[dim] ?? []).filter((v) => v !== value);
                    if (arr.length === 0) delete next[dim];
                    else next[dim] = arr;
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
              <div
                style={{
                  position: 'absolute',
                  top: '100%',
                  right: 0,
                  zIndex: 10,
                  marginTop: 4,
                }}
              >
                <AddFilterPopover
                  pickedDim={pickedDim}
                  onPickDim={setPickedDim}
                  onBack={() => setPickedDim(null)}
                  values={dimValues}
                  loading={dimLoading}
                  onSelect={(dim, value) => {
                    const next: FilterMap = { ...filters };
                    next[dim] = [...(next[dim] ?? []), value];
                    setFilters(next);
                    setAddFilterOpen(false);
                    setPickedDim(null);
                  }}
                  onDismiss={() => {
                    setAddFilterOpen(false);
                    setPickedDim(null);
                  }}
                />
              </div>
            ) : null}
          </div>

          {/* ── Learning curve ── */}
          <Card title="Learning curve">
            {/* Chart-caption row:
                  - View (Rolling / Buckets) — only when group=none.
                  - Window (20 / 30 / 50 / 100 / ALL) — always.
                  - ⚙ Slice settings — opens SliceSettingsPopover (Raw + Reset).
                Window stays here because it's a chart-shaping control (how much
                of the trailing history to render), not a slice-defining one. */}
            <div
              style={{
                position: 'relative',
                display: 'flex',
                alignItems: 'center',
                gap: 16,
                flexWrap: 'wrap',
                marginBottom: 16,
              }}
            >
              {group === 'none' && (
                <div
                  style={{ display: 'flex', alignItems: 'center', gap: 8 }}
                >
                  <span
                    style={{
                      fontFamily: 'var(--font-mono)',
                      fontSize: 10,
                      letterSpacing: '0.10em',
                      textTransform: 'uppercase',
                      color: 'var(--fg-dim)',
                    }}
                  >
                    View
                  </span>
                  <SegmentedControl
                    options={[
                      { label: 'Rolling', value: 'rolling' },
                      { label: 'Buckets', value: 'buckets' },
                    ]}
                    value={curveMode as 'rolling' | 'buckets'}
                    onChange={(v) => setCurveMode(v)}
                  />
                </div>
              )}
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <span
                  style={{
                    fontFamily: 'var(--font-mono)',
                    fontSize: 10,
                    letterSpacing: '0.10em',
                    textTransform: 'uppercase',
                    color: 'var(--fg-dim)',
                  }}
                >
                  Window
                </span>
                <SegmentedControl
                  options={WINDOW_OPTIONS}
                  value={String(window >= WINDOW_ALL ? WINDOW_ALL : window)}
                  onChange={(v) => setWindow(Number(v))}
                />
              </div>
              <div style={{ marginLeft: 'auto', position: 'relative' }}>
                <button
                  type="button"
                  aria-label="Slice settings"
                  aria-expanded={settingsOpen}
                  onClick={() => setSettingsOpen((p) => !p)}
                  style={{
                    border: '1px solid var(--border)',
                    borderRadius: 'var(--radius-pill)',
                    background: 'transparent',
                    color: 'var(--fg-dim)',
                    padding: '3px 9px',
                    fontFamily: 'var(--font-mono)',
                    fontSize: 11,
                    lineHeight: 1,
                    cursor: 'pointer',
                  }}
                >
                  ⚙
                </button>
                {settingsOpen ? (
                  <div
                    style={{
                      position: 'absolute',
                      top: 'calc(100% + 4px)',
                      right: 0,
                      zIndex: 10,
                    }}
                  >
                    <SliceSettingsPopover
                      includeRaw={includeUnenriched}
                      onDismiss={() => setSettingsOpen(false)}
                      onIncludeRawChange={(v) => {
                        setInclude(v ? 'raw' : null);
                        setSettingsOpen(false);
                      }}
                      onReset={() => {
                        // Atomic clear — each per-hook setter has its own
                        // stale `tempSearchParams` closure inside wouter's
                        // useSearchParams (last call wins). Drop straight to
                        // setSearchParams with all slice keys deleted in a
                        // single update so the resulting URL is just
                        // `/solvernet/<cid>` (spec §8 acceptance).
                        setSearchParams(
                          (prev) => {
                            const next = new URLSearchParams(prev);
                            for (const dim of FILTER_DIMS) {
                              next.delete(`filter[${dim}]`);
                            }
                            next.delete('group');
                            next.delete('window');
                            next.delete('include');
                            return next;
                          },
                          { replace: true },
                        );
                        setSettingsOpen(false);
                      }}
                    />
                  </div>
                ) : null}
              </div>
            </div>

            {group === 'none' ? (
              curveMode === 'rolling' ? (
                <ChartWithMilestoneMark
                  rolling={slice.series[0]?.rolling ?? []}
                  window={
                    window >= WINDOW_ALL
                      ? slice.series[0]?.rolling.length ?? 0
                      : window
                  }
                  showMilestoneChrome={hasExplicitSlice}
                  baseline={slice.kpis.resolvedRate ?? undefined}
                />
              ) : (
                <LearningCurve
                  buckets={slice.series[0]?.buckets ?? []}
                  rolling={slice.series[0]?.rolling ?? []}
                  mode="buckets"
                />
              )
            ) : (
              <div
                style={{
                  display: 'flex',
                  flexDirection: 'column',
                  gap: 12,
                }}
              >
                <LearningCurve
                  buckets={[]}
                  rolling={[]}
                  mode="rolling"
                  series={slice.series.slice(0, MAX_SERIES).map((s, i) => ({
                    rolling: s.rolling,
                    label: s.groupValue ?? `series ${i + 1}`,
                    color: LEARNING_CURVE_SERIES_COLORS[i] ?? '#7aa7dc',
                  }))}
                  onLegendClick={(label) => {
                    // Filter dim mirrors the current group.
                    const dim = group as keyof FilterMap;
                    const current = filters[dim] ?? [];
                    if (current.includes(label)) return;
                    setFilters({ ...filters, [dim]: [...current, label] });
                  }}
                />
                <div
                  style={{
                    fontFamily: 'var(--font-mono)',
                    fontSize: 11,
                    color: 'var(--fg-dim)',
                    letterSpacing: '0.10em',
                  }}
                >
                  {slice.series.length} series · grouped by {group}
                  {slice.series.length > MAX_SERIES &&
                    ` · showing first ${MAX_SERIES}`}
                </div>
              </div>
            )}

            {group === 'none' && (
              <div
                style={{
                  fontFamily: 'var(--font-mono)',
                  fontSize: 10,
                  color: 'var(--fg-dim)',
                  marginTop: 10,
                  letterSpacing: '0.06em',
                }}
              >
                {curveMode === 'rolling'
                  ? `Rolling resolved-rate over the last ${
                      window >= WINDOW_ALL ? 'all' : window
                    } tasks`
                  : 'Resolved-rate per bucket'}
              </div>
            )}
          </Card>

          {/* ── Checkpoint timeline ── (legacy meta only) */}
          {meta?.checkpointTimeline && (
            <Card title="Checkpoint timeline">
              <CheckpointTimeline data={meta.checkpointTimeline} />
            </Card>
          )}

          {/* ── Freeze integrity ── (legacy meta only) */}
          {meta?.freezeIntegrity && (
            <Card title="Freeze integrity">
              <FreezeIntegrity data={meta.freezeIntegrity} />
            </Card>
          )}

          {/* ── Leaderboards ── */}
          <Card title="Leaderboards">
            {/* Board toggle */}
            <div style={{ marginBottom: 20 }}>
              <SegmentedControl
                options={[
                  { label: 'Train', value: 'train' },
                  { label: 'Frozen', value: 'frozen' },
                ]}
                value={board as 'train' | 'frozen'}
                onChange={(v) => setBoard(v)}
              />
            </div>

            {(() => {
              const rows =
                board === 'train'
                  ? slice.leaderboard.train
                  : slice.leaderboard.frozen;
              const ranked: LeaderboardRankedRow[] = rows.map(toRankedRow);
              const lowVolume: LeaderboardLowVolumeRow[] = [];
              return (
                <Leaderboard
                  ranked={ranked}
                  lowVolume={lowVolume}
                  compact
                  onOperatorClick={(op) => {
                    const current = filters.operator ?? [];
                    if (current.includes(op)) return;
                    setFilters({ ...filters, operator: [...current, op] });
                  }}
                />
              );
            })()}
          </Card>
        </>
      )}

      <StatusBar
        lastIndexedBlock={meta?.lastIndexedBlock}
        lastIndexedAt={meta?.lastIndexedAt}
        degraded={Boolean(isError)}
      />
    </div>
  );
}
