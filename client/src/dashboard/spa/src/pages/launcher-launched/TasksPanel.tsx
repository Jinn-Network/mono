import { useState, type JSX } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api } from '../../api/client.js';
import type {
  LaunchedSolverNetRecord,
  LauncherTaskEntry,
  LauncherTaskState,
  LauncherTasksResponse,
  TaskOnchainStatus,
} from '../../../../../api/contract/index.js';
import { Button } from '../../components/ui/button.js';
import { Card } from '../../components/ui/card.js';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '../../components/ui/table.js';
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '../../components/ui/tooltip.js';
import { Badge } from '../../components/ui/badge.js';
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

type BadgeVariant = NonNullable<Parameters<typeof Badge>[0]['variant']>;

const STATE_TONE: Record<LauncherTaskState, { variant: BadgeVariant; label: string }> = {
  open: { variant: 'default', label: 'Open' },
  'claims-in-flight': { variant: 'default', label: 'In flight' },
  'fully-claimed': { variant: 'success', label: 'Claimed' },
  settled: { variant: 'success', label: 'Settled' },
  failed: { variant: 'destructive', label: 'Failed' },
};

// On-chain finalization chip (#579). Sourced from the indexer `task` table
// (finalized/refunded/claimWindowEnd), DISTINCT from the local `state` above.
// 'unknown' has no entry here — it renders a muted dash, never a guessed Open.
const ONCHAIN_TONE: Record<
  Exclude<TaskOnchainStatus, 'unknown'>,
  { variant: BadgeVariant; label: string }
> = {
  finalized: { variant: 'success', label: 'Finalized' },
  open: { variant: 'outline', label: 'Open' },
  expired: { variant: 'warning', label: 'Expired' },
};

