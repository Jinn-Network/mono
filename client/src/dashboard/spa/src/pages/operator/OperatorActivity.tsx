import { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api } from '../../api/client.js';

interface ActivityRow {
  id: number;
  ts: string | null;
  kind: string;
  requestId: string | null;
  serviceIndex: number | null;
  txHash: string | null;
  solverType: string | null;
  outcome: string | null;
}

interface OperatorActivityStatus {
  daemon?: {
    startedAt?: string | null;
    timestamp?: string;
  };
  fleet?: {
    services?: Array<{ index: number; step: string }>;
    completeCount?: number;
    stakedLikeCount?: number;
  };
  activity?: {
    counts?: Record<string, number>;
    recent?: ActivityRow[];
  };
  rewards?: {
    lastClaimTickAt?: string | null;
    claimLoopIntervalMs?: number;
  };
  predictionV1?: {
    operator?: {
      nextAction?: { description?: string };
    };
    totals?: {
      activeTaskRuns?: number;
      failed?: number;
    };
  };
}

const KIND_LABELS: Record<string, string> = {
  startup: 'Startup',
  shutdown: 'Shutdown',
  created: 'Posted',
  task_posted: 'Posted',
  claimed: 'Claimed',
  request_claimed: 'Claimed',
  delivered: 'Delivered',
  delivery_submitted: 'Delivered',
  evaluated: 'Evaluated',
  evaluation_submitted: 'Evaluated',
  reward_claimed: 'Reward',
  balance_topup: 'Top-up',
  engine_transition: 'Engine',
  tick_error: 'Error',
  error: 'Error',
};

function kindLabel(kind: string): string {
  return KIND_LABELS[kind] ?? kind.replace(/_/g, ' ');
}

function formatEventTime(ts: string | null): string {
  if (!ts) return '—';
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return ts;
  return d.toISOString().replace('T', ' ').slice(0, 19) + ' UTC';
}

function formatDetail(row: ActivityRow): string {
  const parts = [
    row.requestId ? `request ${row.requestId}` : null,
    row.solverType ? `solver ${row.solverType}` : null,
    row.serviceIndex !== null ? `service ${row.serviceIndex}` : null,
  ].filter((part): part is string => part !== null);
  return parts.length > 0 ? parts.join(' · ') : 'Daemon lifecycle event';
}

function txLabel(txHash: string | null): string {
  if (!txHash) return '—';
  return txHash.length > 12 ? `${txHash.slice(0, 8)}…${txHash.slice(-4)}` : txHash;
}

function outcomeColor(outcome: string | null): string {
  if (outcome === 'failed') return 'var(--break-red)';
  if (outcome === 'warn') return 'var(--wane)';
  return 'var(--fg-dim)';
}

function latestEvent(events: ActivityRow[], kinds: string[]): ActivityRow | undefined {
  const wanted = new Set(kinds);
  return events.find((event) => wanted.has(event.kind));
}

function formatDuration(ms: number | undefined): string {
  if (!ms || !Number.isFinite(ms)) return '—';
  if (ms < 60_000) return `${Math.round(ms / 1000)}s`;
  if (ms < 3_600_000) return `${Math.round(ms / 60_000)}m`;
  return `${Math.round(ms / 3_600_000)}h`;
}

function countAny(counts: Record<string, number>, kinds: string[]): number {
  return kinds.reduce((sum, kind) => sum + (counts[kind] ?? 0), 0);
}

function ProcessCard({
  title,
  status,
  detail,
  meta,
  tone = 'default',
}: {
  title: string;
  status: string;
  detail: string;
  meta: string;
  tone?: 'default' | 'live' | 'attention' | 'danger';
}): JSX.Element {
  const toneColor =
    tone === 'live'
      ? 'var(--vow-green)'
      : tone === 'attention'
        ? 'var(--wane)'
        : tone === 'danger'
          ? 'var(--break-red)'
          : 'var(--accent-sky)';
  return (
    <article
      data-testid="operator-process-card"
      style={{
        border: '1px solid var(--border)',
        borderRadius: 'var(--radius-2)',
        padding: '14px 16px',
        display: 'flex',
        flexDirection: 'column',
        gap: '10px',
        minWidth: 0,
      }}
    >
      <div style={{ display: 'flex', justifyContent: 'space-between', gap: '12px' }}>
        <span className="j-label">{title}</span>
        <span
          style={{
            fontFamily: "'JetBrains Mono', monospace",
            fontSize: '11px',
            letterSpacing: '0.12em',
            textTransform: 'uppercase',
            color: toneColor,
          }}
        >
          {status}
        </span>
      </div>
      <p
        style={{
          margin: 0,
          fontFamily: "'JetBrains Mono', monospace",
          fontSize: '13px',
          color: 'var(--fg)',
          lineHeight: 1.45,
        }}
      >
        {detail}
      </p>
      <span
        style={{
          fontFamily: "'JetBrains Mono', monospace",
          fontSize: '12px',
          color: 'var(--fg-dim)',
        }}
      >
        {meta}
      </span>
    </article>
  );
}

