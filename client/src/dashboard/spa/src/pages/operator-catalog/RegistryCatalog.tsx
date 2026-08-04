import { useQuery } from '@tanstack/react-query';
import { Link } from 'wouter';
import { api } from '../../api/client.js';
import type {
  RegistryErrorCode,
  RegistryListResponse,
  SolverNetManifestSummary,
} from '../../../../../api/contract/index.js';
import { Alert, AlertDescription, AlertTitle } from '../../components/ui/alert.js';
import { Badge } from '../../components/ui/badge.js';
import { Button } from '../../components/ui/button.js';
import { Card } from '../../components/ui/card.js';
import { formatWeiAmount } from '../launcher-launched/helpers.js';
import { isDemoSolverNet, isInternalSolverNet } from '../../lib/demo-solvernet.js';

import type { JSX } from 'react';

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

type BadgeVariant = NonNullable<Parameters<typeof Badge>[0]['variant']>;

const STATUS_BADGE: Record<
  SolverNetManifestSummary['status'],
  { variant: BadgeVariant; label: string }
> = {
  launched: { variant: 'success', label: 'Launched' },
  paused: { variant: 'pill', label: 'Paused' },
  retired: { variant: 'outline', label: 'Retired' },
};

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

function errorCode(error: unknown): string | null {
  if (error instanceof Error) {
    const code = (error as Error & { code?: unknown }).code;
    if (typeof code === 'string') return code;
    if (error.message.includes('subsystem_not_ready')) return 'subsystem_not_ready';
    if (error.message.includes('registry_unavailable')) return 'registry_unavailable';
    if (error.message.includes('rpc_rate_limited')) return 'rpc_rate_limited';
  }
  return null;
}

interface RegistryErrorCopy {
  title: string;
  detail: string;
  /** When set, render an in-app link to this route (e.g. `/operator#network`). */
  actionHref?: string;
  /** Link text for `actionHref`. */
  actionLabel?: string;
}

/**
 * Operator-facing copy for a rate-limited RPC. The default Base Sepolia RPC is
 * shared across the whole operator pool, so a 429 here is an operator-actionable
 * condition — point them at the Network section to add their own free key
 * rather than leaving them with a generic "catalog not found". See
 * jinn-mono #325.
 */
const RPC_RATE_LIMITED_COPY: RegistryErrorCopy = {
  title: 'Your RPC endpoint is rate-limited.',
  detail: 'Open the Network section and add your own free key.',
  actionHref: '/operator#network',
  actionLabel: 'Open Network settings →',
};

function registryErrorCopy(error: unknown): RegistryErrorCopy {
  switch (errorCode(error)) {
    case 'subsystem_not_ready':
      return {
        title: 'SolverNet subsystem is still starting.',
        detail: 'Wait a few seconds, then retry. If this persists, restart the daemon and check its startup logs.',
      };
    case 'registry_unavailable':
      return {
        title: 'Registry cache is unavailable.',
        detail: 'The daemon could not read the SolverNet registry cache. Retry after startup finishes; check daemon logs if it keeps failing.',
      };
    case 'rpc_rate_limited':
      return RPC_RATE_LIMITED_COPY;
    default:
      return {
        title: 'Failed to load registry catalog.',
        detail: error instanceof Error ? error.message : 'Unknown error',
      };
  }
}

/**
 * Stale-catalog indicator shown in the meta row. A registry refresh can fail
 * without the HTTP query itself erroring (the endpoint returns 200 with a
 * populated `lastError`), so this is where a rate-limited RPC actually
 * surfaces in the steady-state UI. The `rpc_rate_limited` branch swaps the
 * generic "stale" text for an operator-actionable line + a deep-link to the
 * Network settings section. See jinn-mono #325.
 */
