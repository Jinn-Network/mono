import { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link } from 'wouter';
import { api } from '../../api/client.js';
import type {
  LauncherStatusNetEntry,
  LauncherStatusResponse,
  LauncherTaskEntry,
  LauncherTasksResponse,
} from '../../api/types.js';

function formatTimestamp(iso: string | undefined): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toISOString().replace('T', ' ').slice(0, 19) + ' UTC';
}

function formatDuration(ms: number | undefined): string {
  if (!ms || !Number.isFinite(ms)) return '—';
  if (ms < 60_000) return `${Math.round(ms / 1000)}s`;
  if (ms < 3_600_000) return `${Math.round(ms / 60_000)}m`;
  return `${Math.round(ms / 3_600_000)}h`;
}

function formatTaskState(state: string): string {
  return state.replace(/-/g, ' ');
}

function generatorTone(net: LauncherStatusNetEntry): 'live' | 'attention' | 'paused' {
  if (net.generator.state === 'errored' || net.generator.stale) return 'attention';
  if (net.generator.state === 'paused') return 'paused';
  return 'live';
}

function toneColor(tone: 'live' | 'attention' | 'paused'): string {
  if (tone === 'live') return 'var(--vow-green)';
  if (tone === 'attention') return 'var(--break-red)';
  return 'var(--wane)';
}

function GeneratorCard({ net }: { net: LauncherStatusNetEntry }): JSX.Element {
  const tone = generatorTone(net);
  const posted = net.generator.lastPollSummary?.posted ?? 0;
  const evaluated = net.generator.lastPollSummary?.evaluated ?? 0;
  const skipped = net.generator.lastPollSummary?.skipped ?? 0;
  return (
    <article
      data-testid="launcher-process-card"
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
        <span className="j-label">{net.name}</span>
        <span
          style={{
            fontFamily: "'JetBrains Mono', monospace",
            fontSize: '11px',
            letterSpacing: '0.12em',
            textTransform: 'uppercase',
            color: toneColor(tone),
          }}
        >
          {net.generator.stale ? 'stale' : net.generator.state}
        </span>
      </div>
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fit, minmax(72px, 1fr))',
          gap: '8px 12px',
          fontFamily: "'JetBrains Mono', monospace",
          fontSize: '12px',
        }}
      >
        <Metric label="posted" value={posted} />
        <Metric label="evaluated" value={evaluated} />
        <Metric label="skipped" value={skipped} />
        <Metric label="open tasks" value={net.openTasks} />
      </div>
      <span style={{ color: 'var(--fg-dim)', fontFamily: "'JetBrains Mono', monospace", fontSize: '12px' }}>
        last poll {formatTimestamp(net.generator.lastPollAt)} · cadence {formatDuration(net.generator.cadenceMs)}
      </span>
      {net.generator.lastError && (
        <span
          data-testid="launcher-process-error"
          style={{ color: 'var(--break-red)', fontFamily: "'JetBrains Mono', monospace", fontSize: '12px' }}
        >
          {net.generator.lastError.message} · {formatTimestamp(net.generator.lastError.at)}
        </span>
      )}
    </article>
  );
}

function Metric({ label, value }: { label: string; value: string | number }): JSX.Element {
  return (
    <span style={{ display: 'flex', flexDirection: 'column', gap: '2px' }}>
      <span style={{ color: 'var(--fg-dim)', textTransform: 'uppercase', letterSpacing: '0.12em' }}>{label}</span>
      <span style={{ color: 'var(--fg)', fontSize: '16px' }}>{value}</span>
    </span>
  );
}

function TaskRow({ task }: { task: LauncherTaskEntry }): JSX.Element {
  return (
    <li
      data-testid="launcher-task-activity-row"
      style={{
        display: 'grid',
        gridTemplateColumns: '130px minmax(0, 1fr) 116px 82px',
        gap: '12px',
        padding: '10px 0',
        borderTop: '1px solid var(--border)',
        fontFamily: "'JetBrains Mono', monospace",
        fontSize: '12px',
      }}
    >
      <span style={{ color: 'var(--fg-dim)' }}>{formatTimestamp(task.postedAt)}</span>
      <span style={{ color: 'var(--fg)', minWidth: 0, overflowWrap: 'anywhere' }}>
        {task.summary?.title ?? task.taskId}
      </span>
      <span style={{ color: 'var(--accent-sky)', textTransform: 'uppercase', letterSpacing: '0.12em' }}>
        {formatTaskState(task.state)}
      </span>
      <span style={{ color: 'var(--fg-muted)', textAlign: 'right' }}>
        {task.claims.current}/{task.claims.max}
      </span>
    </li>
  );
}

