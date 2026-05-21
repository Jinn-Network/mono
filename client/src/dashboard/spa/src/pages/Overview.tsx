import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useMemo, useRef, useState } from 'react';
import { api } from '../api/client.js';
import { WalletCard, type ServiceIdentity } from './overview/WalletCard.js';
import { NodeHealthCard, type DaemonStatus, type RpcStatus } from './overview/NodeHealthCard.js';
import { ActivityCard, type ActivityJoinedNet, type ActivityTask } from './overview/ActivityCard.js';
import { computeEffectivePlugins } from './configuration/effective-plugins.js';
import type { SolverNetsCatalogResponse, TjinnStatus } from '../api/types.js';
import { Alert, AlertDescription } from '../components/ui/alert.js';

/**
 * Subset of /v1/setup/bootstrap we read on /overview. The full bootstrap
 * payload has fleet/service/keystore plumbing we don't need here; this
 * type captures the joined-SolverNet shapes per spec §12 — both the new
 * `joinedSolverNets[<manifestCid>]` shape and the legacy `solverNets`
 * fallback during the Tasks 21/22 migration window.
 */
interface BootstrapWithSolverNets {
  /** Operator's master EOA (the address that holds custody and seeds the node). */
  master_address?: string;
  solverNets?: Record<
    string,
    {
      name?: string;
      manifestCid?: string;
      enabled?: boolean;
      roles?: string[];
      harness?: string;
    }
  >;
  joinedSolverNets?: Record<
    string,
    {
      name?: string;
      manifestCid?: string;
      /** Catalog contract identity — used to match this membership against the SolverNet catalog entry. */
      contract?: { id: string; version: string };
      roles?: string[];
      harness?: string;
      model?: string;
      plugins?: string[];
      disabledDefaultPlugins?: string[];
    }
  >;
}

interface TaskRunRow {
  requestId: string;
  taskId?: string | null;
  taskCid?: string;
  solverType?: string | null;
  state: string;
  taskRole: 'restoration' | 'evaluation' | null;
  implName?: string | null;
  windowStartTs?: number;
  windowEndTs?: number;
  stateUpdatedAt: number;
  manifestCid?: string | null;
  deliveryTxHash?: string | null;
  failureReason?: string | null;
}

interface OverviewStatusV1 {
  fleet?: {
    services?: Array<{
      index: number;
      step: string;
      serviceId?: number | null;
      safeAddress?: string | null;
      agentId?: number | null;
      safeBoundToAgent?: boolean;
      evicted?: boolean;
    }>;
  };
  rewards?: {
    pendingStakingRewardsWei?: string;
    /** Lifetime JINN claimed. Not yet surfaced by the daemon — null until added. */
    claimedJinnLifetime?: string;
    /** ISO timestamp of last claim. Not yet surfaced by the daemon — null until added. */
    lastClaimAt?: string | null;
  };
  /**
   * Real Sepolia tJINN ERC-20 Safe balance (#406, daemon half PR #447).
   * Optional: older daemons predate this field.
   */
  tJinn?: TjinnStatus;
  /** Security metadata. Not yet surfaced by the daemon — field absent until added. */
  security?: {
    lastPasswordRotationAt?: string | null;
  };
  masterGas?: {
    balanceWei?: string;
    runwayDaysExcess?: string | number | null;
  };
  activity?: {
    recent?: Array<{
      id: number;
      ts: string | null;
      kind: string;
      requestId: string | null;
      txHash: string | null;
    }>;
  };
  taskRuns?: {
    totals?: {
      observedTasks?: number;
      activeTaskRuns?: number;
      completed?: number;
      solutions?: number;
      verdicts?: number;
      failed?: number;
      settledFailed?: number;
      localErrors?: number;
    };
    /**
     * Full TaskRunSummary as served by the daemon ({@link
     * client/src/api/task-runs-build.ts}). The Activity card uses
     * manifestCid + role + state + harness + window timestamps; older
     * surfaces that only need state/role/stateUpdatedAt still work via
     * the wider shape.
     */
    inFlight?: TaskRunRow[];
    recentTasks?: TaskRunRow[];
  };
  predictionV1?: {
    /**
     * Mirror of the daemon-side `PredictionOperatorStatus`. Only a subset
     * of fields is consumed here, but the field names must match the
     * actual server payload — earlier copies of this interface invented
     * a top-level `enabled` and `role` that don't exist, which silently
     * left Overview's gating reading a non-existent field.
     * See `client/src/solver-nets/prediction-operator-ux.ts`.
     */
    operator?: {
      ok?: boolean;
      enabled?: boolean;
      nextAction?: { description?: string };
      diagnostics?: Array<{ code: string; severity: string; message: string; configField?: string }>;
      solverNet?: {
        name?: string;
        enabled?: boolean;
        roles?: string[];
      };
    };
    operatorError?: string;
    totals?: {
      observedTasks?: number;
      activeTaskRuns?: number;
      solutions?: number;
      verdicts?: number;
      failed?: number;
      settledFailed?: number;
      localErrors?: number;
    };
    recentTasks?: TaskRunRow[];
  };
}

