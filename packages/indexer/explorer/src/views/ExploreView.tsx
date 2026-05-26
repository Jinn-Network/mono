/**
 * ExploreView — `/explore/:cid` — parameterized cousin of SolverNetView.
 *
 * Composes:
 *   - ExploreControls (group-by / filter pills / raw toggle / window selector)
 *   - LearningCurve (one series when group=none, up to 5 when grouped)
 *   - Active-slice chip strip (JetBrains Mono caps)
 *   - Below-floor empty state when rolling.length < 130
 *   - t-99 hairline label when rolling.length >= 130 (verdict-index axis)
 *
 * URL state owned by this view via:
 *   useNumParam('window', 30)
 *   useGroupParam()
 *   useFilterParams()
 *   useEnumParam('include', 'enriched', ['enriched', 'raw'])
 *   useEnumParam('bucket', 'auto', ['auto', 'per-block', 'per-day', 'per-week'])
 *
 * Why parallel to SolverNetView (not a wrapper): per spec §5.3 / design note §1.
 * The control surface diverges enough that wrapping would force SolverNetView
 * into two personalities; reusing primitives (Card / LearningCurve / Leaderboard /
 * SegmentedControl) is the lighter-touch path.
 */

import { Link, useParams } from 'wouter';
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
import {
  LearningCurve,
  LEARNING_CURVE_SERIES_COLORS,
} from '../components/LearningCurve';
import { Leaderboard } from '../components/Leaderboard';
import { ExploreControls } from '../components/ExploreControls';
import {
  useNumParam,
  useEnumParam,
  useGroupParam,
  useFilterParams,
  type FilterMap,
} from '../lib/url-state';
import { int, shortCid } from '../lib/format';

const ROLLING_FLOOR = 130;
const MILESTONE_OFFSET = 100;
const WINDOW_ALL = 999999;
const MAX_SERIES = 5;
const DEFAULT_EXPLORE_WINDOW = 30;

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
    jinnEarned: r.jinnEarned,
    dominantMode: r.dominantMode,
    dominantHarness: r.dominantHarness,
  };
}

/**
 * Renders LearningCurve in rolling mode + the milestone hairline label.
 *
 * We do not modify uPlot opts here — the hairline label is a sibling DOM node
 * captioning the t-99 anchor. uPlot's auto-ticks land on round numbers when
 * xs is [0..N], which is the verdict-index axis the milestone wants.
 */
function ChartWithMilestoneMark({
  rolling,
  window,
}: { rolling: number[]; window: number }) {
  if (rolling.length < ROLLING_FLOOR) {
    return (
      <div
        style={{
          background: 'var(--bg-elevated)',
          border: '1px solid var(--border)',
          borderRadius: 'var(--radius-3)',
          padding: 28,
          fontFamily: 'var(--font-mono)',
          fontSize: 11,
          letterSpacing: '0.14em',
          textTransform: 'uppercase',
          color: 'var(--fg-dim)',
          textAlign: 'center',
        }}
        data-testid="explore-below-floor"
      >
        Need 130 envelope-enriched verdicts · have {int(rolling.length)}
      </div>
    );
  }

  const markIdx = rolling.length - MILESTONE_OFFSET; // == "99 verdicts back" anchor

  return (
    <div style={{ position: 'relative' }}>
      <LearningCurve buckets={[]} rolling={rolling} mode="rolling" />
      {/* Below-axis caption identifying the t-99 anchor. The visual hairline
          rides on the uPlot grid; the label here is the readable callout. */}
      <div
        style={{
          marginTop: 6,
          display: 'flex',
          justifyContent: 'space-between',
          fontFamily: 'var(--font-mono)',
          fontSize: 11,
          color: 'var(--fg-dim)',
          letterSpacing: '0.06em',
        }}
      >
        <span>
          Trailing-{window} over {rolling.length} envelope-enriched verdicts
        </span>
        <span style={{ color: 'var(--wane)' }}>
          t − 99 at index {markIdx}
        </span>
      </div>
    </div>
  );
}

function ActiveSliceChips({
  group,
  filters,
  window,
}: {
  group: string;
  filters: FilterMap;
  window: number;
}) {
  const chips: string[] = [];
  if (group !== 'none') chips.push(`group:${group}`);
  for (const [dim, vals] of Object.entries(filters)) {
    if (vals) for (const v of vals) chips.push(`${dim}:${v}`);
  }
  chips.push(`window:${window}`);
  return (
    <div
      style={{
        display: 'flex',
        flexWrap: 'wrap',
        gap: 8,
        fontFamily: 'var(--font-mono)',
        fontSize: 11,
        color: 'var(--fg-muted)',
        letterSpacing: '0.10em',
        textTransform: 'uppercase',
      }}
      data-testid="active-slice-chips"
    >
      {chips.map((c) => (
        <span
          key={c}
          style={{
            padding: '2px 8px',
            border: '1px solid var(--border)',
            borderRadius: 'var(--radius-pill)',
          }}
        >
          {c}
        </span>
      ))}
    </div>
  );
}

