import { useQuery } from '@tanstack/react-query';
import { Link, useLocation } from 'wouter';
import { api } from '../api/client.js';
import type {
  LaunchedSolverNetRecord,
  LaunchedStatus,
  TaskPostCountsDto,
} from '../../../../api/contract/index.js';
import { Alert, AlertDescription, AlertTitle } from '../components/ui/alert.js';
import { Badge } from '../components/ui/badge.js';
import { Button } from '../components/ui/button.js';
import { Card } from '../components/ui/card.js';
import { cn } from '../lib/utils.js';
import { formatEthFromWei } from './launcher-create/draft-helpers.js';

import type { JSX } from 'react';

/**
 * Launcher mode > `/launcher`. Owned-SolverNets list page.
 *
 * Spec: `spec/2026-05-05-solvernet-creation-and-launch.md` §10.
 *
 * Two states:
 *
 *   1. Empty — no launched records owned by this daemon. Surfaces the spec
 *      §10 empty-state copy plus a primary CTA into the 5-step Create flow
 *      (`/launcher/create`, Task 18).
 *
 *   2. Populated — one row per `LaunchedSolverNetRecord` returned by
 *      `api.solvernets.listLaunched()`. The daemon enriches each row with
 *      `record.summary` (a `SolverNetManifestSummary` projected from the
 *      manifest body) when its in-process manifest cache has the cid;
 *      this page renders summary-driven identity (name, contract id /
 *      version, prices, openRoles) when available and falls back to the
 *      bare record fields (solverNetId, truncated manifestCid) on cache
 *      miss. Rows click through to the post-launch dashboard
 *      (`/launcher/launched/:solverNetId`, Task 19).
 */

type BadgeVariant = NonNullable<Parameters<typeof Badge>[0]['variant']>;

const STATUS_BADGE: Record<LaunchedStatus, { variant: BadgeVariant; label: string }> = {
  launching: { variant: 'default', label: 'Launching' },
  launched: { variant: 'success', label: 'Launched' },
  paused: { variant: 'pill', label: 'Paused' },
  retired: { variant: 'outline', label: 'Retired' },
  failed: { variant: 'destructive', label: 'Failed' },
};

function truncateCid(cid: string): string {
  if (cid.length <= 16) return cid;
  return `${cid.slice(0, 8)}…${cid.slice(-6)}`;
}

function formatTimestamp(iso: string): string {
  try {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return iso;
    return d.toISOString().replace('T', ' ').slice(0, 16) + ' UTC';
  } catch {
    return iso;
  }
}

function StatusBadge({ status }: { status: LaunchedStatus }): JSX.Element {
  const badge = STATUS_BADGE[status] ?? STATUS_BADGE.launching;
  return (
    <Badge variant={badge.variant} className="whitespace-nowrap">
      {badge.label}
    </Badge>
  );
}

interface RecordRowProps {
  record: LaunchedSolverNetRecord;
  /** Windowed task-post counts for this row's manifest CID, when available. */
  postCounts?: TaskPostCountsDto;
  /** True while the batched task-post-counts query is in flight. */
  postCountsLoading: boolean;
  /** True when the batched task-post-counts query errored. */
  postCountsError: boolean;
}

/**
 * "Recent posts" cell (#918) — compact `1h · 6h · 24h` windowed on-chain
 * task-post counts for the row's SolverNet. AC#3: when the counts are absent or
 * `h24 === 0`, render a visible "No recent posts" message (never blank); on a
 * query error, render terse "posts unavailable". Block-window approximation.
 */
function RecentPostsCell({
  postCounts,
  loading,
  error,
}: {
  postCounts?: TaskPostCountsDto;
  loading: boolean;
  error: boolean;
}): JSX.Element {
  let inner: JSX.Element;
  if (error) {
    inner = <span className="text-[var(--wane)]">posts unavailable</span>;
  } else if (loading && !postCounts) {
    inner = <span className="text-[var(--fg-dim)]">…</span>;
  } else if (!postCounts || postCounts.h24 === 0) {
    inner = <span className="text-[var(--fg-dim)]">No recent posts</span>;
  } else {
    inner = (
      <span className="text-[var(--fg-muted)]">
        {postCounts.h1} · {postCounts.h6} · {postCounts.h24}
      </span>
    );
  }
  return (
    <div
      data-testid="launcher-owned-row-postcounts"
      className="flex flex-col items-end gap-0.5 font-mono text-[12px]"
    >
      <span className="text-[10px] uppercase tracking-[0.12em] text-[var(--fg-dim)]">
        recent posts (1h · 6h · 24h)
      </span>
      {inner}
    </div>
  );
}

function RoleChip({ label }: { label: string }): JSX.Element {
  return (
    <Badge
      data-testid="launcher-owned-row-role"
      variant="outline"
      className="normal-case tracking-[0.12em] text-[var(--fg-muted)]"
    >
      {label}
    </Badge>
  );
}