function formatEth(wei?: string): string {
  if (!wei || !/^\d+$/.test(wei)) return '—';
  try {
    const n = BigInt(wei);
    const eth = Number(n) / 1e18;
    return eth.toFixed(4);
  } catch {
    return '—';
  }
}

/**
 * Format a wei amount for a one-line top-up confirmation. Drips are tiny, so
 * show enough precision to be meaningful (6 dp) without a trailing wall of
 * zeros.
 */
function formatDripEth(wei?: string): string | null {
  if (!wei || !/^\d+$/.test(wei)) return null;
  try {
    const eth = Number(BigInt(wei)) / 1e18;
    return `${eth.toFixed(6)} ETH`;
  } catch {
    return null;
  }
}

/** Shorten a tx hash for inline display (0x1234…abcd). */
function truncTx(hash?: string): string | null {
  if (!hash || hash.length < 12) return hash ?? null;
  return `${hash.slice(0, 6)}…${hash.slice(-4)}`;
}

/**
 * Inline blocking banner that surfaces when a service has been evicted from
 * staking. Lives in the main column above everything else so the operator
 * sees the Re-stake action without scrolling. The `service_evicted`
 * notification covers operators who land elsewhere; this banner covers the
 * operator who's already on /overview.
 */
function EvictionBanner({
  serviceId,
  onRestake,
}: {
  serviceId: number | null;
  onRestake: (serviceId: number) => Promise<void>;
}): JSX.Element {
  const [restaking, setRestaking] = useState(false);
  return (
    <section
      data-testid="overview-eviction-banner"
      className="j-surface-primary j-surface--blocking"
      aria-live="polite"
      style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-2)' }}
    >
      <span
        style={{
          fontFamily: 'var(--mono)',
          fontSize: 'var(--text-xs)',
          fontWeight: 500,
          letterSpacing: '0.14em',
          textTransform: 'uppercase',
          color: 'var(--severity-blocking-fg)',
        }}
      >
        Service evicted
      </span>
      <p style={{ margin: 0, fontFamily: 'var(--mono)', fontSize: 'var(--text-base)', color: 'var(--fg)' }}>
        A service has been evicted from staking. Re-stake to resume earning.
      </p>
      {serviceId != null && (
        <button
          type="button"
          data-testid="overview-eviction-restake"
          disabled={restaking}
          onClick={async () => {
            if (restaking) return;
            setRestaking(true);
            try {
              await onRestake(serviceId);
            } finally {
              setRestaking(false);
            }
          }}
          style={{
            alignSelf: 'flex-start',
            marginTop: 'var(--space-2)',
            background: 'transparent',
            border: '1px solid var(--severity-blocking-fg)',
            borderRadius: 'var(--radius-2)',
            color: 'var(--severity-blocking-fg)',
            cursor: restaking ? 'wait' : 'pointer',
            fontFamily: 'var(--mono)',
            fontSize: 'var(--text-xs)',
            letterSpacing: '0.14em',
            opacity: restaking ? 0.55 : 1,
            padding: '6px 10px',
            textTransform: 'uppercase',
          }}
        >
          {restaking ? 'Working...' : 'Re-stake now'}
        </button>
      )}
    </section>
  );
}

