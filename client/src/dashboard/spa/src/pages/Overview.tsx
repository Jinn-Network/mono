import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';
import { api } from '../api/client.js';
import { HeroStats } from './overview/HeroStats.js';
import { deriveLiveNow, LIVE_NOW_STATE_LABEL, LIVE_NOW_TONE } from './overview/liveNowState.js';
import { NetworkCard } from './overview/NetworkCard.js';
import { OperatorCard } from './overview/OperatorCard.js';
import { IdentityCard, type ServiceIdentity } from './overview/IdentityCard.js';
import { AdvancedDetails } from './overview/AdvancedDetails.js';
import { HarnessStatusPanel } from './overview/HarnessStatusPanel.js';
import {
  detectJoinedSolverNet,
  operatorWaitingMessage,
  type BootstrapWithSolverNets,
} from './overview/joined-solver-net.js';
import { ActivitySections } from './overview/ActivitySections.js';

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
    inFlight?: Array<{ state: string; taskRole: 'restoration' | 'evaluation' | null; stateUpdatedAt: number }>;
    recentTasks?: Array<{ state: string; taskRole: 'restoration' | 'evaluation' | null; stateUpdatedAt: number }>;
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
    recentTasks?: Array<{ state: string; taskRole: 'restoration' | 'evaluation' | null; stateUpdatedAt: number }>;
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

