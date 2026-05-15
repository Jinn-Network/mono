import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api } from '../../api/client.js';
import type {
  LaunchedSolverNetRecord,
  LauncherTaskEntry,
  LauncherTaskState,
  LauncherTasksResponse,
} from '../../api/types.js';
import { formatTimestamp, truncateCid } from './helpers.js';

/**
 * Recent posted Tasks for this launched SolverNet.
 *
 * The daemon's `/v1/launcher/tasks` endpoint surfaces all tasks for the
 * launching daemon — it isn't yet filtered by `solverNetId`. Until task
 * attribution lands (Tasks 27–28 of the SolverNet creation plan), this panel
 * pulls the global launcher-tasks list and displays it as the post-launch
 * preview. Once the daemon grows a per-SolverNet endpoint, this component
 * swaps the query function without changing its props or layout.
 *
 * Pagination is cursor-based on `postedAt` (`cursor.before` ISO timestamp).
 * The panel keeps a stack of cursors so Back returns to the previous page;
 * this is a faithful copy of the predecessor `PostedTasksList` ergonomic.
 */

const PAGE_SIZE = 5;

const STATE_TONE: Record<LauncherTaskState, { fg: string; label: string }> = {
  open: { fg: 'var(--accent-sky)', label: 'Open' },
  'claims-in-flight': { fg: 'var(--accent-sky)', label: 'In flight' },
  'fully-claimed': { fg: 'var(--vow-green)', label: 'Claimed' },
  settled: { fg: 'var(--vow-green)', label: 'Settled' },
  failed: { fg: 'var(--break-red)', label: 'Failed' },
};

export interface TasksPanelProps {
  record: LaunchedSolverNetRecord;
  /**
   * Override the fetcher in tests. Defaults to
   * `api.fetchLauncherTasks({ cursor, limit })`.
   */
  fetchTasks?: (opts: {
    cursor?: string;
    limit?: number;
  }) => Promise<LauncherTasksResponse>;
}

export function TasksPanel({ record, fetchTasks }: TasksPanelProps): JSX.Element {
  // Cursor stack: top of stack = current page's "before" cursor (undefined =
  // first page). Pushing pages onto the stack lets us walk forward and back.
  const [cursorStack, setCursorStack] = useState<Array<string | undefined>>([
    undefined,
  ]);
  const cursor = cursorStack[cursorStack.length - 1];

  const fetcher = fetchTasks ?? ((opts) => api.fetchLauncherTasks(opts));
  const { data, isLoading, isError, error, refetch } = useQuery<LauncherTasksResponse>({
    queryKey: ['launcher-tasks', record.solverNetId, cursor ?? null],
    queryFn: () => fetcher({ cursor, limit: PAGE_SIZE }),
    refetchInterval: 15_000,
  });

  const onNext = (): void => {
    if (data?.cursor?.before) {
      setCursorStack((prev) => [...prev, data.cursor!.before]);
    }
  };
  const onBack = (): void => {
    setCursorStack((prev) => (prev.length > 1 ? prev.slice(0, -1) : prev));
  };

  return (
    <section data-testid="launcher-launched-tasks-panel" style={panelStyle}>
      <header style={headerStyle}>
        <h2 style={titleStyle}>Recent posted Tasks</h2>
        <button
          type="button"
          data-testid="launcher-launched-tasks-refresh"
          onClick={() => {
            void refetch();
          }}
          style={ghostButtonStyle}
        >
          Refresh
        </button>
      </header>

      {isLoading && (
        <p
          data-testid="launcher-launched-tasks-loading"
          style={mutedTextStyle}
        >
          Loading…
        </p>
      )}

      {isError && (
        <div
          data-testid="launcher-launched-tasks-error"
          style={{
            color: 'var(--break-red)',
            fontFamily: "'JetBrains Mono', monospace",
            fontSize: '12px',
          }}
        >
          Failed to load tasks: {error instanceof Error ? error.message : 'unknown error'}
        </div>
      )}

      {!isLoading && !isError && data && data.tasks.length === 0 && (
        <EmptyState />
      )}

      {!isLoading && !isError && data && data.tasks.length > 0 && (
        <>
          <div
            data-testid="launcher-launched-tasks-list"
            role="table"
            style={{
              display: 'flex',
              flexDirection: 'column',
              border: '1px solid var(--border)',
              borderRadius: 'var(--radius-2)',
              overflow: 'hidden',
            }}
          >
            <div role="row" style={tableHeaderStyle}>
              <span>Task</span>
              <span>SolverType</span>
              <span>Posted</span>
              <span>State</span>
              <span style={{ textAlign: 'right' }}>Claims</span>
            </div>
            {data.tasks.map((task) => (
              <TaskRow key={task.taskId} task={task} />
            ))}
          </div>

          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              gap: '12px',
            }}
          >
            <button
              type="button"
              data-testid="launcher-launched-tasks-prev"
              onClick={onBack}
              disabled={cursorStack.length <= 1}
              style={{
                ...ghostButtonStyle,
                opacity: cursorStack.length <= 1 ? 0.5 : 1,
                cursor: cursorStack.length <= 1 ? 'not-allowed' : 'pointer',
              }}
            >
              ← Newer
            </button>
            <span style={mutedTextStyle}>
              Page {cursorStack.length}
              {data.tasks.length < PAGE_SIZE && data.cursor === undefined ? ' · end' : ''}
            </span>
            <button
              type="button"
              data-testid="launcher-launched-tasks-next"
              onClick={onNext}
              disabled={!data.cursor?.before}
              style={{
                ...ghostButtonStyle,
                opacity: data.cursor?.before ? 1 : 0.5,
                cursor: data.cursor?.before ? 'pointer' : 'not-allowed',
              }}
            >
              Older →
            </button>
          </div>
        </>
      )}
    </section>
  );
}