function RegistryStaleWarning({
  code,
  message,
}: {
  code?: RegistryErrorCode;
  message: string;
}): JSX.Element {
  if (code === 'rpc_rate_limited') {
    return (
      <span
        data-testid="registry-catalog-warn"
        data-error-code="rpc_rate_limited"
        // var(--wane) is unmapped in tailwind config (no shadcn equivalent);
        // used here to mark the warning tone consistent with the brand pill.
        className="inline-flex gap-2 normal-case tracking-normal text-[var(--wane)]"
      >
        <span>RPC rate-limited — add your own key</span>
        <Link
          href="/operator#network"
          data-testid="registry-catalog-warn-action"
          className="text-primary no-underline hover:underline"
        >
          Network settings →
        </Link>
      </span>
    );
  }
  return (
    <span
      data-testid="registry-catalog-warn"
      className="normal-case tracking-normal text-[var(--wane)]"
    >
      stale ({message})
    </span>
  );
}

function StatusBadge({
  status,
}: {
  status: SolverNetManifestSummary['status'];
}): JSX.Element {
  const badge = STATUS_BADGE[status] ?? STATUS_BADGE.launched;
  return (
    <Badge
      data-testid="registry-status-badge"
      data-status={status}
      variant={badge.variant}
      className="whitespace-nowrap"
    >
      {badge.label}
    </Badge>
  );
}

