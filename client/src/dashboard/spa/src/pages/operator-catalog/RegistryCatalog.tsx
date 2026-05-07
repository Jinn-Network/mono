import { useQuery } from '@tanstack/react-query';
import { Link } from 'wouter';
import { api } from '../../api/client.js';
import type {
  RegistryListResponse,
  SolverNetManifestSummary,
} from '../../api/types.js';

/**
 * Operator-side catalog of all launched SolverNets discoverable via the
 * registry endpoint (`/v1/solvernets/registry`).
 *
 * Spec: `spec/2026-05-05-solvernet-creation-and-launch.md` §12 ("Operator
 * discovery and join flow").
 *
 * Replaces the legacy hardcoded "prediction" catalog entry that used to live
 * on Operator > SolverNets. Each card exposes a Join CTA that routes
 * into the join flow (Task 21); for now the route renders a placeholder.
 *
 * Empty state copy is locked to spec §12: "No launched SolverNets available."
 */

const STATUS_TONE: Record<
  SolverNetManifestSummary['status'],
  { fg: string; border: string; label: string }
> = {
  launched: { fg: 'var(--vow-green)', border: 'var(--vow-green)', label: 'Launched' },
  paused: { fg: 'var(--wane)', border: 'var(--wane)', label: 'Paused' },
  retired: { fg: 'var(--fg-dim)', border: 'var(--border)', label: 'Retired' },
};

/** Wei → ETH string; mirrors `pages/launcher-launched/helpers.ts`. */
function formatEthFromWei(wei: string | undefined): string {
  if (!wei || !/^\d+$/.test(wei)) return '—';
  try {
    const n = BigInt(wei);
    const eth = Number(n) / 1e18;
    if (eth === 0) return '0 ETH';
    if (eth < 0.0001) return `${eth.toExponential(3)} ETH`;
    return `${eth.toFixed(eth < 1 ? 6 : 4)} ETH`;
  } catch {
    return '—';
  }
}

function truncateAddress(address: string): string {
  if (!address) return '';
  if (address.length <= 13) return address;
  return `${address.slice(0, 6)}…${address.slice(-4)}`;
}

function formatTimestamp(iso: string | null): string | null {
  if (!iso) return null;
  try {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return iso;
    return d.toISOString().replace('T', ' ').slice(0, 16) + ' UTC';
  } catch {
    return iso;
  }
}

function StatusBadge({
  status,
}: {
  status: SolverNetManifestSummary['status'];
}): JSX.Element {
  const tone = STATUS_TONE[status] ?? STATUS_TONE.launched;
  return (
    <span
      data-testid="registry-status-badge"
      data-status={status}
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

function RoleChips({ openRoles }: { openRoles: SolverNetManifestSummary['openRoles'] }): JSX.Element {
  if (openRoles.length === 0) {
    return (
      <span style={{ color: 'var(--fg-dim)', fontSize: '12px' }}>
        no open roles
      </span>
    );
  }
  return (
    <span style={{ display: 'flex', gap: '6px', flexWrap: 'wrap' }}>
      {openRoles.map((role) => (
        <span
          key={role}
          data-testid="registry-open-role"
          data-role={role}
          style={{
            fontFamily: "'JetBrains Mono', monospace",
            fontSize: '11px',
            letterSpacing: '0.14em',
            textTransform: 'uppercase',
            color: 'var(--fg)',
            border: '1px solid var(--border)',
            borderRadius: '999px',
            padding: '2px 10px',
          }}
        >
          {role}
        </span>
      ))}
    </span>
  );
}

interface RegistryCardProps {
  summary: SolverNetManifestSummary;
  /**
   * Roles the operator has joined for this SolverNet (manifest cid keyed in
   * config.joinedSolverNets). Empty / undefined means not joined.
   */
  joinedRoles?: ReadonlyArray<'solver' | 'evaluator'>;
}

function RegistryCard({ summary, joinedRoles }: RegistryCardProps): JSX.Element {
  const joinHref = `/operator/join/${encodeURIComponent(summary.manifestCid)}`;
  const isJoined = (joinedRoles ?? []).length > 0;
  return (
    <article
      data-testid="registry-card"
      data-manifest-cid={summary.manifestCid}
      style={{
        background: 'var(--bg-elevated)',
        border: '1px solid var(--border)',
        borderRadius: 'var(--radius-2)',
        padding: '16px 20px',
        display: 'flex',
        flexDirection: 'column',
        gap: '12px',
      }}
    >
      <header
        style={{
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'flex-start',
          gap: '16px',
        }}
      >
        <div style={{ display: 'flex', flexDirection: 'column', gap: '6px', minWidth: 0 }}>
          <span
            style={{
              fontFamily: "'JetBrains Mono', monospace",
              fontSize: '15px',
              fontWeight: 500,
              color: 'var(--fg)',
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
            }}
          >
            {summary.name}
          </span>
          <span
            style={{
              fontFamily: "'JetBrains Mono', monospace",
              fontSize: '12px',
              color: 'var(--fg-muted)',
            }}
          >
            Launcher: {truncateAddress(summary.launcherSafeAddress)} · agentId{' '}
            {summary.launcherAgentId}
          </span>
        </div>
        <StatusBadge status={summary.status} />
      </header>

      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'auto 1fr',
          gap: '6px 12px',
          fontFamily: "'JetBrains Mono', monospace",
          fontSize: '12px',
          color: 'var(--fg-muted)',
        }}
      >
        <span>Open roles</span>
        <RoleChips openRoles={summary.openRoles} />
        <span>Solution price</span>
        <span style={{ color: 'var(--fg)' }}>
          {formatEthFromWei(summary.solutionPriceWei)}
        </span>
        <span>Verdict price</span>
        <span style={{ color: 'var(--fg)' }}>
          {formatEthFromWei(summary.verdictPriceWei)}
        </span>
      </div>

      <footer
        style={{
          display: 'flex',
          justifyContent: 'flex-end',
          alignItems: 'center',
          gap: '12px',
        }}
      >
        {isJoined && (
          <span
            data-testid="registry-card-joined"
            data-manifest-cid={summary.manifestCid}
            style={{
              fontFamily: "'JetBrains Mono', monospace",
              fontSize: '11px',
              fontWeight: 500,
              textTransform: 'uppercase',
              letterSpacing: '0.14em',
              color: 'var(--vow-green)',
              border: '1px solid var(--vow-green)',
              borderRadius: 'var(--radius-pill)',
              padding: '4px 10px',
            }}
          >
            JOINED · {(joinedRoles ?? []).join(', ')}
          </span>
        )}
        <Link
          href={joinHref}
          data-testid="registry-join-cta"
          data-manifest-cid={summary.manifestCid}
          style={{
            display: 'inline-block',
            fontFamily: "'JetBrains Mono', monospace",
            fontSize: '13px',
            padding: '8px 16px',
            background:
              summary.status === 'launched' && !isJoined
                ? 'var(--accent-sky)'
                : 'transparent',
            color:
              summary.status === 'launched' && !isJoined
                ? 'var(--bg-sunken)'
                : 'var(--fg-dim)',
            border: `1px solid ${
              summary.status === 'launched' && !isJoined
                ? 'var(--accent-sky)'
                : 'var(--border)'
            }`,
            borderRadius: 'var(--radius-2)',
            textDecoration: 'none',
            cursor: summary.status === 'launched' ? 'pointer' : 'not-allowed',
            pointerEvents: summary.status === 'launched' ? 'auto' : 'none',
          }}
        >
          {isJoined ? 'Edit' : 'Join'}
        </Link>
      </footer>
    </article>
  );
}

