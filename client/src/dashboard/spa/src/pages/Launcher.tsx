import { useQuery } from '@tanstack/react-query';
import { Link, useLocation } from 'wouter';
import { api } from '../api/client.js';
import type { LaunchedSolverNetRecord, LaunchedStatus } from '../api/types.js';
import { formatEthFromWei } from './launcher-create/draft-helpers.js';

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

const STATUS_TONE: Record<
  LaunchedStatus,
  { fg: string; border: string; label: string }
> = {
  launching: { fg: 'var(--accent-sky)', border: 'var(--accent-sky)', label: 'Launching' },
  launched: { fg: 'var(--vow-green)', border: 'var(--vow-green)', label: 'Launched' },
  paused: { fg: 'var(--wane)', border: 'var(--wane)', label: 'Paused' },
  retired: { fg: 'var(--fg-dim)', border: 'var(--border)', label: 'Retired' },
  failed: { fg: 'var(--break-red)', border: 'var(--break-red)', label: 'Failed' },
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
  const tone = STATUS_TONE[status] ?? STATUS_TONE.launching;
  return (
    <span
      style={{
        fontFamily: "'JetBrains Mono', monospace",
        fontSize: '11px',
        fontWeight: 500,
        textTransform: 'uppercase',
        letterSpacing: '0.14em',
        color: tone.fg,
        border: `1px solid ${tone.border}`,
        borderRadius: 'var(--radius-1)',
        padding: '2px 8px',
        whiteSpace: 'nowrap',
      }}
    >
      {tone.label}
    </span>
  );
}

interface RecordRowProps {
  record: LaunchedSolverNetRecord;
}

function RoleChip({ label }: { label: string }): JSX.Element {
  return (
    <span
      data-testid="launcher-owned-row-role"
      style={{
        fontFamily: "'JetBrains Mono', monospace",
        fontSize: '11px',
        textTransform: 'uppercase',
        letterSpacing: '0.12em',
        color: 'var(--fg-muted)',
        border: '1px solid var(--border)',
        borderRadius: 'var(--radius-1)',
        padding: '1px 6px',
      }}
    >
      {label}
    </span>
  );
}

function RecordRow({ record }: RecordRowProps): JSX.Element {
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
      style={{
        display: 'grid',
        gridTemplateColumns: '1fr auto',
        alignItems: 'center',
        gap: '16px',
        padding: '16px 20px',
        background: 'var(--bg-elevated)',
        border: '1px solid var(--border)',
        borderRadius: 'var(--radius-2)',
        textDecoration: 'none',
        color: 'inherit',
        cursor: 'pointer',
      }}
    >
      <div style={{ display: 'flex', flexDirection: 'column', gap: '6px', minWidth: 0 }}>
        <div
          data-testid="launcher-owned-row-primary"
          style={{
            fontFamily: summary !== undefined
              ? "'Instrument Serif', 'Times New Roman', serif"
              : "'JetBrains Mono', monospace",
            fontSize: summary !== undefined ? '18px' : '14px',
            fontWeight: summary !== undefined ? 400 : 500,
            color: 'var(--fg)',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
            letterSpacing: summary !== undefined ? '-0.01em' : undefined,
          }}
        >
          {primary}
        </div>

        {contractLabel !== null && (
          <div
            data-testid="launcher-owned-row-contract"
            style={{
              fontFamily: "'JetBrains Mono', monospace",
              fontSize: '12px',
              color: 'var(--fg-muted)',
            }}
          >
            {contractLabel}
          </div>
        )}

        {summary !== undefined && (
          <div
            data-testid="launcher-owned-row-prices"
            style={{
              display: 'flex',
              gap: '14px',
              fontFamily: "'JetBrains Mono', monospace",
              fontSize: '12px',
              color: 'var(--fg-muted)',
              flexWrap: 'wrap',
            }}
          >
            <span>solution {formatEthFromWei(summary.solutionPriceWei)}</span>
            <span>verdict {formatEthFromWei(summary.verdictPriceWei)}</span>
          </div>
        )}

        {summary !== undefined && summary.openRoles.length > 0 && (
          <div
            data-testid="launcher-owned-row-roles"
            style={{ display: 'flex', gap: '6px', flexWrap: 'wrap' }}
          >
            {summary.openRoles.map((role) => (
              <RoleChip key={role} label={role} />
            ))}
          </div>
        )}

        <div
          style={{
            display: 'flex',
            gap: '14px',
            fontFamily: "'JetBrains Mono', monospace",
            fontSize: '12px',
            color: 'var(--fg-muted)',
            flexWrap: 'wrap',
          }}
        >
          <span>cid {truncateCid(record.manifestCid)}</span>
          <span>launched {formatTimestamp(record.launchedAt)}</span>
        </div>
      </div>
      <StatusBadge status={record.status} />
    </a>
  );
}

