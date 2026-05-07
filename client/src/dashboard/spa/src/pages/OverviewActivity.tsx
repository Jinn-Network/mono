import { useQuery } from '@tanstack/react-query';
import { Link } from 'wouter';
import { api } from '../api/client.js';
import { LiveNowBand } from './overview/LiveNowBand.js';

/**
 * /overview/activity — the canonical activity surface. Reached from the
 * "View activity →" link on the LiveNowBand. Two sections:
 *
 *   • In flight — per-task list of currently-active task runs (filtered
 *     from predictionV1.recentTasks by non-terminal state).
 *   • Recent — full activity event stream (activity.recent from /v1/status).
 *
 * v1 limitations (see plan §"Out of scope"):
 *   • predictionV1.recentTasks is capped at 5 by the daemon. Operators
 *     with more than 5 in-flight tasks won't see them all here. Practical
 *     max in-flight is single-digit on today's daemons.
 *   • activity.recent is capped at 12 events. Pagination is a follow-up.
 *   • predictionV1 only — portfolioV0 in-flight runs are not surfaced here.
 */

const TERMINAL_STATES = new Set(['COMPLETE', 'FAILED']);

interface ActivityStatusV1 {
  fleet?: {
    services?: Array<{
      index: number;
      step: string;
      safeAddress?: string | null;
      agentId?: number | null;
    }>;
  };
  activity?: {
    recent?: Array<{
      id: number;
      ts: string | null;
      kind: string;
      requestId: string | null;
      txHash: string | null;
      serviceIndex: number | null;
      solverType: string | null;
      outcome: string | null;
    }>;
  };
  predictionV1?: {
    recentTasks?: Array<{
      requestId: string;
      taskId: string | null;
      taskCid: string;
      state: string;
      taskRole: 'restoration' | 'evaluation' | null;
      stateUpdatedAt: number;
      deliveryTxHash: string | null;
    }>;
  };
}

function formatElapsed(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return '—';
  if (ms < 60_000) return `${Math.round(ms / 1000)}s`;
  if (ms < 3_600_000) {
    const mins = Math.floor(ms / 60_000);
    const secs = Math.round((ms % 60_000) / 1000);
    return secs > 0 ? `${mins}m ${secs}s` : `${mins}m`;
  }
  return `${Math.round(ms / 3_600_000)}h`;
}

function formatTimestamp(ts: string | null): string {
  if (!ts) return '—';
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return ts;
  return d.toISOString().replace('T', ' ').slice(0, 19) + ' UTC';
}

function formatKind(kind: string): string {
  return kind.replace(/_/g, ' ');
}

function truncateRequestId(requestId: string): string {
  if (requestId.length <= 14) return requestId;
  return `${requestId.slice(0, 8)}…${requestId.slice(-4)}`;
}

function txDisplay(txHash: string | null | undefined): string {
  if (!txHash) return '—';
  return txHash.length > 12 ? `${txHash.slice(0, 6)}…${txHash.slice(-4)}` : txHash;
}

const KIND_TONE: Record<string, string> = {
  task_posted: 'var(--accent-sky)',
  request_claimed: 'var(--accent-sky)',
  delivery_submitted: 'var(--vow-green)',
  evaluation_submitted: 'var(--vow-green)',
  reward_claimed: 'var(--accent-gold)',
  tick_error: 'var(--break-red)',
  intent_registry_failed: 'var(--break-red)',
  error: 'var(--break-red)',
};

function kindColor(kind: string, outcome: string | null): string {
  if (outcome === 'failed') return 'var(--break-red)';
  return KIND_TONE[kind] ?? 'var(--accent-sky)';
}

export interface OverviewActivityPageProps {
  /** Override poll interval (tests). */
  pollIntervalMs?: number;
}

