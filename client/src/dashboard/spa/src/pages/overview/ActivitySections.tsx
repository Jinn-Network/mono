import { useQuery } from '@tanstack/react-query';
import { api } from '../../api/client.js';
import { useEventStream } from '../../api/events.js';
import { EventStreamList } from '../../components/EventStreamList.js';

/**
 * Live activity surface — the operator's view of what their daemon has been
 * doing. Two sections:
 *
 *   • In flight — per-task list of currently-active task runs across SolverNets
 *     (read from polled /v1/status, since task state isn't an "event" per se).
 *   • Recent — live event stream from /v1/events via `useEventStream()`, rendered
 *     through the shared <EventStreamList> component. Per OPERATOR-APP-SPEC §3.3,
 *     all event-based surfaces consume the same SSE vocabulary.
 *
 * Rendered as a primary section on /overview (the Dashboard) so an operator
 * who runs `jinn run` and lands on the dashboard sees live task/event
 * activity without navigating away (issue #219). Also reused by the dedicated
 * /overview/activity drilldown page.
 */

const TERMINAL_STATES = new Set(['COMPLETE', 'FAILED']);

export interface ActivityStatusV1 {
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
  taskRuns?: {
    inFlight?: ActivityTaskRun[];
  };
  predictionV1?: {
    recentTasks?: ActivityTaskRun[];
  };
}

export interface ActivityTaskRun {
  requestId: string;
  taskId: string | null;
  taskCid: string;
  solverType?: string | null;
  state: string;
  taskRole: 'restoration' | 'evaluation' | null;
  stateUpdatedAt: number;
  deliveryTxHash: string | null;
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

function truncateRequestId(requestId: string): string {
  if (requestId.length <= 14) return requestId;
  return `${requestId.slice(0, 8)}…${requestId.slice(-4)}`;
}

export interface ActivitySectionsProps {
  /** Override poll interval (tests). */
  pollIntervalMs?: number;
}

/**
 * In-flight + Recent activity cards. Shares the `['status']` query key with
 * HeroStats / LiveNowBand so it does not double-poll /v1/status.
 */
export function ActivitySections({
  pollIntervalMs = 5_000,
}: ActivitySectionsProps = {}): JSX.Element {
  const { data, isLoading, isError, error, refetch } = useQuery<ActivityStatusV1>({
    queryKey: ['status'],
    queryFn: () => api.getStatus() as Promise<ActivityStatusV1>,
    refetchInterval: pollIntervalMs,
  });

  const inFlight = data?.taskRuns?.inFlight ?? (data?.predictionV1?.recentTasks ?? []).filter(
    (t) => !TERMINAL_STATES.has(t.state),
  );

  // Recent section uses the live SSE stream rather than the polled snapshot.
  // The polled snapshot (data?.activity?.recent) is no longer read here.
  const { events: sseEvents, connected: sseConnected } = useEventStream();

  return (
    <>
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
                  {task.solverType ? `${task.solverType} · ` : ''}{truncateRequestId(task.requestId)}
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
            Recent · {sseEvents.length}
          </span>
          <span
            style={{
              fontSize: '11px',
              color: sseConnected ? 'var(--vow-green)' : 'var(--fg-dim)',
              display: 'flex',
              gap: '5px',
              alignItems: 'center',
            }}
          >
            <span
              style={{
                width: '6px',
                height: '6px',
                borderRadius: '50%',
                background: sseConnected ? 'var(--vow-green)' : 'var(--fg-dim)',
              }}
            />
            {sseConnected ? 'live' : 'disconnected'}
          </span>
        </div>
        {sseEvents.length === 0 && (
          <p
            data-testid="overview-activity-recent-empty"
            style={{ margin: 0, color: 'var(--fg-muted)', fontSize: '13px' }}
          >
            No recent activity yet.
          </p>
        )}
        {sseEvents.length > 0 && (
          <div data-testid="overview-activity-recent-list">
            <EventStreamList events={sseEvents} />
          </div>
        )}
      </section>
    </>
  );
}