function RoleChips({
  openRoles,
}: {
  openRoles: SolverNetManifestSummary['openRoles'];
}): JSX.Element {
  if (openRoles.length === 0) {
    return (
      <span className="text-[12px] text-[var(--fg-dim)]">no open roles</span>
    );
  }
  return (
    <span className="flex flex-wrap gap-1.5">
      {openRoles.map((role) => (
        <Badge
          key={role}
          data-testid="registry-open-role"
          data-role={role}
          variant="outline"
          className="rounded-full text-foreground"
        >
          {role}
        </Badge>
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
  /**
   * True for the canonical first-run demo net (#1240). When set and the
   * operator has not joined, the card is badged "Recommended demo" and its
   * CTA reads "Try the demo" instead of "Join".
   */
  recommended?: boolean;
}

function RegistryCard({ summary, joinedRoles, recommended }: RegistryCardProps): JSX.Element {
  const joinHref = `/operator/join/${encodeURIComponent(summary.manifestCid)}`;
  const isJoined = (joinedRoles ?? []).length > 0;
  const isLaunched = summary.status === 'launched';
  const ctaLabel = isJoined ? 'Edit' : recommended ? 'Try the demo' : 'Join';
  return (
    <Card
      data-testid="registry-card"
      data-manifest-cid={summary.manifestCid}
      className="flex flex-col gap-3 p-4"
    >
      <article className="flex flex-col gap-3">
        <header className="flex items-start justify-between gap-4">
          <div className="flex min-w-0 flex-col gap-1.5">
            <span
              className={
                summary.name
                  ? 'truncate font-mono text-[15px] font-medium text-foreground'
                  : 'truncate font-mono text-[15px] font-medium italic text-[var(--fg-muted)]'
              }
            >
              {summary.name || 'Metadata pending'}
            </span>
            <span className="font-mono text-[12px] text-[var(--fg-muted)]">
              Launcher: {truncateAddress(summary.launcherSafeAddress)} · agentId{' '}
              {summary.launcherAgentId}
            </span>
          </div>
          <span className="flex items-center gap-2">
            {recommended && !isJoined && (
              <Badge
                data-testid="registry-card-recommended"
                variant="secondary"
                className="whitespace-nowrap"
              >
                Recommended demo
              </Badge>
            )}
            <StatusBadge status={summary.status} />
          </span>
        </header>

        <div className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1.5 font-mono text-[12px] text-[var(--fg-muted)]">
          <span>Open roles</span>
          <RoleChips openRoles={summary.openRoles} />
          <span>Solution price</span>
          <span className="text-foreground">
            {formatWeiAmount(summary.solutionPriceWei)}
          </span>
          <span>Verdict price</span>
          <span className="text-foreground">
            {formatWeiAmount(summary.verdictPriceWei)}
          </span>
        </div>

        <footer className="flex items-center justify-end gap-3">
          {isJoined && (
            <Badge
              data-testid="registry-card-joined"
              data-manifest-cid={summary.manifestCid}
              variant="success"
              className="rounded-full px-2.5 py-1"
            >
              JOINED · {(joinedRoles ?? []).join(', ')}
            </Badge>
          )}
          {isLaunched ? (
            <Button
              asChild
              variant={isJoined ? 'secondary' : 'default'}
              data-testid="registry-join-cta"
              data-manifest-cid={summary.manifestCid}
            >
              <Link href={joinHref}>{ctaLabel}</Link>
            </Button>
          ) : (
            <Button
              type="button"
              variant="secondary"
              data-testid="registry-join-cta"
              data-manifest-cid={summary.manifestCid}
              disabled
              aria-disabled
              className="pointer-events-none"
            >
              {isJoined ? 'Edit' : 'Join'}
            </Button>
          )}
        </footer>
      </article>
    </Card>
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

  if (isLoading || joinedQuery.isLoading) {
    return (
      <p
        data-testid="registry-catalog-loading"
        className="m-0 font-mono text-[13px] text-[var(--fg-muted)]"
      >
        Loading catalog…
      </p>
    );
  }

  if (isError || joinedQuery.isError) {
    const visibleError = isError ? error : joinedQuery.error;
    const copy = registryErrorCopy(visibleError);
    return (
      <Alert
        data-testid="registry-catalog-error"
        variant="blocking"
        className="flex items-center justify-between gap-4 border-l-0 border border-destructive p-4"
      >
        <div className="flex flex-col gap-1">
          <AlertTitle className="font-mono text-[13px] font-medium text-destructive">
            {copy.title}
          </AlertTitle>
          <AlertDescription className="text-[12px] text-[var(--fg-muted)]">
            {copy.detail}
          </AlertDescription>
          {copy.actionHref && copy.actionLabel && (
            <Link
              href={copy.actionHref}
              data-testid="registry-catalog-error-action"
              className="mt-0.5 font-mono text-[12px] text-primary no-underline hover:underline"
            >
              {copy.actionLabel}
            </Link>
          )}
        </div>
        <Button
          type="button"
          variant="secondary"
          size="sm"
          data-testid="registry-catalog-retry"
          onClick={() => {
            void refetch();
          }}
        >
          Retry
        </Button>
      </Alert>
    );
  }

  const allSummaries = data?.summaries ?? [];
  const summaries = allSummaries
    .filter((summary) => joinedByCid[summary.manifestCid] === undefined)
    // AC2: internal / smoke-test nets are never the primary Discover choice.
    .filter((summary) => !isInternalSolverNet(summary))
    // AC1/AC4: hoist the canonical demo net to the top. Stable sort preserves
    // prior order otherwise.
    .sort((a, b) => Number(isDemoSolverNet(b)) - Number(isDemoSolverNet(a)));
  const lastRefreshed = formatTimestamp(data?.lastRefreshedAt ?? null);
  const lastError = data?.lastError ?? null;

  return (
    <div data-testid="registry-catalog" className="flex flex-col gap-3">
      <div className="flex items-center justify-between font-mono text-[11px] uppercase tracking-[0.14em] text-[var(--fg-muted)]">
        <span data-testid="registry-catalog-meta">
          {summaries.length} discoverable · last refreshed{' '}
          {lastRefreshed ?? 'never'}
        </span>
        {lastError && (
          <RegistryStaleWarning
            code={lastError.code}
            message={lastError.message}
          />
        )}
      </div>

      {summaries.length === 0 ? (
        <Card
          data-testid="registry-catalog-empty"
          className="p-6 font-mono text-[13px] text-[var(--fg-muted)]"
        >
          {allSummaries.length === 0
            ? 'No launched SolverNets available.'
            : 'No unjoined SolverNets available.'}
        </Card>
      ) : (
        <div className="flex flex-col gap-2.5">
          {summaries.map((summary) => (
            <RegistryCard
              key={summary.manifestCid}
              summary={summary}
              joinedRoles={joinedByCid[summary.manifestCid]?.roles}
              recommended={isDemoSolverNet(summary)}
            />
          ))}
        </div>
      )}
    </div>
  );
}