export function OverviewPage(): JSX.Element {
  const [activeAction, setActiveAction] = useState<string | null>(null);
  const [notice, setNotice] = useState<{ tone: 'success' | 'error'; text: string } | null>(null);
  const queryClient = useQueryClient();
  const { data: status } = useQuery<OverviewStatusV1>({
    queryKey: ['status'],
    queryFn: () => api.getStatus() as Promise<OverviewStatusV1>,
    refetchInterval: 5_000,
  });
  const { data: bootstrap } = useQuery<BootstrapWithSolverNets>({
    queryKey: ['bootstrap'],
    queryFn: () => api.getBootstrap() as Promise<BootstrapWithSolverNets>,
    refetchInterval: 30_000,
  });

  const operator = status?.predictionV1?.operator;
  // Spec §12: surface the operator's joined SolverNets from the
  // `solverNets[manifestCid]` config block. Until Task 22 retires the
  // legacy short-name-keyed shape, we accept both shapes in
  // `detectJoinedSolverNet`. Falling back to the predictionV1 status payload
  // covers the current Phase-1 single-net world where the daemon writes
  // `solverNets.prediction.enabled` rather than a manifestCid entry.
  const joined = detectJoinedSolverNet(
    bootstrap?.joinedSolverNets,
    bootstrap?.solverNets,
    operator?.solverNet?.enabled === true,
    operator?.solverNet?.roles,
  );
  const taskRunTotals = status?.taskRuns?.totals;
  const predictionTotals = status?.predictionV1?.totals;
  // Per jinn-mono-0t6p: the NetworkCard's counters must be scoped to the
  // joined SolverNet. `predictionV1.totals` is filtered to prediction task
  // runs in the build layer, while
  // `taskRuns.totals` is global across every solver type the operator's
  // SQLite has ever observed. The discriminator is the joined net's scoped
  // status key (see `detectJoinedSolverNet`): both the legacy short-name
  // `solverNets.prediction` path AND the manifest-keyed
  // `joinedSolverNets[<cid>]` path route to `predictionV1` via the bound
  // harness, so users on either shape get scoped counters. For any other
  // joined net we fall back to taskRunTotals (no scoped payload exists for
  // those SolverNets today — captured as a follow-up risk).
  const preferPredictionTotals =
    joined?.scopedStatusKey === 'predictionV1' && predictionTotals !== undefined;
  const primaryTotals = preferPredictionTotals ? predictionTotals : taskRunTotals;
  const fallbackTotals = preferPredictionTotals ? taskRunTotals : predictionTotals;
  // Old daemons only ship `failed`; surface it under `localErrors` so the
  // operator's debugging signal isn't lost during the rollout window —
  // anything that reaches `localErrors` here pre-dates the on-chain split.
  const legacyFailedFallback =
    primaryTotals?.failed ?? fallbackTotals?.failed ?? 0;
  const settledFailed =
    primaryTotals?.settledFailed ?? fallbackTotals?.settledFailed;
  const localErrors =
    primaryTotals?.localErrors ?? fallbackTotals?.localErrors;
  const totals = {
    tasks: primaryTotals?.observedTasks ?? fallbackTotals?.observedTasks ?? 0,
    active: primaryTotals?.activeTaskRuns ?? fallbackTotals?.activeTaskRuns ?? 0,
    solutions: primaryTotals?.solutions ?? fallbackTotals?.solutions ?? 0,
    verdicts: primaryTotals?.verdicts ?? fallbackTotals?.verdicts ?? 0,
    settledFailed: settledFailed ?? 0,
    localErrors:
      localErrors ?? (settledFailed === undefined ? legacyFailedFallback : 0),
  };
  const services: ServiceIdentity[] = (status?.fleet?.services ?? []).map((s) => ({
    index: s.index,
    safeAddress: s.safeAddress ?? '',
    agentId: s.agentId ?? null,
    safeBoundToAgent: s.safeBoundToAgent ?? false,
  }));

  // Eviction state — derived from the first evicted service in the fleet.
  const firstEvictedService = (status?.fleet?.services ?? []).find((s) => s.evicted === true);
  const isEvicted = firstEvictedService != null;
  const evictedServiceId = firstEvictedService?.serviceId ?? null;

  const tasksDelivered = totals.solutions;
  const jinnClaimable = formatEth(status?.rewards?.pendingStakingRewardsWei);
  const gasBalanceEth = formatEth(status?.masterGas?.balanceWei);
  const gasRunwayDays = status?.masterGas?.runwayDaysExcess ?? '—';
  // Gate the LiveNow attention banner on the freshly-polled join map so a
  // stale `prediction_solvernet_missing` diagnostic (the daemon only
  // re-reads `joinedSolverNets` on restart) does not contradict the joined
  // SolverNet shown below (#333).
  const liveNow = deriveLiveNow(status, bootstrap?.joinedSolverNets);
  const waitingMessage = operatorWaitingMessage(joined, taskRunTotals, operator?.nextAction?.description);
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
    <div style={{ padding: '24px', display: 'flex', flexDirection: 'column', gap: '24px' }}>
      <HeroStats
        tasksDelivered={tasksDelivered}
        jinnClaimable={jinnClaimable}
        gasBalanceEth={gasBalanceEth}
        gasRunwayDays={gasRunwayDays}
        statusLabel={LIVE_NOW_STATE_LABEL[liveNow.state]}
        statusState={liveNow.state}
        statusDot={LIVE_NOW_TONE[liveNow.state].dot}
        // `liveNow.line` is the human-readable why — the first error
        // diagnostic's message, "N tasks restoring", "waiting for next task",
        // etc. — surfaced under the label in the STATUS tile.
        statusReason={liveNow.line}
        activeAction={activeAction}
        evicted={isEvicted}
        evictedServiceId={evictedServiceId}
        onClaim={() =>
          runAction('Claim JINN', async () => {
            const res = await api.claimRewards();
            if (!res.ok) {
              throw new Error(res.error ?? 'Reward claim failed.');
            }
            return { message: 'JINN claim command completed.' };
          })}
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
        onRestart={() =>
          runAction(
            'Restart node',
            async () => {
              const res = await api.restartDaemon();
              if (!res.ok) {
                throw new Error('Restart request failed.');
              }
              return { message: 'Restart requested. The dashboard will reconnect when the daemon is back.' };
            },
            // Restart confirmation is transient — surface it, then fade after
            // ~10s so it doesn't linger until the next action. The dashboard
            // reconnects on its own when the daemon is back.
            { autoClearMs: 10_000 },
          )}
        onRestake={async (serviceId) => {
          const res = await api.restake(serviceId);
          if (!res.ok) {
            throw new Error(res.error ?? 'Re-stake failed.');
          }
          // Optimistically refetch status so the eviction notice clears.
          await queryClient.invalidateQueries({ queryKey: ['status'] });
        }}
      />
      {notice && (
        <div
          role={notice.tone === 'error' ? 'alert' : 'status'}
          data-testid="dashboard-action-notice"
          style={{
            border: `1px solid ${notice.tone === 'error' ? 'var(--break-red)' : 'var(--vow-green)'}`,
            color: notice.tone === 'error' ? 'var(--break-red)' : 'var(--vow-green)',
            borderRadius: '6px',
            padding: '10px 12px',
            fontFamily: "'JetBrains Mono', monospace",
            fontSize: '12px',
          }}
        >
          {notice.text}
        </div>
      )}

      {/* Public counters for the active SolverNet surfaced by this operator. */}
      <NetworkCard name={joined?.name ?? 'SolverNet'} totals={totals} />

      {/*
       * Operator-side state — shown when the operator has joined a SolverNet.
       * The empty-state ("no SolverNets joined") is handled globally via the
       * `no_solvernets_joined` notification kind in AppShell's NotificationsList
       * (Task 1.5 / Task 1.6). No local empty-state rendering here.
       * Spec §12: `detectJoinedSolverNet` accepts the legacy short-name shape
       * and the new manifestCid-keyed shape during the Tasks 21/22 migration window.
       */}
      {joined && (
        <OperatorCard
          name={joined.name}
          configId={joined.configId}
          roles={joined.roles}
          state="live"
          waitingMessage={waitingMessage}
        />
      )}

      {/*
       * Live activity is a primary Dashboard section (issue #219): an
       * operator who runs `jinn run` and lands on /overview must see what
       * their daemon is doing right now without navigating to Settings.
       * The same surface renders on the dedicated /overview/activity page.
       */}
      <ActivitySections />

      <IdentityCard
        agentId={services[0]?.agentId ?? null}
        chain="Base Sepolia"
        safeAddress={services[0]?.safeAddress ?? null}
        services={services}
      />
      <HarnessStatusPanel />
      <AdvancedDetails />
    </div>
  );
}
