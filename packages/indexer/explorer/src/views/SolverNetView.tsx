/**
 * SolverNetView — per-SolverNet detail with the Learning panel.
 *
 * Gold element: the big headline resolved-rate (ONE gold per surface rule).
 * K and mode toggles write to URL-state.
 * Board toggle writes to URL-state.
 */

import { Link, useParams } from 'wouter';
import { useSolverNet } from '../lib/api';
import { StatusBar } from '../components/StatusBar';
import { Card } from '../components/Card';
import { Kpi, KpiRow } from '../components/Kpi';
import { StatusChip } from '../components/StatusChip';
import { LearningCurve } from '../components/LearningCurve';
import { CheckpointTimeline } from '../components/CheckpointTimeline';
import { FreezeIntegrity } from '../components/FreezeIntegrity';
import { Leaderboard } from '../components/Leaderboard';
import { useNumParam, useEnumParam } from '../lib/url-state';
import { pct, int, shortAddr, shortCid } from '../lib/format';

// ── K sentinel (show all) ─────────────────────────────────────────────────────

const K_ALL = 999999;
const K_OPTIONS = [
  { label: '20', value: 20 },
  { label: '50', value: 50 },
  { label: '100', value: 100 },
  { label: 'all', value: K_ALL },
];

// ── Segmented control ─────────────────────────────────────────────────────────

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
      {options.map((opt) => {
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
              padding: '5px 12px',
              border: 'none',
              borderRight: '1px solid var(--border)',
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
  const [bucket, setBucket] = useNumParam('bucket', 7200);
  const [curveMode, setCurveMode] = useEnumParam('curveMode', 'rolling', [
    'rolling',
    'buckets',
  ]);
  const [board, setBoard] = useEnumParam('board', 'train', ['train', 'frozen']);

  const { data, isLoading, isError } = useSolverNet(cid, {
    k: k === K_ALL ? undefined : k,
    bucket,
  });

  // Unused setter reference to silence lint — bucket setter is available
  void setBucket;

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

      {/* Data */}
      {data && (
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
                {shortCid(data.cid)}
              </h1>
              <div
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 12,
                  flexWrap: 'wrap',
                }}
              >
                <StatusChip
                  kind={data.status as 'launched' | 'paused' | 'retired'}
                  label={data.status}
                />
                {data.launcherAgentId && (
                  <span
                    style={{
                      fontFamily: 'var(--font-mono)',
                      fontSize: 11,
                      color: 'var(--fg-dim)',
                    }}
                  >
                    Launcher: {shortAddr(data.launcherAgentId)}
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
                aria-label={`Resolved rate: ${pct(data.resolvedRate)}`}
              >
                {data.resolvedRate !== null ? pct(data.resolvedRate) : '—'}
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

          {/* ── Supporting KPIs ── */}
          <KpiRow>
            <Kpi label="Tasks posted" value={int(data.tasksPosted)} />
            <Kpi label="Settled" value={int(data.tasksSettled)} />
            <Kpi label="Attempts" value={int(data.attempts)} />
            <Kpi label="Verdicts" value={int(data.verdicts)} />
            <Kpi label="Verdicts passed" value={int(data.verdictsPass)} />
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
              buckets={data.learningCurveBuckets}
              rolling={data.learningCurveRolling}
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

          {/* ── Checkpoint timeline ── */}
          <Card title="Checkpoint timeline">
            <CheckpointTimeline data={data.checkpointTimeline} />
          </Card>

          {/* ── Freeze integrity ── */}
          <Card title="Freeze integrity">
            <FreezeIntegrity data={data.freezeIntegrity} />
          </Card>

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
              const boardData = board === 'train' ? data.trainBoard : data.frozenBoard;
              return (
                <Leaderboard
                  ranked={boardData.ranked}
                  lowVolume={boardData.lowVolume}
                  compact
                />
              );
            })()}
          </Card>
        </>
      )}

      <StatusBar
        lastIndexedBlock={data?.lastIndexedBlock}
        lastIndexedAt={data?.lastIndexedAt}
        degraded={isError}
      />
    </div>
  );
}
