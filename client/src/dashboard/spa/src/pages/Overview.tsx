import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useMemo, useState, type JSX } from 'react';
import { toast } from 'sonner';
import { api } from '../api/client.js';
import { WalletCard, type ServiceIdentity } from './overview/WalletCard.js';
import { IdentityCard } from './overview/IdentityCard.js';
import { NodeHealthCard, type DaemonStatus, type RpcStatus } from './overview/NodeHealthCard.js';
import { ActivityCard, type ActivityJoinedNet, type ActivityTask } from './overview/ActivityCard.js';
import { AiUnitsPauseAlert } from './AiUnitsPauseAlert.js';
import { computeEffectivePlugins } from './configuration/effective-plugins.js';
import { gasSeverity } from '../notifications/gas-severity.js';
import type { RewardsResponse, SolverNetsCatalogResponse, StakingRewardReadState } from '../../../../api/contract/index.js';

/**
 * Subset of /v1/setup/bootstrap we read on /overview. The full bootstrap
 * payload has fleet/service/keystore plumbing we don't need here; this
 * type captures the joined-SolverNet shape per spec §12.
 *
 * Issue #421 retired the legacy short-name-keyed `solverNets` block.
 */
interface BootstrapWithSolverNets {
  /** Operator's master EOA (the address that holds custody and seeds the node). */
  master_address?: string;
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
  runStartedAt?: number | null;
  stateUpdatedAt: number;
  manifestCid?: string | null;
  deliveryTxHash?: string | null;
  failureReason?: string | null;
  outcome?: 'pass' | 'fail' | 'awaiting' | 'accepted' | 'rejected' | null;
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
    }>;
  };
  /**
   * stOLAS staking rewards surfaced on /v1/status.rewards.
   */
  rewards?: {
    claimedStakingRewardsWei?: string;
    claimedStakingRewardsLast24hWei?: string | null;
  };
  /** Security metadata. Not yet surfaced by the daemon — field absent until added. */
  security?: {
    lastPasswordRotationAt?: string | null;
  };
  masterGas?: {
    balanceWei?: string;
    runwayDaysExcess?: string | number | null;
    minEthWei?: string;
  };
  /**
   * Per-role ETH balances (master / agent / Safe) exposed on /v1/status (#430).
   * Optional: older daemons predate this field.
   */
  balances?: {
    eth?: {
      master?: { balanceWei?: string | null };
      agent?: { balanceWei?: string | null };
      safe?: { balanceWei?: string | null };
    };
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
      /** RACE_LOST runs (pruned by another operator before any work; #896). */
      raceLost?: number;
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
  /**
   * Per-credential AI-units block — issue #815. Optional: only present
   * when the daemon has at least one joined SolverNet on a billed
   * credential, so older daemons / config shapes pass through cleanly.
   */
  aiUnits?: {
    credentials: Array<{
      credentialId: string;
      unitsThisBlock: number;
      unitsThisWeek: number;
      capPerBlock: number;
      capPerWeek: number;
      usdMicrosThisBlock?: number;
      usdMicrosThisWeek?: number;
      capPerBlockUsdMicros?: number;
      capPerWeekUsdMicros?: number;
      estimated?: boolean;
      paused: boolean;
      /** True when the credential has spend this 7d window (issue #891). Optional for backward-compat. */
      active?: boolean;
      pausedWindow?: 'block' | 'week' | null;
      blockResetsAt: string;
      weekResetsAt: string | null;
    }>;
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
      /** RACE_LOST runs (pruned by another operator before any work; #896). */
      raceLost?: number;
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

/** Shorten a tx hash for inline display (0x1234…abcd). */
function truncTx(hash?: string): string | null {
  if (!hash || hash.length < 12) return hash ?? null;
  return `${hash.slice(0, 6)}…${hash.slice(-4)}`;
}

export function OverviewPage(): JSX.Element {
  const [activeAction, setActiveAction] = useState<string | null>(null);
  const queryClient = useQueryClient();
  // Issue #560 — batched faucet top-up quota for the WalletCard. Refetched
  // after a batch top-up so the remaining-count + cooldown copy stays live.
  const { data: dripQuota } = useQuery({
    queryKey: ['dripQuota'],
    queryFn: () => api.getDripQuota(),
    refetchInterval: 30_000,
  });
  const { data: status, isError: statusIsError } = useQuery<OverviewStatusV1>({
    queryKey: ['status'],
    queryFn: () => api.getStatus() as Promise<OverviewStatusV1>,
    refetchInterval: 5_000,
  });
  const { data: rewards, isError: rewardsIsError } = useQuery<RewardsResponse>({
    queryKey: ['rewards'],
    queryFn: () => api.getRewards(),
    refetchInterval: 30_000,
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
    serviceId: s.serviceId ?? null,
    safeAddress: s.safeAddress ?? '',
    agentId: s.agentId ?? null,
    safeBoundToAgent: s.safeBoundToAgent ?? false,
  }));

  // Primary service's on-chain ID (Service #50 etc.) — surfaced under Identity
  // so operators can quote it when triaging with the team without digging
  // through `jinn status`.
  const primaryServiceId = services.find((s) => s.serviceId !== null)?.serviceId ?? null;

  const olasState: StakingRewardReadState =
    rewardsIsError || rewards?.readState === 'error' ? 'error' : rewards ? 'ready' : 'pending';
  const olasPending = olasState === 'ready' ? formatEth(rewards?.totalPending ?? '0') : '—';
  const olasClaimed = olasState === 'ready' ? formatEth(rewards?.totalClaimed ?? '0') : '—';
  const olasClaimedLast24h =
    status?.rewards?.claimedStakingRewardsLast24hWei != null
      ? formatEth(status.rewards.claimedStakingRewardsLast24hWei)
      : status
        ? '0.0000'
        : null;
  const olasError = rewards?.error ?? (rewardsIsError ? 'OLAS rewards temporarily unavailable.' : null);

  const gasBalanceEth = formatEth(status?.masterGas?.balanceWei);
  const gasRunwayDays = status?.masterGas?.runwayDaysExcess ?? '—';

  // Runway severity tint for the Wallet card (#1296). The card shows the L2
  // master; severity math (blocking / warning threshold) is owned by
  // gasSeverity so the rule lives in one place alongside the deriver's
  // funding notices.
  const gasRunwaySeverity = gasSeverity(status?.masterGas ?? {});

  // Per-role ETH balances (#430). `?? undefined` coerces the nullable wire shape
  // to formatEth's `string | undefined`; formatEth then renders '—' for missing input.
  const perRoleEth = status?.balances?.eth;
  const perRoleMasterEth = formatEth(perRoleEth?.master?.balanceWei ?? undefined);
  const perRoleAgentEth = formatEth(perRoleEth?.agent?.balanceWei ?? undefined);
  const perRoleSafeEth = formatEth(perRoleEth?.safe?.balanceWei ?? undefined);

  // ── Activity card inputs ────────────────────────────────────────────
  //
  // Joined: project `bootstrap.joinedSolverNets` into the ActivityCard
  // shape. Issue #421 retired the legacy short-name fallback; an empty
  // joinedSolverNets cleanly maps to the no-active-SolverNet empty-state.
  const joinedNets: ActivityJoinedNet[] = useMemo(() => {
    const out: ActivityJoinedNet[] = [];
    const j = bootstrap?.joinedSolverNets;
    if (!j) return out;
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
        // Derive the membership's solverType from its contract identity so the
        // Activity table can scope runs by solverType instead of the delivery
        // CID that delivered runs carry in manifestCid (#838).
        solverType: entry.contract
          ? `${entry.contract.id}.${entry.contract.version}`
          : undefined,
        roles: Array.isArray(entry.roles) ? entry.roles : [],
        harness: entry.harness,
        model: entry.model,
        plugins,
      });
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
          solverType: r.solverType ?? null,
          taskRole: r.taskRole,
          state: r.state,
          implName: r.implName ?? null,
          windowStartTs: r.windowStartTs ?? 0,
          runStartedAt: r.runStartedAt ?? null,
          stateUpdatedAt: r.stateUpdatedAt,
          deliveryTxHash: r.deliveryTxHash ?? null,
          failureReason: r.failureReason ?? null,
          outcome: r.outcome ?? null,
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
  // No daemon state-message line under "Running" — the prior state-message
  // line was idle copy like "waiting for next task" that added nothing.
  // Attention-worthy state (harness mismatch, etc.) surfaces through the
  // notifications row (spec §2.10). Node Health stays a glance-level health card.
  const daemonStateMessage: string | undefined = undefined;

  // Action confirmation now flows through sonner toast() — the
  // auto-dismiss timer the inline `dashboard-action-notice` band used to
  // own is the toast primitive's `duration`. Error toasts are persistent
  // (no auto-dismiss) so the operator sees the failure reason.
  const runAction = (
    label: string,
    action: () => Promise<{ message?: string } | void> | { message?: string } | void,
    opts?: { autoClearMs?: number },
  ): void => {
    setActiveAction(label);
    Promise.resolve()
      .then(action)
      .then((result) => {
        toast.success(label, {
          description: result?.message,
          duration: opts?.autoClearMs ?? 5_000,
        });
      })
      .catch((err) => {
        toast.error(`${label} failed`, {
          description: err instanceof Error ? err.message : String(err),
          duration: Infinity,
        });
      })
      .finally(() => setActiveAction(null));
  };

  return (
    <div
      data-testid="overview-page-grid"
      className="grid items-start gap-6 p-6 [grid-template-columns:minmax(0,1fr)_minmax(0,380px)]"
    >
      {/* ── MAIN COLUMN ──────────────────────────────────────────────── */}
      <div className="flex min-w-0 flex-col gap-6">
        {/* Issue #815 — running-mode AI-units pause banner. Renders only
            when at least one credential is paused; otherwise null. */}
        <AiUnitsPauseAlert aiUnits={status?.aiUnits} />

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
      <aside className="flex flex-col gap-6">
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

        {/*
         * Identity — §2.2 surface. Stable address-of-record stats (master /
         * agent / Safe / serviceId / agentId) plus the binding-pending retry
         * flow. Lives in the right rail paired with the Wallet card.
         */}
        <IdentityCard
          masterAddress={bootstrap?.master_address ?? null}
          agentAddress={null}
          safeAddress={services[0]?.safeAddress ?? null}
          serviceId={primaryServiceId}
          agentId={services[0]?.agentId ?? null}
          services={services}
        />

        <WalletCard
          totalEth={gasBalanceEth}
          runwayDays={gasRunwayDays}
          runwaySeverity={gasRunwaySeverity}
          actionsDisabled={activeAction !== null}
          perRole={{
            master: perRoleMasterEth,
            agent: perRoleAgentEth,
            safe: perRoleSafeEth,
          }}
          olasPending={olasPending}
          olasClaimed={olasClaimed}
          olasClaimedLast24h={olasClaimedLast24h}
          olasState={olasState}
          olasError={olasError}
          lastClaimAt={rewards?.lastClaimAt ?? null}
          lastPasswordRotationAt={status?.security?.lastPasswordRotationAt ?? null}
          topupDailyCap={dripQuota?.dailyCap}
          topupCallsRemaining={dripQuota?.callsRemaining}
          topupCooldownExpiresAt={dripQuota?.cooldownExpiresAt ?? null}
          onTopUp={() =>
            runAction(
              'Top up gas',
              async () => {
                // Issue #560: one click → a BATCH of drips up to the daily cap.
                // The daemon caps the batch and enters a 24h cooldown once the
                // cap is reached, so the operator gets the full day's allowance
                // in one action instead of clicking once per 0.0001 ETH drip.
                const res = await api.triggerDrip({ batch: true });
                // Refresh the quota so the remaining-count + cooldown copy
                // reflect this batch immediately.
                void queryClient.invalidateQueries({ queryKey: ['dripQuota'] });
                if (!res.ok) {
                  if (res.reason === 'topup_cooldown') {
                    throw new Error('Daily faucet cap reached. Try again after the cooldown.');
                  }
                  throw new Error(res.reason ?? 'Gas top-up failed.');
                }
                const count = res.txHashes?.length ?? 0;
                if (count === 0) {
                  return { message: 'Gas top-up checked; the faucet sent no funds.' };
                }
                const txLabel = truncTx(res.txHashes!.at(-1)!);
                return {
                  message:
                    count === 1
                      ? `Gas topped up · tx ${txLabel}`
                      : `Gas topped up: ${count} drips · last tx ${txLabel}`,
                };
              },
              // Confirmation is transient — surface it, then fade after ~5s.
              { autoClearMs: 5_000 },
            )}
          onClaim={() =>
            runAction(
              'Claim OLAS',
              async () => {
                const res = await api.claimRewards();
                if (!res.ok) {
                  throw new Error(res.error ?? 'Reward claim failed.');
                }
                await Promise.all([
                  queryClient.invalidateQueries({ queryKey: ['rewards'] }),
                  queryClient.invalidateQueries({ queryKey: ['status'] }),
                  queryClient.invalidateQueries({ queryKey: ['activity-events'] }),
                ]);
                const submitted = res.result?.submitted ?? 0;
                if (submitted === 0) {
                  return { message: 'No pending OLAS to claim.' };
                }
                const lastTx = res.result?.claims
                  ?.map((claim) => claim.txHash)
                  .filter((hash): hash is string => Boolean(hash))
                  .at(-1);
                const txLabel = truncTx(lastTx);
                return {
                  message: txLabel
                    ? `Claim submitted · tx ${txLabel}`
                    : `Claim submitted: ${submitted} claim${submitted === 1 ? '' : 's'}`,
                };
              },
              { autoClearMs: 5_000 },
            )}
          claimPending={activeAction === 'Claim OLAS'}
        />
      </aside>
    </div>
  );
}