export function OperatorActivity(): JSX.Element {
  const { data, isLoading, isError, error, refetch } = useQuery<OperatorActivityStatus>({
    queryKey: ['status'],
    queryFn: () => api.getStatus() as Promise<OperatorActivityStatus>,
    refetchInterval: 5_000,
  });

  const events = data?.activity?.recent ?? [];
  const counts = data?.activity?.counts ?? {};
  const topCounts = useMemo(() => {
    return Object.entries(counts)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 4);
  }, [counts]);

  const processCards = useMemo(() => {
    const latestClaim = latestEvent(events, ['claimed', 'request_claimed']);
    const latestDelivery = latestEvent(events, ['delivered', 'delivery_submitted', 'evaluated', 'evaluation_submitted']);
    const latestReward = latestEvent(events, ['reward_claimed']);
    const latestError = latestEvent(events, ['tick_error', 'intent_registry_failed', 'error']);
    const serviceCount = data?.fleet?.services?.length ?? 0;
    const completeCount = data?.fleet?.completeCount ?? data?.fleet?.services?.filter((s) => s.step === 'complete').length ?? 0;
    const activeTaskRuns = data?.predictionV1?.totals?.activeTaskRuns ?? 0;
    const failedTasks = data?.predictionV1?.totals?.failed ?? 0;
    const rewardTick = data?.rewards?.lastClaimTickAt ?? latestReward?.ts ?? null;

    return [
      {
        title: 'Daemon loops',
        status: latestError ? 'attention' : 'running',
        detail:
          serviceCount > 0
            ? `${completeCount}/${serviceCount} services complete`
            : 'Waiting for service state',
        meta: data?.daemon?.startedAt ? `started ${formatEventTime(data.daemon.startedAt)}` : 'startup time unavailable',
        tone: latestError ? 'attention' : 'live',
      },
      {
        title: 'Task intake',
        status: `${activeTaskRuns} active`,
        detail: `${countAny(counts, ['claimed', 'request_claimed'])} claims recorded`,
        meta: latestClaim?.ts ? `last claim ${formatEventTime(latestClaim.ts)}` : 'no claims yet',
        tone: activeTaskRuns > 0 ? 'live' : 'default',
      },
      {
        title: 'Delivery pipeline',
        status: failedTasks > 0 ? 'attention' : 'clear',
        detail: `${countAny(counts, ['delivered', 'delivery_submitted'])} deliveries · ${countAny(counts, ['evaluated', 'evaluation_submitted'])} evaluations`,
        meta: latestDelivery?.ts ? `last output ${formatEventTime(latestDelivery.ts)}` : 'no outputs yet',
        tone: failedTasks > 0 ? 'attention' : 'default',
      },
      {
        title: 'Reward loop',
        status: `${formatDuration(data?.rewards?.claimLoopIntervalMs)} cadence`,
        detail: `${countAny(counts, ['reward_claimed'])} reward claims submitted`,
        meta: rewardTick ? `last tick ${formatEventTime(rewardTick)}` : 'no reward tick yet',
        tone: latestReward ? 'live' : 'default',
      },
    ] as const;
  }, [counts, data?.daemon?.startedAt, data?.fleet?.completeCount, data?.fleet?.services, data?.predictionV1?.totals?.activeTaskRuns, data?.predictionV1?.totals?.failed, data?.rewards?.claimLoopIntervalMs, data?.rewards?.lastClaimTickAt, events]);

  return (
    <section
      id="activity"
      data-testid="operator-activity"
      style={{
        background: 'var(--bg-elevated)',
        border: '1px solid var(--border)',
        borderRadius: 'var(--radius-2)',
        padding: '20px 24px',
        display: 'flex',
        flexDirection: 'column',
        gap: '16px',
      }}
    >
      <div
        style={{
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'flex-start',
          gap: '16px',
          flexWrap: 'wrap',
        }}
      >
        <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
          <span className="j-label">Operator activity</span>
          <h1
            style={{
              fontFamily: "'Instrument Serif', 'Times New Roman', serif",
              fontSize: '30px',
              fontWeight: 400,
              margin: 0,
              color: 'var(--fg)',
              letterSpacing: 0,
            }}
          >
            Activity
          </h1>
        </div>
        <span
          style={{
            fontFamily: "'JetBrains Mono', monospace",
            fontSize: '11px',
            letterSpacing: '0.14em',
            textTransform: 'uppercase',
            color: 'var(--vow-green)',
            border: '1px solid var(--vow-green)',
            borderRadius: 'var(--radius-1)',
            padding: '3px 8px',
          }}
        >
          polling live
        </span>
      </div>

      {topCounts.length > 0 && (
        <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap' }}>
          {topCounts.map(([kind, count]) => (
            <span
              key={kind}
              data-testid="operator-activity-count"
              style={{
                fontFamily: "'JetBrains Mono', monospace",
                fontSize: '11px',
                color: 'var(--fg-muted)',
                border: '1px solid var(--border)',
                borderRadius: 'var(--radius-1)',
                padding: '3px 8px',
                textTransform: 'uppercase',
                letterSpacing: '0.12em',
              }}
            >
              {kindLabel(kind)} {count}
            </span>
          ))}
        </div>
      )}

      {!isLoading && !isError && (
        <div
          data-testid="operator-process-grid"
          style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fit, minmax(190px, 1fr))',
            gap: '10px',
          }}
        >
          {processCards.map((process) => (
            <ProcessCard
              key={process.title}
              title={process.title}
              status={process.status}
              detail={process.detail}
              meta={process.meta}
              tone={process.tone}
            />
          ))}
        </div>
      )}

      {isLoading && (
        <p data-testid="operator-activity-loading" style={{ margin: 0, color: 'var(--fg-muted)', fontSize: '13px' }}>
          Loading activity…
        </p>
      )}

      {isError && (
        <div
          role="alert"
          data-testid="operator-activity-error"
          style={{
            border: '1px solid var(--break-red)',
            borderRadius: 'var(--radius-2)',
            padding: '14px 16px',
            display: 'flex',
            justifyContent: 'space-between',
            gap: '12px',
            alignItems: 'center',
          }}
        >
          <span style={{ color: 'var(--break-red)', fontSize: '13px' }}>
            {error instanceof Error ? error.message : 'Failed to load activity.'}
          </span>
          <button
            type="button"
            onClick={() => {
              void refetch();
            }}
            style={{
              fontFamily: "'JetBrains Mono', monospace",
              fontSize: '12px',
              border: '1px solid var(--border)',
              borderRadius: 'var(--radius-1)',
              background: 'transparent',
              color: 'var(--fg)',
              padding: '7px 10px',
              cursor: 'pointer',
            }}
          >
            Retry
          </button>
        </div>
      )}

      {!isLoading && !isError && events.length === 0 && (
        <p data-testid="operator-activity-empty" style={{ margin: 0, color: 'var(--fg-muted)', fontSize: '13px' }}>
          No operator activity recorded yet.
        </p>
      )}

      {!isLoading && !isError && events.length > 0 && (
        <ul
          data-testid="operator-activity-list"
          style={{
            listStyle: 'none',
            padding: 0,
            margin: 0,
            display: 'flex',
            flexDirection: 'column',
            gap: '8px',
          }}
        >
          {events.map((row) => (
            <li
              key={row.id}
              data-testid="operator-activity-row"
              style={{
                display: 'flex',
                alignItems: 'flex-start',
                gap: '12px',
                flexWrap: 'wrap',
                padding: '12px 0',
                borderTop: '1px solid var(--border)',
                fontFamily: "'JetBrains Mono', monospace",
              }}
            >
              <span style={{ flex: '0 0 152px', color: 'var(--fg-dim)', fontSize: '12px' }}>
                {formatEventTime(row.ts)}
              </span>
              <span
                style={{
                  flex: '0 0 112px',
                  color: row.kind.includes('error') ? 'var(--break-red)' : 'var(--accent-sky)',
                  fontSize: '12px',
                  textTransform: 'uppercase',
                  letterSpacing: '0.12em',
                }}
              >
                {kindLabel(row.kind)}
              </span>
              <span style={{ flex: '1 1 260px', minWidth: 0, color: 'var(--fg)', fontSize: '13px' }}>
                {formatDetail(row)}
              </span>
              <span
                style={{
                  flex: '0 1 160px',
                  minWidth: 0,
                  color: row.txHash ? 'var(--accent-gold)' : outcomeColor(row.outcome),
                  fontSize: '12px',
                  textAlign: 'right',
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                }}
              >
                {txLabel(row.txHash)}
              </span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