export function ExploreView() {
  const params = useParams<{ cid: string }>();
  const cid = decodeURIComponent(params?.cid ?? '');

  // /explore defaults to window=30 (milestone-shape). SolverNetView still
  // uses k=50; the engine fallback (DEFAULT_ROLLING_K=50) only kicks in when
  // window is omitted from the wire request. Here we always pass an explicit
  // window so the chart and selector agree.
  const [window, setWindow] = useNumParam('window', DEFAULT_EXPLORE_WINDOW);
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

  const includeUnenriched = include === 'raw';

  const sliceParams: SliceParams = {
    manifestDigest: cid,
    group,
    filter: filters,
    includeUnenriched,
    bucket: bucket as SliceParams['bucket'],
    window: window >= WINDOW_ALL ? undefined : window, // ALL → omit, server defaults
  };

  const {
    data: slice,
    isLoading: sliceLoading,
    isError: sliceError,
  } = useSlice(sliceParams);
  const { data: meta } = useSolverNet(cid);

  const isError = sliceError;

  return (
    <div
      style={{
        padding: '40px 28px 80px',
        display: 'flex',
        flexDirection: 'column',
        gap: 24,
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
          href={`/solvernet/${encodeURIComponent(cid)}`}
          style={{ color: 'var(--fg-dim)', textDecoration: 'none' }}
        >
          {meta?.name || shortCid(cid)}
        </Link>
        <span aria-hidden="true">/</span>
        <span style={{ color: 'var(--fg-muted)' }}>Explore</span>
      </div>

      {/* Header */}
      <div>
        <h1
          style={{
            fontFamily: 'var(--font-display)',
            fontStyle: 'italic',
            fontSize: 'var(--text-3xl)',
            lineHeight: 1.05,
            color: 'var(--fg)',
            margin: 0,
            marginBottom: 12,
            fontWeight: 400,
          }}
        >
          Explore {meta?.name || shortCid(cid)}
        </h1>
        <ActiveSliceChips group={group} filters={filters} window={window} />
      </div>

      {/* Error */}
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
          Unknown SolverNet or failed to load.
        </div>
      )}

      {/* Controls */}
      <ExploreControls
        group={group}
        onGroupChange={setGroup}
        filters={filters}
        onFiltersChange={setFilters}
        includeRaw={includeUnenriched}
        onIncludeRawChange={(v) => setInclude(v ? 'raw' : null)}
        window={window}
        onWindowChange={(v) => setWindow(v)}
      />

      {/* Chart */}
      <Card title="Learning curve">
        {sliceLoading ? (
          <div
            style={{
              height: 220,
              background: 'var(--bg-elevated)',
              border: '1px solid var(--border)',
              borderRadius: 'var(--radius-2)',
            }}
          />
        ) : slice && group === 'none' ? (
          <ChartWithMilestoneMark
            rolling={slice.series[0]?.rolling ?? []}
            window={
              window >= WINDOW_ALL
                ? slice.series[0]?.rolling.length ?? 0
                : window
            }
          />
        ) : slice ? (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
            <LearningCurve
              buckets={[]}
              rolling={[]}
              mode="rolling"
              series={slice.series.slice(0, MAX_SERIES).map((s, i) => ({
                rolling: s.rolling,
                label: s.groupValue ?? `series ${i + 1}`,
                color: LEARNING_CURVE_SERIES_COLORS[i] ?? '#7aa7dc',
              }))}
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
              {slice.series.length > MAX_SERIES && ` · showing first ${MAX_SERIES}`}
            </div>
          </div>
        ) : null}
      </Card>

      {/* Leaderboards */}
      {slice && (
        <Card title="Leaderboards">
          {(() => {
            const rows = slice.leaderboard.train;
            const ranked: LeaderboardRankedRow[] = rows.map(toRankedRow);
            const lowVolume: LeaderboardLowVolumeRow[] = [];
            return (
              <Leaderboard
                ranked={ranked}
                lowVolume={lowVolume}
                meta={{ jinnAttribution: 'pending' }}
                compact
              />
            );
          })()}
        </Card>
      )}

      <StatusBar
        lastIndexedBlock={meta?.lastIndexedBlock}
        lastIndexedAt={meta?.lastIndexedAt}
        degraded={Boolean(isError)}
      />
    </div>
  );
}
