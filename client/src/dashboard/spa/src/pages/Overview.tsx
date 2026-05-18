import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { api } from '../api/client.js';
import { HeroStats } from './overview/HeroStats.js';
import { AlertBand } from './overview/AlertBand.js';
import { deriveLiveNow, LIVE_NOW_STATE_LABEL, LIVE_NOW_TONE } from './overview/LiveNowBand.js';
import { NetworkCard } from './overview/NetworkCard.js';
import { OperatorCard, type OperatorCardRole } from './overview/OperatorCard.js';
import { IdentityCard, type ServiceIdentity } from './overview/IdentityCard.js';
import { AdvancedDetails } from './overview/AdvancedDetails.js';
import { HarnessStatusPanel } from './overview/HarnessStatusPanel.js';

interface OverviewStatusV1 {
  fleet?: {
    services?: Array<{
      index: number;
      step: string;
      safeAddress?: string | null;
      agentId?: number | null;
      safeBoundToAgent?: boolean;
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

type OverviewTaskRunTotals = NonNullable<OverviewStatusV1['taskRuns']>['totals'];

/**
 * The operator's joined SolverNets per spec §12. Tasks 21/22 finish the
 * migration from the legacy short-name-keyed `solverNets` shape to the
 * `manifestCid`-keyed shape; until then, OperatorCard accepts both.
 *
 * New shape:    { '<manifestCid>': { name, manifestCid, roles: ['solver'|'evaluator'], harness?, ... } }
 * Legacy shape: { '<shortName>':   { enabled: boolean, roles?: ['solving'|'evaluating'], ... } }
 */
interface BootstrapWithSolverNets {
  solverNets?: Record<
    string,
    {
      name?: string;
      manifestCid?: string;
      enabled?: boolean;
      roles?: string[];
    }
  >;
  joinedSolverNets?: Record<
    string,
    {
      name?: string;
      manifestCid?: string;
      roles?: string[];
    }
  >;
}

interface JoinedSolverNet {
  /** Display name for the OperatorCard. */
  name: string;
  /** Manifest CID / config key used for deep-linking into the joined config. */
  configId?: string;
  /** Roles narrowed to OperatorCard's `solving` / `evaluating` vocabulary. */
  roles: OperatorCardRole[];
}

/**
 * Detect whether the operator has joined any SolverNet. Returns the first
 * joined entry projected into OperatorCard's prop shape. The explicit
 * `joinedSolverNets` config block wins over the legacy `solverNets` map. The new
 * manifestCid-keyed shape (any entry with non-empty `roles`) wins over the
 * legacy `enabled` flag; both are accepted during the Tasks 21/22 migration
 * (spec §12). The predictionV1 status payload is a final-fallback signal
 * for daemons that haven't been restarted since this migration landed.
 */
function detectJoinedSolverNet(
  joinedSolverNets: BootstrapWithSolverNets['joinedSolverNets'] | undefined,
  bootstrapSolverNets: BootstrapWithSolverNets['solverNets'] | undefined,
  predictionEnabled: boolean,
  predictionRoles: string[] | undefined,
): JoinedSolverNet | null {
  if (joinedSolverNets) {
    for (const [key, entry] of Object.entries(joinedSolverNets)) {
      if (!entry || typeof entry !== 'object') continue;
      const rawRoles = Array.isArray(entry.roles) ? entry.roles : [];
      if (rawRoles.length === 0) continue;
      const roles = mapRolesToOperatorVocab(rawRoles);
      return {
        name: entry.name ?? entry.manifestCid ?? key,
        configId: entry.manifestCid ?? key,
        roles: roles.length > 0 ? roles : ['solving'],
      };
    }
  }

  if (bootstrapSolverNets) {
    // Pass 1: new shape — entries keyed by manifestCid (heuristic: starts
    // with 'baf' / 'Qm', or has a `manifestCid` field) with non-empty roles.
    for (const [key, entry] of Object.entries(bootstrapSolverNets)) {
      if (!entry || typeof entry !== 'object') continue;
      const looksLikeCid =
        entry.manifestCid !== undefined ||
        key.startsWith('baf') ||
        key.startsWith('Qm');
      if (!looksLikeCid) continue;
      const rawRoles = Array.isArray(entry.roles) ? entry.roles : [];
      if (rawRoles.length === 0) continue;
      const roles = mapRolesToOperatorVocab(rawRoles);
      return {
        name: entry.name ?? key,
        configId: entry.manifestCid ?? key,
        roles: roles.length > 0 ? roles : ['solving'],
      };
    }
    // Pass 2: legacy short-name shape — enabled entries or operator-visible roles.
    for (const [key, entry] of Object.entries(bootstrapSolverNets)) {
      if (!entry || typeof entry !== 'object') continue;
      const rawRoles = Array.isArray(entry.roles) ? entry.roles : [];
      const roles = mapRolesToOperatorVocab(rawRoles);
      if (entry.enabled !== true && roles.length === 0) continue;
      return {
        name: entry.name ?? key,
        configId: entry.manifestCid ?? key,
        roles: roles.length > 0 ? roles : ['solving'],
      };
    }
  }

  // Pass 3: predictionV1 status payload as a last-resort signal. The daemon
  // surfaces this for back-compat with the pre-spec-§12 single-net world.
  const mappedPredictionRoles = mapRolesToOperatorVocab(predictionRoles ?? []);
  if (predictionEnabled || mappedPredictionRoles.length > 0) {
    return {
      name: 'prediction',
      configId: 'prediction',
      roles: mappedPredictionRoles.length > 0 ? mappedPredictionRoles : ['solving'],
    };
  }
  return null;
}

function mapRolesToOperatorVocab(roles: string[]): OperatorCardRole[] {
  const mapped: OperatorCardRole[] = [];
  for (const r of roles) {
    if (r === 'solving' || r === 'solver') {
      if (!mapped.includes('solving')) mapped.push('solving');
    } else if (r === 'evaluating' || r === 'evaluator') {
      if (!mapped.includes('evaluating')) mapped.push('evaluating');
    }
  }
  return mapped;
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

function operatorWaitingMessage(
  joined: JoinedSolverNet | null,
  taskRunTotals: OverviewTaskRunTotals,
  predictionDescription: string | undefined,
): string | undefined {
  const hasGenericRuns =
    (taskRunTotals?.observedTasks ?? 0) > 0 ||
    (taskRunTotals?.activeTaskRuns ?? 0) > 0 ||
    (taskRunTotals?.completed ?? 0) > 0 ||
    (taskRunTotals?.failed ?? 0) > 0;
  if (hasGenericRuns) {
    if ((taskRunTotals?.activeTaskRuns ?? 0) > 0) {
      return 'Working on current run.';
    }
    return 'Waiting for the next available run.';
  }
  if (joined?.configId === 'prediction') {
    return predictionDescription;
  }
  return undefined;
}

export function OverviewPage(): JSX.Element {
  const [activeAction, setActiveAction] = useState<string | null>(null);
  const [notice, setNotice] = useState<{ tone: 'success' | 'error'; text: string } | null>(null);
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
  // joined SolverNet. `predictionV1.totals` is filtered by
  // `solverType === 'prediction.v1'` in the build layer, while
  // `taskRuns.totals` is global across every solver type the operator's
  // SQLite has ever observed. When the joined net is `prediction`, prefer
  // the scoped payload so historical FAILED rows from other SolverNets
  // don't leak into this card's settledFailed / localErrors tiles. For any
  // other joined net we fall back to taskRunTotals (no scoped payload
  // exists for those solver types today — captured as a follow-up risk).
  const preferPredictionTotals =
    joined?.configId === 'prediction' && predictionTotals !== undefined;
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

  const tasksDelivered = totals.solutions;
  const jinnClaimable = formatEth(status?.rewards?.pendingStakingRewardsWei);
  const gasBalanceEth = formatEth(status?.masterGas?.balanceWei);
  const gasRunwayDays = status?.masterGas?.runwayDaysExcess ?? '—';
  const liveNow = deriveLiveNow(status);
  const waitingMessage = operatorWaitingMessage(joined, taskRunTotals, operator?.nextAction?.description);
  const runAction = (
    label: string,
    action: () => Promise<{ message?: string } | void> | { message?: string } | void,
  ): void => {
    setActiveAction(label);
    setNotice(null);
    Promise.resolve()
      .then(action)
      .then((result) => {
        setNotice({
          tone: 'success',
          text: result?.message ?? `${label} requested.`,
        });
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
        activeAction={activeAction}
        onClaim={() =>
          runAction('Claim JINN', async () => {
            const res = await api.claimRewards();
            if (!res.ok) {
              throw new Error(res.error ?? 'Reward claim failed.');
            }
            return { message: 'JINN claim command completed.' };
          })}
        onTopUp={() =>
          runAction('Top up gas', async () => {
            const res = await api.triggerDrip();
            if (!res.ok) {
              throw new Error(res.reason ?? 'Gas top-up failed.');
            }
            const txCount = res.txHashes?.length ?? (res.txHash ? 1 : 0);
            if (txCount > 0) {
              return { message: `Gas top-up requested (${txCount} ${txCount === 1 ? 'transaction' : 'transactions'}).` };
            }
            if (res.attempts === 0) {
              return { message: 'Gas balance is already above the testnet top-up target.' };
            }
            return { message: 'Gas top-up checked; no additional funding was needed.' };
          })}
        onRestart={() =>
          runAction('Restart node', async () => {
            const res = await api.restartDaemon();
            if (!res.ok) {
              throw new Error('Restart request failed.');
            }
            return { message: 'Restart requested. The dashboard will reconnect when the daemon is back.' };
          })}
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
       * Operator-side state vs. empty-state — strictly mutually exclusive.
       * Spec §12: the OperatorCard surfaces the operator's joined SolverNet
       * from `bootstrap.solverNets`. The empty state ("Pick a SolverNet")
       * deep-links to `/operator#solvernets` where the registry catalog
       * is rendered. `detectJoinedSolverNet` accepts the legacy short-name
       * shape and the new manifestCid-keyed shape during the Tasks 21/22
       * migration window. The diagnostic-attention state is represented in
       * the compact status tile above and the full live card on /operator;
       * this Get-Started AlertBand stays.
       */}
      {joined ? (
        <OperatorCard
          name={joined.name}
          configId={joined.configId}
          roles={joined.roles}
          state="live"
          waitingMessage={waitingMessage}
        />
      ) : (
        <AlertBand
          lead="Get started"
          body="Pick a SolverNet to participate in"
          ctaLabel="Configure"
          ctaHref="/operator#solvernets"
        />
      )}

      <AdvancedDetails>
        <IdentityCard
          agentId={services[0]?.agentId ?? null}
          chain="Base Sepolia"
          safeAddress={services[0]?.safeAddress ?? null}
          services={services}
        />
        <HarnessStatusPanel />
      </AdvancedDetails>
    </div>
  );
}