export function LauncherActivity(): JSX.Element {
  const statusQuery = useQuery<LauncherStatusResponse>({
    queryKey: ['launcher-status', 'activity'],
    queryFn: () => api.fetchLauncherStatus(),
    refetchInterval: 5_000,
  });
  const tasksQuery = useQuery<LauncherTasksResponse>({
    queryKey: ['launcher-tasks', 'activity'],
    queryFn: () => api.fetchLauncherTasks({ limit: 5 }),
    refetchInterval: 10_000,
  });

  const nets = statusQuery.data?.nets ?? [];
  const tasks = tasksQuery.data?.tasks ?? [];
  const totalOpenTasks = useMemo(
    () => nets.reduce((sum, net) => sum + net.openTasks, 0),
    [nets],
  );
  const activeGenerators = nets.filter((net) => net.generator.state === 'active' && !net.generator.stale).length;

  return (
    <section
      data-testid="launcher-activity"
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
          <span className="j-label">Launcher activity</span>
          <h2
            style={{
              fontFamily: "'Instrument Serif', 'Times New Roman', serif",
              fontSize: '30px',
              fontWeight: 400,
              margin: 0,
              color: 'var(--fg)',
              letterSpacing: 0,
            }}
          >
            Generators
          </h2>
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
          {activeGenerators} active · {totalOpenTasks} open
        </span>
      </div>

      {statusQuery.isLoading && (
        <p data-testid="launcher-activity-loading" style={{ margin: 0, color: 'var(--fg-muted)', fontSize: '13px' }}>
          Loading launcher activity…
        </p>
      )}

      {statusQuery.isError && (
        <p
          role="alert"
          data-testid="launcher-activity-error"
          style={{ margin: 0, color: 'var(--break-red)', fontSize: '13px' }}
        >
          {statusQuery.error instanceof Error ? statusQuery.error.message : 'Failed to load launcher activity.'}
        </p>
      )}

      {!statusQuery.isLoading && !statusQuery.isError && nets.length === 0 && (
        <p data-testid="launcher-activity-empty" style={{ margin: 0, color: 'var(--fg-muted)', fontSize: '13px' }}>
          No launcher generators running yet.
        </p>
      )}

      {nets.length > 0 && (
        <div
          data-testid="launcher-process-grid"
          style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))',
            gap: '10px',
          }}
        >
          {nets.map((net) => (
            <GeneratorCard key={net.name} net={net} />
          ))}
        </div>
      )}

      <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', gap: '12px', alignItems: 'center' }}>
          <span className="j-label">Recent task posts</span>
          <Link
            href="/launcher/create"
            style={{
              color: 'var(--accent-sky)',
              fontFamily: "'JetBrains Mono', monospace",
              fontSize: '11px',
              letterSpacing: '0.14em',
              textTransform: 'uppercase',
              textDecoration: 'none',
            }}
          >
            Create →
          </Link>
        </div>

        {tasksQuery.isError && (
          <p role="alert" style={{ margin: 0, color: 'var(--break-red)', fontSize: '13px' }}>
            {tasksQuery.error instanceof Error ? tasksQuery.error.message : 'Failed to load recent launcher tasks.'}
          </p>
        )}
        {!tasksQuery.isLoading && !tasksQuery.isError && tasks.length === 0 && (
          <p data-testid="launcher-task-activity-empty" style={{ margin: 0, color: 'var(--fg-muted)', fontSize: '13px' }}>
            No launcher tasks posted yet.
          </p>
        )}
        {tasks.length > 0 && (
          <ul
            data-testid="launcher-task-activity-list"
            style={{ listStyle: 'none', margin: 0, padding: 0, display: 'flex', flexDirection: 'column' }}
          >
            {tasks.map((task) => (
              <TaskRow key={task.taskId} task={task} />
            ))}
          </ul>
        )}
      </div>
    </section>
  );
}
