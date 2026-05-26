/**
 * SolverNetView — per-SolverNet detail with the Learning panel.
 *
 * Gold element: the big headline resolved-rate (ONE gold per surface rule).
 * K and mode toggles write to URL-state.
 * Board toggle writes to URL-state.
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
import { Kpi, KpiRow } from '../components/Kpi';
import { StatusChip } from '../components/StatusChip';
import { LearningCurve } from '../components/LearningCurve';
import { CheckpointTimeline } from '../components/CheckpointTimeline';
import { FreezeIntegrity } from '../components/FreezeIntegrity';
import { Leaderboard } from '../components/Leaderboard';
import { SegmentedControl } from '../components/SegmentedControl';
import { useNumParam, useEnumParam } from '../lib/url-state';
import { useCountUp } from '../hooks/useCountUp';
import { pct, int, shortAddr, shortCid } from '../lib/format';

// ── K sentinel (show all) ─────────────────────────────────────────────────────

const K_ALL = 999999;
const K_OPTIONS = [
  { label: '20', value: 20 },
  { label: '50', value: 50 },
  { label: '100', value: 100 },
  { label: 'all', value: K_ALL },
];

// ── Slice leaderboard → Leaderboard component row adapter ────────────────────

// Phase 2 ships an unpartitioned list (no ranked/lowVolume split). We render
// every row as "ranked" and synthesize the rank from position; `lowVolume` is
// always empty. Phase 3 can reintroduce partitioning via a Leaderboard prop.
// settledContribution isn't carried on SliceResponse; we surface attempts as a
// best-effort proxy (the column is informational, no truth claim).
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

  const [k, setK] = useNumParam('k', 50);
  const [bucket] = useNumParam('bucket', 7200);
  const [curveMode, setCurveMode] = useEnumParam('curveMode', 'rolling', [
    'rolling',
    'buckets',
  ]);
  const [board, setBoard] = useEnumParam('board', 'train', ['train', 'frozen']);

  // Phase 2 strangler-fig: useSlice serves curve + leaderboard + KPIs.
  // useSolverNet still serves metadata (name, status, launcherAgentId,
  // checkpointTimeline, freezeIntegrity, manifestEnrichmentStatus). A later
  // sprint can move those to engine endpoints too.
  const sliceParams: SliceParams = {
    manifestDigest: cid,
    group: 'none',
    filter: {},
    includeUnenriched: false,
    bucket: 'auto',
  };
  const {
    data: slice,
    isLoading: sliceLoading,
    isError: sliceError,
  } = useSlice(sliceParams);
  const {
    data: meta,
    isLoading: metaLoading,
    isError: metaError,
  } = useSolverNet(cid, {
    k: k === K_ALL ? undefined : k,
    bucket,
  });

  const isLoading = sliceLoading || metaLoading;
  const isError = sliceError || metaError;

  // Animate the gold headline resolved-rate; respects prefers-reduced-motion.
  // Sourced from the slice KPIs (engine-backed) rather than legacy meta.
  const animatedRate = useCountUp(slice?.kpis.resolvedRate ?? 0, 400);

  // ── Unknown SolverNet ────────────────────────────────────────────────────────

  // The API returns { error: 'unknown solvernet' } with 404 → isError will be true
  // (fetchJson throws on non-ok). We detect it via isError.

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

          <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
            <Link
              href={`/explore/${encodeURIComponent(cid)}`}
              style={{
                fontFamily: 'var(--font-mono)',
                fontSize: 11,
                letterSpacing: '0.06em',
                padding: '6px 12px',
                border: '1px solid var(--border)',
                borderRadius: 'var(--radius-1)',
                color: 'var(--fg-muted)',
                textDecoration: 'none',
                background: 'transparent',
              }}
            >
              Explore this slice ↗
            </Link>
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

          {/* ── Learning curve ── */}
          <Card title="Learning curve">
            <div
              style={{
                display: 'flex',
                gap: 12,
                flexWrap: 'wrap',
                marginBottom: 16,
                alignItems: 'center',
              }}
            >
              {/* Rolling window K toggle */}
              <div
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 8,
                }}
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
                  Window
                </span>
                <SegmentedControl
                  options={K_OPTIONS.map((o) => ({ label: o.label, value: String(o.value) }))}
                  value={String(k >= K_ALL ? K_ALL : k)}
                  onChange={(v) => setK(Number(v))}
                />
              </div>

              {/* Mode toggle */}
              <div
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 8,
                }}
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
            </div>

            <LearningCurve
              buckets={slice.series[0]?.buckets ?? []}
              rolling={slice.series[0]?.rolling ?? []}
              mode={curveMode as 'rolling' | 'buckets'}
            />

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
                ? `Rolling resolved-rate over the last ${k >= K_ALL ? 'all' : k} tasks`
                : `Resolved-rate per ~${bucket}-block bucket`}
            </div>
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
                board === 'train' ? slice.leaderboard.train : slice.leaderboard.frozen;
              const ranked: LeaderboardRankedRow[] = rows.map(toRankedRow);
              const lowVolume: LeaderboardLowVolumeRow[] = [];
              return (
                <Leaderboard
                  ranked={ranked}
                  lowVolume={lowVolume}
                  // JINN attribution can't be split by mode — show "—" until ebu7.9
                  meta={{ jinnAttribution: 'pending' }}
                  compact
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