export function OverviewActivityPage({
  pollIntervalMs = 5_000,
}: OverviewActivityPageProps = {}): JSX.Element {
  const { data, isLoading, isError, error, refetch } = useQuery<ActivityStatusV1>({
    queryKey: ['status'],
    queryFn: () => api.getStatus() as Promise<ActivityStatusV1>,
    refetchInterval: pollIntervalMs,
  });

  const inFlight = (data?.predictionV1?.recentTasks ?? []).filter(
    (t) => !TERMINAL_STATES.has(t.state),
  );
  const events = data?.activity?.recent ?? [];

  return (
    <main
      data-testid="overview-activity"
      style={{
        padding: '24px',
        display: 'flex',
        flexDirection: 'column',
        gap: '20px',
        maxWidth: '960px',
        margin: '0 auto',
      }}
    >
      <header
        style={{
          display: 'flex',
          alignItems: 'baseline',
          justifyContent: 'space-between',
          gap: '16px',
        }}
      >
        <h1
          style={{
            fontFamily: "'Instrument Serif', 'Times New Roman', serif",
            fontSize: '32px',
            fontWeight: 400,
            margin: 0,
            color: 'var(--fg)',
          }}
        >
          Activity
        </h1>
        <Link
          href="/overview"
          data-testid="overview-activity-back"
          style={{
            fontFamily: "'JetBrains Mono', monospace",
            fontSize: '11px',
            letterSpacing: '0.14em',
            textTransform: 'uppercase',
            color: 'var(--accent-sky)',
            textDecoration: 'none',
          }}
        >
          ← Overview
        </Link>
      </header>

      <LiveNowBand />

      <section
        data-testid="overview-activity-in-flight"
        style={{
          background: 'var(--bg-elevated)',
          border: '1px solid var(--border)',
          borderRadius: '10px',
          padding: '20px 24px',
          display: 'flex',
          flexDirection: 'column',
          gap: '12px',
          fontFamily: "'JetBrains Mono', monospace",
        }}
      >
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <span
            style={{
              fontSize: '11px',
              fontWeight: 500,
              letterSpacing: '0.14em',
              textTransform: 'uppercase',
              color: 'var(--fg-muted)',
            }}
          >
            In flight · {inFlight.length}
          </span>
        </div>
        {isLoading && (
          <p
            data-testid="overview-activity-loading"
            style={{ margin: 0, color: 'var(--fg-muted)', fontSize: '12px' }}
          >
            Loading…
          </p>
        )}
        {!isLoading && !isError && inFlight.length === 0 && (
          <p
            data-testid="overview-activity-in-flight-empty"
            style={{ margin: 0, color: 'var(--fg-muted)', fontSize: '13px' }}
          >
            No tasks in flight.
          </p>
        )}
        {inFlight.length > 0 && (
          <ul
            data-testid="overview-activity-in-flight-list"
            style={{
              listStyle: 'none',
              padding: 0,
              margin: 0,
              display: 'flex',
              flexDirection: 'column',
              gap: '0',
            }}
          >
            {inFlight.map((task) => (
              <li
                key={task.requestId}
                data-testid="overview-activity-in-flight-row"
                style={{
                  display: 'grid',
                  gridTemplateColumns: '110px 110px 1fr 80px',
                  gap: '12px',
                  padding: '10px 0',
                  borderTop: '1px solid var(--border)',
                  fontSize: '12px',
                }}
              >
                <span
                  style={{
                    color: 'var(--accent-sky)',
                    textTransform: 'uppercase',
                    letterSpacing: '0.12em',
                    fontSize: '11px',
                  }}
                >
                  {task.state}
                </span>
                <span style={{ color: 'var(--fg-muted)' }}>
                  {task.taskRole ?? '—'}
                </span>
                <span style={{ color: 'var(--fg)', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                  {truncateRequestId(task.requestId)}
                </span>
                <span style={{ color: 'var(--fg-muted)', textAlign: 'right' }}>
                  {formatElapsed(Date.now() - task.stateUpdatedAt)}
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section
        data-testid="overview-activity-recent"
        style={{
          background: 'var(--bg-elevated)',
          border: '1px solid var(--border)',
          borderRadius: '10px',
          padding: '20px 24px',
          display: 'flex',
          flexDirection: 'column',
          gap: '12px',
          fontFamily: "'JetBrains Mono', monospace",
        }}
      >
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <span
            style={{
              fontSize: '11px',
              fontWeight: 500,
              letterSpacing: '0.14em',
              textTransform: 'uppercase',
              color: 'var(--fg-muted)',
            }}
          >
            Recent · {events.length}
          </span>
        </div>
        {isError && (
          <div
            role="alert"
            data-testid="overview-activity-error"
            style={{
              border: '1px solid var(--break-red)',
              borderRadius: '6px',
              padding: '12px',
              display: 'flex',
              justifyContent: 'space-between',
              alignItems: 'center',
              gap: '12px',
            }}
          >
            <span style={{ color: 'var(--break-red)', fontSize: '12px' }}>
              {error instanceof Error ? error.message : 'Failed to load activity.'}
            </span>
            <button
              type="button"
              onClick={() => {
                void refetch();
              }}
              style={{
                fontFamily: "'JetBrains Mono', monospace",
                fontSize: '11px',
                letterSpacing: '0.12em',
                textTransform: 'uppercase',
                background: 'transparent',
                border: '1px solid var(--border)',
                borderRadius: '4px',
                color: 'var(--fg)',
                padding: '6px 10px',
                cursor: 'pointer',
              }}
            >
              Retry
            </button>
          </div>
        )}
        {!isLoading && !isError && events.length === 0 && (
          <p
            data-testid="overview-activity-recent-empty"
            style={{ margin: 0, color: 'var(--fg-muted)', fontSize: '13px' }}
          >
            No events yet.
          </p>
        )}
        {events.length > 0 && (
          <ul
            data-testid="overview-activity-recent-list"
            style={{
              listStyle: 'none',
              padding: 0,
              margin: 0,
              display: 'flex',
              flexDirection: 'column',
              gap: '0',
            }}
          >
            {events.map((row) => (
              <li
                key={row.id}
                data-testid="overview-activity-recent-row"
                style={{
                  display: 'grid',
                  gridTemplateColumns: '160px 110px 1fr 110px',
                  gap: '12px',
                  padding: '10px 0',
                  borderTop: '1px solid var(--border)',
                  fontSize: '12px',
                }}
              >
                <span style={{ color: 'var(--fg-dim)' }}>{formatTimestamp(row.ts)}</span>
                <span
                  style={{
                    color: kindColor(row.kind, row.outcome),
                    textTransform: 'uppercase',
                    letterSpacing: '0.12em',
                    fontSize: '11px',
                  }}
                >
                  {formatKind(row.kind)}
                </span>
                <span style={{ color: 'var(--fg)', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                  {row.requestId ?? row.solverType ?? '—'}
                </span>
                <span
                  style={{
                    color: row.txHash ? 'var(--accent-gold)' : 'var(--fg-dim)',
                    textAlign: 'right',
                  }}
                >
                  {txDisplay(row.txHash)}
                </span>
              </li>
            ))}
          </ul>
        )}
        <p
          style={{
            margin: 0,
            color: 'var(--fg-dim)',
            fontSize: '11px',
            fontStyle: 'italic',
          }}
        >
          Older events: see on-chain via the operator's safe address. Pagination here is a follow-up.
        </p>
      </section>
    </main>
  );
}