export function OverviewPage(): JSX.Element {
  const [activeAction, setActiveAction] = useState<string | null>(null);
  const [notice, setNotice] = useState<{ tone: 'success' | 'error'; text: string } | null>(null);
  const queryClient = useQueryClient();
  const { data: status, isError: statusIsError } = useQuery<OverviewStatusV1>({
    queryKey: ['status'],
    queryFn: () => api.getStatus() as Promise<OverviewStatusV1>,
    refetchInterval: 5_000,
  });
  const { data: bootstrap } = useQuery<BootstrapWithSolverNets>({
    queryKey: ['bootstrap'],
    queryFn: () => api.getBootstrap() as Promise<BootstrapWithSolverNets>,
    refetchInterval: 30_000,
  });
  // SolverNet catalog — supplies `compatiblePlugins` per contract, which the
  // effective-plugin computation overlays on top of the harness defaults so
  // catalog defaults (e.g. swe-rebench-v2-runtime) show up on the dashboard
  // even when the operator's explicit `plugins` array is empty.
  const { data: catalog } = useQuery<SolverNetsCatalogResponse>({
    queryKey: ['solvernets', 'catalog'],
    queryFn: () => api.getSolverNets(),
    // Catalog rarely changes; revalidating every few minutes is plenty.
    refetchInterval: 5 * 60_000,
  });

  const services: ServiceIdentity[] = (status?.fleet?.services ?? []).map((s) => ({
    index: s.index,
    safeAddress: s.safeAddress ?? '',
    agentId: s.agentId ?? null,
    safeBoundToAgent: s.safeBoundToAgent ?? false,
  }));

  // Eviction state — derived from the first evicted service in the fleet.
  // Surfaces as an inline blocking banner above the main column rather than
  // a hidden stat-tile child. The `service_evicted` notification handles the
  // operator-came-from-elsewhere case.
  const firstEvictedService = (status?.fleet?.services ?? []).find((s) => s.evicted === true);
  const isEvicted = firstEvictedService != null;
  const evictedServiceId = firstEvictedService?.serviceId ?? null;

  const jinnClaimable = formatEth(status?.rewards?.pendingStakingRewardsWei);

  // tJINN earned — the real Sepolia ERC-20 Safe balance (#406). When the read
  // has resolved (`state === 'ready'`) a null `safeBalanceWei` is a
  // confirmed-empty balance, so format it as '0' rather than the bare '—'
  // `formatEth` returns for missing input. `pending`/`error` keep '—'; the
  // state copy handled by WalletCard's `tjinnDisplay` carries the meaning.
  const tjinnState = status?.tJinn?.state ?? 'pending';
  const tjinnEarned =
    status?.tJinn?.state === 'ready'
      ? formatEth(status.tJinn.safeBalanceWei ?? '0')
      : formatEth(status?.tJinn?.safeBalanceWei ?? undefined);
  const tjinnError = status?.tJinn?.error ?? null;

  const gasBalanceEth = formatEth(status?.masterGas?.balanceWei);
  const gasRunwayDays = status?.masterGas?.runwayDaysExcess ?? '—';

  // ── Activity card inputs ────────────────────────────────────────────
  //
  // Joined: project `bootstrap.joinedSolverNets` into the ActivityCard
  // shape. The legacy short-name `solverNets` shape (a relic of pre-spec-§12
  // configs) is accepted as a fallback so operators who haven't restarted
  // since the migration still see their net.
  const joinedNets: ActivityJoinedNet[] = useMemo(() => {
    const out: ActivityJoinedNet[] = [];
    const j = bootstrap?.joinedSolverNets;
    if (j) {
      for (const [key, entry] of Object.entries(j)) {
        if (!entry) continue;
        // Match the catalog entry by contract identity. The daemon's
        // bootstrap stores only the operator's explicit overrides; the
        // catalog supplies the default-on plugins (e.g. swe-rebench-v2-runtime).
        const catalogEntry = entry.contract
          ? catalog?.nets.find(
              (n) =>
                n.contract.id === entry.contract?.id &&
                n.contract.version === entry.contract?.version,
            )
          : undefined;
        const plugins = computeEffectivePlugins({
          harness: entry.harness,
          explicit: Array.isArray(entry.plugins) ? entry.plugins : [],
          disabledDefaults: Array.isArray(entry.disabledDefaultPlugins)
            ? entry.disabledDefaultPlugins
            : [],
          catalogCompatible: catalogEntry?.compatiblePlugins,
        });
        out.push({
          name: entry.name ?? entry.manifestCid ?? key,
          manifestCid: entry.manifestCid ?? key,
          roles: Array.isArray(entry.roles) ? entry.roles : [],
          harness: entry.harness,
          model: entry.model,
          plugins,
        });
      }
    }
    if (out.length > 0) return out;
    // Fallback: legacy shape. No `contract` field here, so we can't look up
    // the catalog entry — compute plugins from harness defaults only.
    const legacy = bootstrap?.solverNets;
    if (legacy) {
      for (const [key, entry] of Object.entries(legacy)) {
        if (!entry) continue;
        const roles = Array.isArray(entry.roles) ? entry.roles : [];
        if (entry.enabled !== true && roles.length === 0) continue;
        const plugins = computeEffectivePlugins({
          harness: entry.harness,
          explicit: [],
          disabledDefaults: [],
        });
        out.push({
          name: entry.name ?? key,
          manifestCid: entry.manifestCid ?? key,
          roles,
          harness: entry.harness,
          plugins,
        });
      }
    }
    return out;
  }, [bootstrap, catalog]);

  // Tasks: union of `taskRuns.recentTasks` and (when present)
  // `predictionV1.recentTasks`, deduplicated by requestId. The daemon emits
  // the same task into both arrays for prediction.v1 runs; we take the
  // taskRuns shape (which carries manifestCid + harness) as canonical.
  const activityTasks: ActivityTask[] = useMemo(() => {
    const out = new Map<string, ActivityTask>();
    const ingest = (rows: TaskRunRow[] | undefined): void => {
      if (!rows) return;
      for (const r of rows) {
        if (!r.requestId) continue;
        if (out.has(r.requestId)) continue;
        out.set(r.requestId, {
          requestId: r.requestId,
          manifestCid: r.manifestCid ?? null,
          taskRole: r.taskRole,
          state: r.state,
          implName: r.implName ?? null,
          windowStartTs: r.windowStartTs ?? 0,
          stateUpdatedAt: r.stateUpdatedAt,
          deliveryTxHash: r.deliveryTxHash ?? null,
        });
      }
    };
    ingest(status?.taskRuns?.recentTasks);
    ingest(status?.taskRuns?.inFlight);
    ingest(status?.predictionV1?.recentTasks);
    return Array.from(out.values()).sort((a, b) => b.stateUpdatedAt - a.stateUpdatedAt);
  }, [status]);

  // Node Health derivation. Daemon status is "running" as long as the most
  // recent /v1/status fetch succeeded — useQuery keeps stale data across a
  // failure window, so we read `isError` to detect a hard drop. RPC health
  // is not yet surfaced by the daemon; we render "healthy" until the
  // backend ships it (currently hardcoded `rpcHealthy={true}` in App.tsx).
  const daemonStatus: DaemonStatus = statusIsError && status === undefined ? 'stopped' : 'running';
  const rpcStatus: RpcStatus = 'healthy';
  // No daemon state-message line under "Running" — the prior `liveNow.line`
  // text was idle copy like "waiting for next task" that added nothing.
  // Attention-worthy state (harness mismatch, eviction) surfaces through
  // the notifications row (spec §2.10) and the eviction banner above;
  // Node Health stays a glance-level health card.
  const daemonStateMessage: string | undefined = undefined;

  // Auto-clear timer for transient success notices (e.g. the gas top-up
  // confirmation, which should surface the amount + tx hash for ~5s then
  // fade — issue #336).
  const noticeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(
    () => () => {
      if (noticeTimerRef.current) clearTimeout(noticeTimerRef.current);
    },
    [],
  );

  const runAction = (
    label: string,
    action: () => Promise<{ message?: string } | void> | { message?: string } | void,
    opts?: { autoClearMs?: number },
  ): void => {
    setActiveAction(label);
    setNotice(null);
    if (noticeTimerRef.current) {
      clearTimeout(noticeTimerRef.current);
      noticeTimerRef.current = null;
    }
    Promise.resolve()
      .then(action)
      .then((result) => {
        setNotice({
          tone: 'success',
          text: result?.message ?? `${label} requested.`,
        });
        if (opts?.autoClearMs) {
          noticeTimerRef.current = setTimeout(() => {
            setNotice(null);
            noticeTimerRef.current = null;
          }, opts.autoClearMs);
        }
      })
      .catch((err) => {
        setNotice({
          tone: 'error',
          text: err instanceof Error ? err.message : String(err),
        });
      })
      .finally(() => setActiveAction(null));
  };

  return (
    <div
      data-testid="overview-page-grid"
      style={{
        padding: 'var(--space-5)',
        display: 'grid',
        gridTemplateColumns: 'minmax(0, 1fr) minmax(0, 380px)',
        gap: 'var(--space-5)',
        alignItems: 'start',
      }}
    >
      {/* ── MAIN COLUMN ──────────────────────────────────────────────── */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-5)', minWidth: 0 }}>
        {isEvicted && (
          <EvictionBanner
            serviceId={evictedServiceId}
            onRestake={async (serviceId) => {
              const res = await api.restake(serviceId);
              if (!res.ok) {
                throw new Error(res.error ?? 'Re-stake failed.');
              }
              await queryClient.invalidateQueries({ queryKey: ['status'] });
            }}
          />
        )}

        {notice && (
          <Alert
            variant={notice.tone === 'error' ? 'blocking' : 'success'}
            role={notice.tone === 'error' ? 'alert' : 'status'}
            data-testid="dashboard-action-notice"
            className="rounded-md border border-l-2 px-3 py-2.5"
          >
            <AlertDescription
              className={
                notice.tone === 'error'
                  ? 'text-[var(--break-red)]'
                  : 'text-[var(--vow-green)]'
              }
            >
              {notice.text}
            </AlertDescription>
          </Alert>
        )}

        {/*
         * Activity — the operator's view of their node's work. One surface
         * replaces the prior Network · counters / Solving on / In-flight /
         * Recent / Harness Status quintet. The aggregate counters are gone
         * (the marketplace explorer is the right place for those); the
         * detailed per-task table is here so the operator sees *what
         * happened* on each task. Spec §2.4 Memberships + §2.6 Tasks.
         */}
        <ActivityCard joined={joinedNets} tasks={activityTasks} />
      </div>

      {/* ── RIGHT RAIL ───────────────────────────────────────────────── */}
      {/*
        Sticky is gone — Node Health + Wallet combined is too tall to
        stick on a normal-height viewport, and a sticky overflow makes
        the column un-scrollable. The aside flows with the page now.
      */}
      <aside
        style={{
          display: 'flex',
          flexDirection: 'column',
          gap: 'var(--space-5)',
        }}
      >
        <NodeHealthCard
          daemonStatus={daemonStatus}
          daemonStateMessage={daemonStateMessage}
          rpcStatus={rpcStatus}
          onStop={async () => {
            const res = await api.stopDaemon();
            if (!res.ok) {
              throw new Error('Stop request failed.');
            }
          }}
          onRestart={async () => {
            // Pass `forceRespawn: true` so the daemon respawns even when
            // launched with `--no-ui` (`JINN_NO_UI=1`) — without it the
            // operator clicks Restart in headless mode and the daemon just
            // stops. See client/src/restart-daemon.ts.
            const res = await api.restartDaemon({ forceRespawn: true });
            if (!res.ok) {
              throw new Error('Restart request failed.');
            }
          }}
        />

        <WalletCard
          totalEth={gasBalanceEth}
          runwayDays={gasRunwayDays}
          actionsDisabled={activeAction !== null}
          perRole={{
            // Only masterGas is currently exposed by /v1/status; per-role
            // drill-down is commented out inside WalletCard. Keep the
            // values flowing so re-enabling is a one-block restore.
            master: gasBalanceEth,
            agent: '—',
            safe: '—',
          }}
          claimableJinn={jinnClaimable}
          claimedJinnLifetime={status?.rewards?.claimedJinnLifetime ?? '0'}
          tjinnEarned={tjinnEarned}
          tjinnState={tjinnState}
          tjinnError={tjinnError}
          lastClaimAt={status?.rewards?.lastClaimAt ?? null}
          agentId={services[0]?.agentId ?? null}
          masterAddress={bootstrap?.master_address ?? null}
          safeAddress={services[0]?.safeAddress ?? null}
          services={services}
          lastPasswordRotationAt={status?.security?.lastPasswordRotationAt ?? null}
          onTopUp={() =>
            runAction(
              'Top up gas',
              async () => {
                // Issue #336: one explicit click → exactly one faucet drip.
                // `singleDrip: true` makes the daemon fire the faucet once and
                // return immediately — no server-side loop, so the gas number
                // never "magically" keeps climbing while the Dashboard is open.
                const res = await api.triggerDrip({ singleDrip: true });
                if (!res.ok) {
                  throw new Error(res.reason ?? 'Gas top-up failed.');
                }
                const txHash = res.txHash ?? res.txHashes?.at(-1);
                if (!txHash) {
                  return { message: 'Gas top-up checked; the faucet sent no funds.' };
                }
                const amount = formatDripEth(res.deltaWei);
                const txLabel = truncTx(txHash);
                return {
                  message: amount
                    ? `Gas topped up: +${amount} · tx ${txLabel}`
                    : `Gas top-up sent · tx ${txLabel}`,
                };
              },
              // Confirmation is transient — surface it, then fade after ~5s.
              { autoClearMs: 5_000 },
            )}
          onClaim={() =>
            runAction('Claim JINN', async () => {
              const res = await api.claimRewards();
              if (!res.ok) {
                throw new Error(res.error ?? 'Reward claim failed.');
              }
              return { message: 'JINN claim command completed.' };
            })}
        />
      </aside>
    </div>
  );
}