function EmptyState(): JSX.Element {
  return (
    <div
      data-testid="launcher-empty-state"
      style={{
        background: 'var(--bg-elevated)',
        border: '1px solid var(--border)',
        borderRadius: 'var(--radius-3)',
        padding: '32px 24px',
        display: 'flex',
        flexDirection: 'column',
        gap: '14px',
      }}
    >
      <h2
        style={{
          fontFamily: "'JetBrains Mono', monospace",
          fontSize: '18px',
          fontWeight: 500,
          color: 'var(--fg)',
          margin: 0,
          letterSpacing: '-0.01em',
        }}
      >
        No SolverNets created yet.
      </h2>
      <p
        style={{
          color: 'var(--fg-muted)',
          fontSize: '14px',
          lineHeight: 1.5,
          margin: 0,
        }}
      >
        Create a SolverNet to direct operators toward a specific kind of
        knowledge work.
      </p>
      <div>
        <Link
          href="/launcher/create"
          style={{
            display: 'inline-block',
            fontFamily: "'JetBrains Mono', monospace",
            fontSize: '14px',
            padding: '12px 20px',
            background: 'var(--accent-sky)',
            color: 'var(--bg-sunken)',
            border: '1px solid var(--accent-sky)',
            borderRadius: 'var(--radius-2)',
            textDecoration: 'none',
            cursor: 'pointer',
          }}
        >
          Create SolverNet
        </Link>
      </div>
    </div>
  );
}

export function LauncherPage(): JSX.Element {
  const { data, isLoading, isError, error, refetch } = useQuery({
    queryKey: ['solvernets', 'launched', 'owned'],
    queryFn: () => api.solvernets.listLaunched(),
    refetchInterval: 30_000,
  });

  return (
    <div
      style={{
        padding: '24px',
        display: 'flex',
        flexDirection: 'column',
        gap: '16px',
      }}
    >
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-end' }}>
        <h1
          style={{
            fontFamily: "'Instrument Serif', 'Times New Roman', serif",
            fontSize: '32px',
            margin: 0,
            color: 'var(--fg)',
            fontWeight: 400,
          }}
        >
          Your SolverNets
        </h1>
        {(data?.records.length ?? 0) > 0 && (
          <Link
            href="/launcher/create"
            data-testid="launcher-create-cta"
            style={{
              fontFamily: "'JetBrains Mono', monospace",
              fontSize: '13px',
              padding: '10px 16px',
              background: 'var(--accent-sky)',
              color: 'var(--bg-sunken)',
              border: '1px solid var(--accent-sky)',
              borderRadius: 'var(--radius-2)',
              textDecoration: 'none',
              cursor: 'pointer',
            }}
          >
            Create SolverNet
          </Link>
        )}
      </div>

      {isLoading && (
        <p
          data-testid="launcher-loading"
          style={{ color: 'var(--fg-muted)', fontSize: '13px', margin: 0 }}
        >
          Loading…
        </p>
      )}

      {isError && (
        <div
          data-testid="launcher-error"
          style={{
            background: 'var(--bg-elevated)',
            border: '1px solid var(--break-red)',
            borderRadius: 'var(--radius-2)',
            padding: '16px 20px',
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center',
            gap: '16px',
          }}
        >
          <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
            <span
              style={{
                color: 'var(--break-red)',
                fontFamily: "'JetBrains Mono', monospace",
                fontSize: '13px',
                fontWeight: 500,
              }}
            >
              Failed to load your SolverNets.
            </span>
            <span style={{ color: 'var(--fg-muted)', fontSize: '12px' }}>
              {error instanceof Error ? error.message : 'Unknown error'}
            </span>
          </div>
          <button
            type="button"
            onClick={() => {
              void refetch();
            }}
            style={{
              fontFamily: "'JetBrains Mono', monospace",
              fontSize: '13px',
              padding: '8px 14px',
              background: 'transparent',
              color: 'var(--fg)',
              border: '1px solid var(--border)',
              borderRadius: 'var(--radius-2)',
              cursor: 'pointer',
            }}
          >
            Retry
          </button>
        </div>
      )}

      {!isLoading && !isError && data && data.records.length === 0 && <EmptyState />}

      {!isLoading && !isError && data && data.records.length > 0 && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
          {data.records.map((record) => (
            <RecordRow key={record.solverNetId} record={record} />
          ))}
        </div>
      )}
    </div>
  );
}