export interface RegistryCatalogProps {
  /** Override poll interval for tests. */
  refetchIntervalMs?: number;
}

export function RegistryCatalog({
  refetchIntervalMs = 30_000,
}: RegistryCatalogProps = {}): JSX.Element {
  const { data, isLoading, isError, error, refetch } = useQuery<RegistryListResponse>({
    queryKey: ['solvernets', 'registry'],
    queryFn: () => api.solvernets.listRegistry(),
    refetchInterval: refetchIntervalMs,
  });
  // Joined state — manifest-cid-keyed dict from operator config. Used to
  // render a JOINED badge alongside the Join CTA so operators don't see a
  // stale "Join" button after a successful join. Refetched on the same
  // cadence as the registry; the SPA's join/leave mutations should also
  // invalidate this query (post-mutation cache busts are out of scope here).
  const joinedQuery = useQuery({
    queryKey: ['operator', 'joined'],
    queryFn: () => api.operator.listJoined(),
    refetchInterval: refetchIntervalMs,
  });
  const joinedByCid = joinedQuery.data?.joinedSolverNets ?? {};

  if (isLoading) {
    return (
      <p
        data-testid="registry-catalog-loading"
        style={{
          color: 'var(--fg-muted)',
          fontFamily: "'JetBrains Mono', monospace",
          fontSize: '13px',
          margin: 0,
        }}
      >
        Loading catalog…
      </p>
    );
  }

  if (isError) {
    return (
      <div
        data-testid="registry-catalog-error"
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
            Failed to load registry catalog.
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
          data-testid="registry-catalog-retry"
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
    );
  }

  const summaries = data?.summaries ?? [];
  const lastRefreshed = formatTimestamp(data?.lastRefreshedAt ?? null);
  const lastError = data?.lastError ?? null;

  return (
    <div
      data-testid="registry-catalog"
      style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}
    >
      <div
        style={{
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          fontFamily: "'JetBrains Mono', monospace",
          fontSize: '11px',
          color: 'var(--fg-muted)',
          letterSpacing: '0.14em',
          textTransform: 'uppercase',
        }}
      >
        <span data-testid="registry-catalog-meta">
          {summaries.length} launched · last refreshed{' '}
          {lastRefreshed ?? 'never'}
        </span>
        {lastError && (
          <span
            data-testid="registry-catalog-warn"
            style={{ color: 'var(--wane)' }}
          >
            stale ({lastError.message})
          </span>
        )}
      </div>

      {summaries.length === 0 ? (
        <div
          data-testid="registry-catalog-empty"
          style={{
            background: 'var(--bg-elevated)',
            border: '1px solid var(--border)',
            borderRadius: 'var(--radius-2)',
            padding: '24px 20px',
            color: 'var(--fg-muted)',
            fontFamily: "'JetBrains Mono', monospace",
            fontSize: '13px',
          }}
        >
          No launched SolverNets available.
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
          {summaries.map((summary) => (
            <RegistryCard
              key={summary.manifestCid}
              summary={summary}
              joinedRoles={joinedByCid[summary.manifestCid]?.roles}
            />
          ))}
        </div>
      )}
    </div>
  );
}