function TaskRow({ task }: { task: LauncherTaskEntry }): JSX.Element {
  const tone = STATE_TONE[task.state] ?? { fg: 'var(--fg-muted)', label: task.state };
  return (
    <div
      role="row"
      data-testid="launcher-launched-task-row"
      data-task-id={task.taskId}
      style={tableRowStyle}
    >
      <span
        title={task.taskCid}
        style={{
          fontFamily: "'JetBrains Mono', monospace",
          fontSize: '13px',
          color: 'var(--fg)',
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          whiteSpace: 'nowrap',
        }}
      >
        {task.summary?.title ?? truncateCid(task.taskCid)}
      </span>
      <span
        title={task.solverType ?? task.solverNet}
        style={{
          fontFamily: "'JetBrains Mono', monospace",
          fontSize: '12px',
          color: 'var(--fg-muted)',
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          whiteSpace: 'nowrap',
        }}
      >
        {task.solverType ?? task.solverNet}
      </span>
      <span
        style={{
          fontFamily: "'JetBrains Mono', monospace",
          fontSize: '12px',
          color: 'var(--fg-muted)',
        }}
      >
        {formatTimestamp(task.postedAt)}
      </span>
      <span
        style={{
          fontFamily: "'JetBrains Mono', monospace",
          fontSize: '11px',
          color: tone.fg,
          textTransform: 'uppercase',
          letterSpacing: '0.1em',
        }}
      >
        {tone.label}
      </span>
      <span
        style={{
          fontFamily: "'JetBrains Mono', monospace",
          fontSize: '12px',
          color: 'var(--fg-muted)',
          textAlign: 'right',
        }}
      >
        {task.claims.current} / {task.claims.max}
      </span>
    </div>
  );
}

function EmptyState(): JSX.Element {
  return (
    <div
      data-testid="launcher-launched-tasks-empty"
      style={{
        padding: '24px',
        textAlign: 'center',
        color: 'var(--fg-muted)',
        fontFamily: "'JetBrains Mono', monospace",
        fontSize: '13px',
        border: '1px dashed var(--border)',
        borderRadius: 'var(--radius-2)',
      }}
    >
      Tasks will appear here after the first generator poll posts a Task.
    </div>
  );
}

const panelStyle: React.CSSProperties = {
  background: 'var(--bg-elevated)',
  border: '1px solid var(--border)',
  borderRadius: 'var(--radius-3)',
  padding: '20px 22px',
  display: 'flex',
  flexDirection: 'column',
  gap: '12px',
};

const headerStyle: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'space-between',
  gap: '12px',
};

const titleStyle: React.CSSProperties = {
  margin: 0,
  fontFamily: "'Instrument Serif', 'Times New Roman', serif",
  fontSize: '22px',
  color: 'var(--fg)',
  fontWeight: 400,
};

const tableHeaderStyle: React.CSSProperties = {
  display: 'grid',
  gridTemplateColumns: '2fr minmax(130px, 0.9fr) 1.4fr 1fr 0.8fr',
  gap: '12px',
  padding: '8px 14px',
  background: 'var(--bg)',
  fontFamily: "'JetBrains Mono', monospace",
  fontSize: '10px',
  letterSpacing: '0.12em',
  textTransform: 'uppercase',
  color: 'var(--fg-dim)',
  borderBottom: '1px solid var(--border)',
};

const tableRowStyle: React.CSSProperties = {
  display: 'grid',
  gridTemplateColumns: '2fr minmax(130px, 0.9fr) 1.4fr 1fr 0.8fr',
  gap: '12px',
  alignItems: 'center',
  padding: '10px 14px',
  borderBottom: '1px solid var(--border)',
};

const ghostButtonStyle: React.CSSProperties = {
  fontFamily: "'JetBrains Mono', monospace",
  fontSize: '12px',
  padding: '6px 12px',
  background: 'transparent',
  color: 'var(--fg)',
  border: '1px solid var(--border)',
  borderRadius: 'var(--radius-2)',
  cursor: 'pointer',
};

const mutedTextStyle: React.CSSProperties = {
  fontFamily: "'JetBrains Mono', monospace",
  fontSize: '12px',
  color: 'var(--fg-muted)',
  margin: 0,
};