export interface TasksPanelProps {
  record: LaunchedSolverNetRecord;
  /**
   * Override the fetcher in tests. Defaults to
   * `api.fetchLauncherTasks({ cursor, limit, manifestCid })`.
   */
  fetchTasks?: (opts: {
    cursor?: string;
    limit?: number;
    manifestCid?: string;
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
    queryKey: ['launcher-tasks', record.solverNetId, record.manifestCid, cursor ?? null],
    queryFn: () => fetcher({ cursor, limit: PAGE_SIZE, manifestCid: record.manifestCid }),
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
    <TooltipProvider delayDuration={150}>
      <Card
        data-testid="launcher-launched-tasks-panel"
        role="region"
        aria-label="Recent posted Tasks"
        className="flex flex-col gap-3 p-6"
      >
        <header className="flex items-center justify-between gap-3">
          <h2 className="m-0 font-serif text-[22px] font-normal text-foreground">
            Recent posted Tasks
          </h2>
          <Button
            type="button"
            variant="secondary"
            size="sm"
            data-testid="launcher-launched-tasks-refresh"
            onClick={() => {
              void refetch();
            }}
          >
            Refresh
          </Button>
        </header>

        {isLoading && (
          <p
            data-testid="launcher-launched-tasks-loading"
            className="m-0 font-mono text-[12px] text-[var(--fg-muted)]"
          >
            Loading…
          </p>
        )}

        {isError && (
          <div
            data-testid="launcher-launched-tasks-error"
            className="font-mono text-[12px] text-destructive"
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
              className="overflow-hidden rounded-md border border-border"
            >
              <Table className="table-fixed">
                <TableHeader>
                  <TableRow className="bg-[var(--bg)] hover:bg-[var(--bg)]">
                    <TableHead className="w-[30%]">Task</TableHead>
                    <TableHead className="w-[16%]">SolverType</TableHead>
                    <TableHead className="w-[20%]">Posted</TableHead>
                    <TableHead className="w-[14%]">Local State</TableHead>
                    <TableHead className="w-[20%] text-right">Claims / On-chain</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {data.tasks.map((task) => (
                    <TaskRow key={task.taskId} task={task} />
                  ))}
                </TableBody>
              </Table>
            </div>

            <div className="flex items-center justify-between gap-3">
              <Button
                type="button"
                variant="secondary"
                size="sm"
                data-testid="launcher-launched-tasks-prev"
                onClick={onBack}
                disabled={cursorStack.length <= 1}
              >
                ← Newer
              </Button>
              <span className="m-0 font-mono text-[12px] text-[var(--fg-muted)]">
                Page {cursorStack.length}
                {data.tasks.length < PAGE_SIZE && data.cursor === undefined
                  ? ' · end'
                  : ''}
              </span>
              <Button
                type="button"
                variant="secondary"
                size="sm"
                data-testid="launcher-launched-tasks-next"
                onClick={onNext}
                disabled={!data.cursor?.before}
              >
                Older →
              </Button>
            </div>
          </>
        )}
      </Card>
    </TooltipProvider>
  );
}

function TaskRow({ task }: { task: LauncherTaskEntry }): JSX.Element {
  const tone = STATE_TONE[task.state] ?? { variant: 'secondary' as BadgeVariant, label: task.state };
  const titleText = task.summary?.title ?? truncateCid(task.taskCid);
  const solverLabel = task.solverType ?? task.solverNet;
  const onchainStatus = normalizeOnchainStatus(task.onchainStatus);
  return (
    <TableRow
      data-testid="launcher-launched-task-row"
      data-task-id={task.taskId}
    >
      <TableCell className="font-mono text-[13px] text-foreground">
        <Tooltip>
          <TooltipTrigger asChild>
            <span className="block truncate" tabIndex={0}>
              {titleText}
            </span>
          </TooltipTrigger>
          <TooltipContent>{task.taskCid}</TooltipContent>
        </Tooltip>
      </TableCell>
      <TableCell className="font-mono text-[12px] text-[var(--fg-muted)]">
        <Tooltip>
          <TooltipTrigger asChild>
            <span className="block truncate" tabIndex={0}>
              {solverLabel}
            </span>
          </TooltipTrigger>
          <TooltipContent>{solverLabel}</TooltipContent>
        </Tooltip>
      </TableCell>
      <TableCell className="font-mono text-[12px] text-[var(--fg-muted)]">
        {formatTimestamp(task.postedAt)}
      </TableCell>
      <TableCell>
        <Badge variant={tone.variant} className="normal-case tracking-[0.1em]">
          {tone.label}
        </Badge>
      </TableCell>
      <TableCell className="text-right font-mono text-[12px] text-[var(--fg-muted)]">
        <span className="inline-flex items-center justify-end gap-2">
          <span>
            {task.claims.current} / {task.claims.max}
          </span>
          <OnchainStatusChip status={onchainStatus} />
        </span>
      </TableCell>
    </TableRow>
  );
}

function normalizeOnchainStatus(status: TaskOnchainStatus | undefined): TaskOnchainStatus {
  if (status === 'finalized' || status === 'open' || status === 'expired') return status;
  return 'unknown';
}

function OnchainStatusChip({ status }: { status: TaskOnchainStatus }): JSX.Element {
  if (status === 'unknown') {
    return (
      <span
        data-testid="launcher-launched-task-onchain"
        aria-label="On-chain status unknown"
        className="text-[var(--fg-muted)]"
      >
        —
      </span>
    );
  }

  const tone = ONCHAIN_TONE[status];
  return (
    <Badge
      data-testid="launcher-launched-task-onchain"
      aria-label={`On-chain status: ${tone.label}`}
      variant={tone.variant}
      className="rounded-sm normal-case tracking-[0.1em]"
    >
      {tone.label}
    </Badge>
  );
}

function EmptyState(): JSX.Element {
  return (
    <div
      data-testid="launcher-launched-tasks-empty"
      className="rounded-md border border-dashed border-border p-6 text-center font-mono text-[13px] text-[var(--fg-muted)]"
    >
      Tasks will appear here after the first generator poll posts a Task.
    </div>
  );
}