function RecordRow({
  record,
  postCounts,
  postCountsLoading,
  postCountsError,
}: RecordRowProps): JSX.Element {
  const [, navigate] = useLocation();
  const href = `/launcher/launched/${encodeURIComponent(record.solverNetId)}`;
  const summary = record.summary;
  // Primary heading: manifest name when the summary is available, else the
  // bare solverNetId. This mirrors the cache-warm vs cache-miss split on
  // the daemon side — we want operators to see "Prediction Markets — V1"
  // when we can, and the raw id is the safe fallback when we can't.
  const primary = summary?.name ?? record.solverNetId;
  const contractLabel =
    summary !== undefined
      ? `${summary.contractId}.${summary.contractVersion}`
      : null;
  return (
    <a
      href={href}
      data-testid="launcher-owned-row"
      data-solvernet-id={record.solverNetId}
      data-has-summary={summary !== undefined ? 'true' : 'false'}
      onClick={(e) => {
        e.preventDefault();
        navigate(href);
      }}
      className="block text-inherit no-underline"
    >
      <Card
        className={cn(
          'grid grid-cols-[1fr_auto] items-center gap-4 p-4',
          'transition-colors hover:bg-[var(--bg-sunken)]/40 cursor-pointer',
        )}
      >
        <div className="flex min-w-0 flex-col gap-1.5">
          <div
            data-testid="launcher-owned-row-primary"
            className={cn(
              'truncate text-foreground',
              summary !== undefined
                ? 'font-serif text-[18px] font-normal tracking-[-0.01em]'
                : 'font-mono text-[14px] font-medium',
            )}
          >
            {primary}
          </div>

          {contractLabel !== null && (
            <div
              data-testid="launcher-owned-row-contract"
              className="font-mono text-[12px] text-[var(--fg-muted)]"
            >
              {contractLabel}
            </div>
          )}

          {summary !== undefined && (
            <div
              data-testid="launcher-owned-row-prices"
              className="flex flex-wrap gap-x-3.5 font-mono text-[12px] text-[var(--fg-muted)]"
            >
              <span>solution {formatEthFromWei(summary.solutionPriceWei)}</span>
              <span>verdict {formatEthFromWei(summary.verdictPriceWei)}</span>
            </div>
          )}

          {summary !== undefined && summary.openRoles.length > 0 && (
            <div
              data-testid="launcher-owned-row-roles"
              className="flex flex-wrap gap-1.5"
            >
              {summary.openRoles.map((role) => (
                <RoleChip key={role} label={role} />
              ))}
            </div>
          )}

          <div className="flex flex-wrap gap-x-3.5 font-mono text-[12px] text-[var(--fg-muted)]">
            <span>cid {truncateCid(record.manifestCid)}</span>
            <span>launched {formatTimestamp(record.launchedAt)}</span>
          </div>
        </div>
        <div className="flex flex-col items-end gap-2">
          <StatusBadge status={record.status} />
          <RecentPostsCell
            postCounts={postCounts}
            loading={postCountsLoading}
            error={postCountsError}
          />
        </div>
      </Card>
    </a>
  );
}

function EmptyState(): JSX.Element {
  return (
    <Card
      data-testid="launcher-empty-state"
      className="flex flex-col gap-3.5 p-8"
    >
      <h2 className="m-0 font-mono text-[18px] font-medium tracking-[-0.01em] text-foreground">
        No SolverNets created yet.
      </h2>
      <p className="m-0 text-[14px] leading-relaxed text-[var(--fg-muted)]">
        Create a SolverNet to direct operators toward a specific kind of
        knowledge work.
      </p>
      <div>
        <Button asChild variant="default" size="lg">
          <Link href="/launcher/create">Create SolverNet</Link>
        </Button>
      </div>
    </Card>
  );
}

export function LauncherPage(): JSX.Element {
  const { data, isLoading, isError, error, refetch } = useQuery({
    queryKey: ['solvernets', 'launched', 'owned'],
    queryFn: () => api.solvernets.listLaunched(),
    refetchInterval: 30_000,
  });

  // Batch the per-row recent-post counts into ONE query keyed by every owned
  // SolverNet's manifest CID (#918). One query, not one-per-row, so a long
  // owned-list doesn't fan out into N daemon round-trips.
  const cids = (data?.records ?? []).map((r) => r.manifestCid);
  const postCountsQuery = useQuery({
    queryKey: ['discovery', 'task-post-counts', 'launcher', cids],
    queryFn: () => api.discovery.getTaskPostCounts(cids),
    enabled: cids.length > 0,
    refetchInterval: 30_000,
  });
  const byCid = postCountsQuery.data?.byCid;

  return (
    <div className="flex flex-col gap-4 p-6">
      <div className="flex items-end justify-between">
        <h1 className="m-0 font-serif text-[32px] font-normal text-foreground">
          Your SolverNets
        </h1>
        {(data?.records.length ?? 0) > 0 && (
          <Button asChild variant="default" data-testid="launcher-create-cta">
            <Link href="/launcher/create">Create SolverNet</Link>
          </Button>
        )}
      </div>

      {isLoading && (
        <p
          data-testid="launcher-loading"
          className="m-0 font-mono text-[13px] text-[var(--fg-muted)]"
        >
          Loading…
        </p>
      )}

      {isError && (
        <Alert
          data-testid="launcher-error"
          variant="blocking"
          className="flex items-center justify-between gap-4 border-l-0 border border-destructive p-4"
        >
          <div className="flex flex-col gap-1">
            <AlertTitle className="font-mono text-[13px] font-medium text-destructive">
              Failed to load your SolverNets.
            </AlertTitle>
            <AlertDescription className="text-[12px] text-[var(--fg-muted)]">
              {error instanceof Error ? error.message : 'Unknown error'}
            </AlertDescription>
          </div>
          <Button
            type="button"
            variant="secondary"
            size="sm"
            onClick={() => {
              void refetch();
            }}
          >
            Retry
          </Button>
        </Alert>
      )}

      {!isLoading && !isError && data && data.records.length === 0 && <EmptyState />}

      {!isLoading && !isError && data && data.records.length > 0 && (
        <div className="flex flex-col gap-2">
          {data.records.map((record) => (
            <RecordRow
              key={record.solverNetId}
              record={record}
              postCounts={byCid?.[record.manifestCid]}
              postCountsLoading={postCountsQuery.isLoading}
              postCountsError={postCountsQuery.isError}
            />
          ))}
        </div>
      )}
    </div>
  );
}
