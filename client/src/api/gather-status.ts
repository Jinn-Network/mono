/**
 * Best-effort status collection for GET /v1/status (RPC + earning store + SQLite).
 */

import { createPublicClient, http, type PublicClient } from 'viem';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

/** Narrow RPC surface for balance fan-out (avoids PublicClient / chain-specific getBlock incompatibilities). */
type StatusBalanceRpc = Pick<PublicClient, 'getBalance' | 'readContract'>;
import { base, baseSepolia } from 'viem/chains';
import type { Store } from '../store/store.js';
import type { JinnConfig } from '../config.js';
import type { CredentialId } from '../spend/credential.js';
import { isOverSpendCap } from '../spend/spend-cap.js';
import type { AiUnitsDaemonConfig } from '../spend/ai-units-config.js';
import { blockResetsAtUtc, weekResetsAtUtc, GPT_5_4_MINI_USD_PER_BLOCK } from '../spend/ai-units.js';
import { FleetStateStore } from '../earning/store.js';
import {
  getChainConfig,
} from '../earning/contracts.js';
import { stage1MinMasterEth } from '../earning/bootstrap.js';
import { JINN_STAKING_ABI } from '../earning/stolas-staking.js';
import type { FleetState } from '../earning/types.js';
import { displayFleetServiceIndex } from '../earning/fleet-display-index.js';
import {
  assembleStatusV1,
  type GatheredStatusRaw,
  type ServiceBalanceErrorEntry,
  type StatusV1Response,
  resolveMasterDailyEstimateWei,
} from './status-build.js';
import { listStolasClaimTargets } from '../earning/stolas-claim.js';
import {
  gatherPortfolioV0Status,
  DEFAULT_ENGINE_WORKING_DIR_ROOT,
} from './portfolio-v0-build.js';
import {
  gatherPredictionV1Status,
  type PredictionOperatorStatusForApi,
  type PredictionV1Status,
} from './prediction-v1-build.js';
import { gatherTaskRunsStatus, applyOutcomes } from './task-runs-build.js';
import type { DiscoveryAPI, VerdictTallyResult } from '../discovery/types.js';
import { gatherLoopCompletion, gatherImplStateCadence } from './loop-completion-build.js';
import type { BalanceCacheEntry } from '../store/store.js';
import {
  buildPredictionOperatorStatus,
  type PredictionOperatorStatus,
} from '../solver-nets/prediction-operator-ux.js';
import {
  findJoinedByName,
  rolesFromJoinedConfig,
  solverTypeFromJoinedContract,
} from '../solver-nets/registry.js';
import { buildHarnessRollup } from './status-harness-rollup.js';
import type {
  HarnessReadinessSnapshot,
  JoinedHarnessSpec,
} from '../harnesses/readiness-registry.js';

const ERC20_BALANCE_OF_ABI = [
  {
    type: 'function',
    name: 'balanceOf',
    stateMutability: 'view',
    inputs: [{ name: 'account', type: 'address' }],
    outputs: [{ name: '', type: 'uint256' }],
  },
] as const;

function readDaemonRuntime(earningDir: string | undefined): GatheredStatusRaw['daemonRuntime'] | undefined {
  if (!earningDir) return undefined;
  const pidPath = join(earningDir, 'daemon.pid');
  if (!existsSync(pidPath)) {
    return { pidPath, pid: null, alive: false, stale: true };
  }
  const pid = Number.parseInt(readFileSync(pidPath, 'utf8').trim(), 10);
  if (!Number.isFinite(pid)) {
    return { pidPath, pid: null, alive: false, stale: true };
  }
  try {
    process.kill(pid, 0);
    return { pidPath, pid, alive: true, stale: false };
  } catch {
    return { pidPath, pid, alive: false, stale: true };
  }
}

/**
 * Resolve `security.lastPasswordRotationAt` from the password provenance
 * descriptor. File mtime is read at request time. Never throws: a missing,
 * unreadable, or env-sourced password yields `null` (issue #441).
 */
function resolvePasswordRotationAt(
  cfg: PasswordRotationConfig | undefined,
): string | null {
  if (!cfg || cfg.source === 'env' || !cfg.filePath) return null;
  try {
    return statSync(cfg.filePath).mtime.toISOString();
  } catch {
    return null;
  }
}

const predictionOperatorStatusCache = new WeakMap<JinnConfig, Map<string, Promise<PredictionOperatorStatus>>>();

/**
 * Drop any cached prediction operator status for `config`.
 *
 * The cache key is the live `JinnConfig` object reference. When the SPA
 * mutates `config.solverNets` in place via `onSolverNetsUpdated`
 * (see `main.ts`), the WeakMap still resolves to the previously-built
 * status — leaving Overview reading stale operator metadata
 * even though the operator just toggled it on. Invalidating here keeps
 * the Overview gating in sync with the latest config without a daemon
 * restart. (jinn-mono-l2zl.15.4.12)
 */
export function invalidatePredictionOperatorStatusCache(config: JinnConfig): void {
  predictionOperatorStatusCache.delete(config);
}

/**
 * Keystore-password provenance descriptor threaded from `main.ts`'s
 * `resolveOrGenerateKeystorePassword()` (issue #441). `gatherGatheredStatusRaw`
 * uses it to resolve `security.lastPasswordRotationAt`:
 *   - `source: 'file' | 'generated'` with a `filePath` → statSync(filePath).mtime ISO
 *   - `source: 'env'` (or no `filePath`) → null
 */
export interface PasswordRotationConfig {
  source: 'env' | 'file' | 'generated';
  filePath?: string;
}

export interface StatusGatherConfig {
  earningDir: string;
  rpcUrl: string;
  /**
   * stOLAS L2 distributor address (`CHAIN_CONFIG.distributorAddress`). Used
   * solely to mirror `main.ts`'s `evictionCheck` predicate (issue #651).
   */
  stOlasDistributorAddress?: string;
  network: 'mainnet' | 'testnet';
  pollIntervalMs: number;
  masterEthDailyEstimateWei?: string;
  rewardClaimIntervalMs: number;
  testnetL2DeploymentPath?: string;
  testnetL2TokenDeploymentPath?: string;
  testnetMechDeploymentPath?: string;
  testnetStolasDeploymentPath?: string;
  /** Engine paths — used for portfolio.v0 Claude outcome scan, etc. */
  engine?: { workingDirRoot: string; implStateDirRoot: string };
  /** Full config enables SolverNet/plugin/Harness diagnostics in /v1/status. */
  config?: JinnConfig;
  configPath?: string;
  /** Per-credential daily caps; when present, /v1/status carries a `spend` block. */
  spendCaps?: Record<CredentialId, number>;
  /**
   * AI-units gate config (issue #815). When present, /v1/status carries an
   * `aiUnits` block keyed per credential — surfaces unitsThisBlock /
   * unitsThisWeek vs caps + paused flag + reset instants.
   */
  aiUnits?: AiUnitsDaemonConfig;
  /**
   * Optional getter that returns the live HarnessReadinessRegistry snapshot
   * + joinedHarnessesByCid map. Threaded by `server.ts` for the `/v1/status`
   * handler so the response carries a `harness` rollup. Returning `null`
   * means "registry not ready yet" — gather-status leaves `raw.harnessRollup`
   * unset and the assembler defaults to ready. Mirrors the holder pattern
   * already used for `harnessReadinessRegistry` in main.ts.
   */
  harnessReadiness?: () => {
    snapshot: HarnessReadinessSnapshot;
    joinedHarnessesByCid: Record<string, JoinedHarnessSpec>;
  } | null;
  /**
   * Keystore-password provenance — threaded from `main.ts`. Drives
   * `security.lastPasswordRotationAt` on `/v1/status`. Optional: test callers
   * and sqlite-only contexts omit it ⇒ `null` (issue #441).
   */
  passwordRotation?: PasswordRotationConfig;
  /**
   * Resolved DiscoveryAPI, threaded by `server.ts`. When present, the async
   * status path enriches each COMPLETE solve run's task-relative `outcome`
   * from `getVerdictTallies` (spec/2026-05-22-run-outcome.md). Absent ⇒
   * outcomes stay `null` (the SPA renders `—`). This is a DISPLAY signal:
   * any discovery failure degrades silently to `null`, never a wrong `'fail'`.
   */
  discovery?: DiscoveryAPI;
}

function chainKey(network: 'mainnet' | 'testnet'): 'base' | 'base-sepolia' {
  return network === 'testnet' ? 'base-sepolia' : 'base';
}

/**
 * Derive the SolverNet name to use for the prediction operator diagnostic.
 *
 * Priority: (1) first joined entry's `name` field, (2) first joined entry's
 * manifestCid, (3) fallback `'prediction'`.
 *
 * Post-issue-#421 the legacy `solverNets` config block has been retired; the
 * operator's participation choices live in `joinedSolverNets` keyed by
 * manifestCid.
 */
function derivePredictionSolverNetName(config: JinnConfig): string {
  const joinedEntries = Object.entries(config.joinedSolverNets ?? {});
  if (joinedEntries.length > 0) {
    const [cid, entry] = joinedEntries[0]!;
    return entry.name ?? cid;
  }
  return 'prediction';
}

function predictionOperatorCacheKey(configPath: string, name: string): string {
  return `${configPath}\0${name}`;
}

async function getCachedPredictionOperatorStatus(
  config: JinnConfig,
  configPath: string,
  name: string,
): Promise<PredictionOperatorStatus> {
  let byKey = predictionOperatorStatusCache.get(config);
  if (!byKey) {
    byKey = new Map();
    predictionOperatorStatusCache.set(config, byKey);
  }

  const key = predictionOperatorCacheKey(configPath, name);
  let cached = byKey.get(key);
  if (!cached) {
    // gather-status only runs inside a live daemon; the operator-status
    // surface should reflect that (Issue #86 §1: drop the vacuous
    // "start the daemon" copy when the daemon is already running).
    cached = buildPredictionOperatorStatus({ config, configPath, daemonRunning: true })
      .catch((error) => predictionOperatorUnavailable(config, configPath, name, errorMessage(error)));
    byKey.set(key, cached);
  }
  return cached;
}

function predictionOperatorUnavailable(
  config: JinnConfig,
  configPath: string,
  name: string,
  message: string,
): PredictionOperatorStatus {
  // Resolve the matching joined entry by display name (or manifestCid) so
  // the diagnostic can still surface the operator's configured roles when
  // possible.
  const joined = findJoinedByName(config.joinedSolverNets, name);
  const diagnostic = {
    code: 'prediction_operator_status_unavailable',
    severity: 'error' as const,
    message,
    nextAction: {
      description: 'Inspect Prediction SolverNet configuration via Operator > SolverNets and restart the daemon after fixing it.',
      url: '/operator#solvernets',
    },
  };

  // Roles are best-effort: an unavailable status path means the daemon
  // could not load the SolverNet, so we surface whatever the operator
  // joined.
  const netRoles = joined ? rolesFromJoinedConfig(joined) : [];
  const solverType = (joined && solverTypeFromJoinedContract(joined)) ?? 'prediction.v1';

  return {
    kind: 'prediction.v1.operatorStatus',
    ok: false,
    configPath,
    solverNet: {
      name,
      enabled: joined ? netRoles.length > 0 : false,
      solverType,
      roles: netRoles,
      harness: joined?.harness,
      taskGeneratorEnabled: false,
    },
    runtimePlugins: [],
    diagnostics: [diagnostic],
    nextAction: diagnostic.nextAction,
  };
}

/**
 * Project the daemon-side `PredictionOperatorStatus` (full role typing) into
 * the API-facing variant. With Task 22 of
 * spec/2026-05-05-solvernet-creation-and-launch.md the operator role enum
 * is `'solving' | 'evaluating'` everywhere; this projection is structural
 * (no narrowing required), retained as a thin boundary for clarity and to
 * keep the `PredictionOperatorStatusForApi` type stable.
 */
function narrowOperatorStatusForApi(
  status: PredictionOperatorStatus,
): PredictionOperatorStatusForApi {
  const roles = status.solverNet.roles.filter(
    (r): r is 'solving' | 'evaluating' => r === 'solving' || r === 'evaluating',
  );
  const hasOperatorRole = roles.length > 0;
  const diagnostics = hasOperatorRole
    ? status.diagnostics.filter((d) => d.code !== 'prediction_solvernet_disabled')
    : status.diagnostics;
  const disabledNextAction =
    status.nextAction?.description === 'Enable the Prediction SolverNet before participating.';
  const nextDiagnosticAction = diagnostics.find(
    (d) => (d.severity === 'error' || d.severity === 'warning') && d.nextAction,
  )?.nextAction;

  return {
    ...status,
    ok: diagnostics.every((diagnostic) => diagnostic.severity !== 'error'),
    diagnostics,
    nextAction: hasOperatorRole && disabledNextAction
      ? (nextDiagnosticAction ?? {
          description: 'Waiting for Tasks. SolverNet active, Harness loaded; no incoming Tasks since startup.',
        })
      : status.nextAction,
    solverNet: {
      ...status.solverNet,
      // `roles[]` is canonical for operator participation. Preserve the
      // legacy field for older consumers, but derive it from operator-visible
      // roles so stale `enabled: false` configs do not hide active operators.
      enabled: hasOperatorRole,
      roles,
    },
  };
}

function predictionV1Unavailable(
  operator: PredictionOperatorStatusForApi | null,
  operatorError: string,
): PredictionV1Status {
  return {
    operator,
    operatorError,
    totals: {
      observedTasks: 0,
      activeTaskRuns: 0,
      solutions: 0,
      verdicts: 0,
      failed: 0,
      settledFailed: 0,
      localErrors: 0,
      raceLost: 0,
    },
    latest: {
      taskAt: null,
      solutionAt: null,
      verdictAt: null,
    },
    recentTasks: [],
    recentSolutions: [],
    recentVerdicts: [],
  };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export async function sumPendingStakingRewards(
  rpcUrl: string,
  network: 'mainnet' | 'testnet',
  fleet: FleetState,
): Promise<{ sum: string; pendingByService: Record<number, string>; nextCheckpointAt?: string } | { error: string }> {
  const targets = listStolasClaimTargets(fleet.services);
  if (targets.length === 0) {
    return { sum: '0', pendingByService: {} };
  }

  const chain = network === 'testnet' ? baseSepolia : base;
  const client = createPublicClient({
    chain,
    transport: http(rpcUrl),
  });

  let total = 0n;
  const pendingByService: Record<number, string> = {};
  let nextCheckpointAt: string | undefined;
  try {
    for (const t of targets) {
      const pending = await client.readContract({
        address: t.stakingProxy as `0x${string}`,
        abi: JINN_STAKING_ABI,
        functionName: 'calculateStakingReward',
        args: [BigInt(t.serviceId)],
      });
      total += pending;
      const svc = fleet.services.find((s) => s.service_id === t.serviceId);
      if (svc) {
        pendingByService[displayFleetServiceIndex(svc)] = pending.toString();
      }
    }
    // All staked services in a Phase 1b fleet share the same staking proxy;
    // a single read of the earliest checkpoint timestamp is sufficient.
    try {
      const nextTs = await client.readContract({
        address: targets[0]!.stakingProxy as `0x${string}`,
        abi: JINN_STAKING_ABI,
        functionName: 'getNextRewardCheckpointTimestamp',
      });
      if (nextTs > 0n) {
        nextCheckpointAt = new Date(Number(nextTs) * 1000).toISOString();
      }
    } catch {
      // Non-fatal: older staking proxy deploys may not expose this function;
      // rewards-build keeps nextCheckpointAt as null in that case.
    }
    return nextCheckpointAt
      ? { sum: total.toString(), pendingByService, nextCheckpointAt }
      : { sum: total.toString(), pendingByService };
  } catch (e) {
    return { error: e instanceof Error ? e.message : String(e) };
  }
}

function hasUsefulCacheValues(entry: BalanceCacheEntry, isAgentRole: boolean): boolean {
  if (isAgentRole) return entry.nativeWei != null;
  return entry.nativeWei != null || entry.bondWei != null;
}

async function gatherServiceBalances(
  store: Store,
  rpcClient: StatusBalanceRpc,
  fleet: FleetState,
  chainCfg: ReturnType<typeof getChainConfig>,
): Promise<{
  byDisplay: Record<
    number,
    { agentNativeWei: string; safeNativeWei: string; safeBondWei: string }
  >;
  errorsByDisplay: Record<number, ServiceBalanceErrorEntry>;
}> {
  const ttlMs = 30_000;
  const now = Date.now();
  const cache = new Map(store.getBalanceCache().map((e) => [e.role, e]));
  const out: Record<
    number,
    { agentNativeWei: string; safeNativeWei: string; safeBondWei: string }
  > = {};
  const errorsByDisplay: Record<number, ServiceBalanceErrorEntry> = {};

  async function getCachedOrFetch(
    role: string,
    address: string,
    isAgentRole: boolean,
    fetcher: () => Promise<{ nativeWei?: string; bondWei?: string; assetExtraJson?: string }>,
  ): Promise<BalanceCacheEntry> {
    const cached = cache.get(role);
    if (cached && cached.address.toLowerCase() === address.toLowerCase()) {
      const age = now - Date.parse(cached.fetchedAt);
      const canUseTtl =
        Number.isFinite(age) && age <= ttlMs && (!cached.error || hasUsefulCacheValues(cached, isAgentRole));
      if (canUseTtl) return cached;
    }
    try {
      const fresh = await fetcher();
      const entry: BalanceCacheEntry = {
        role,
        address,
        nativeWei: fresh.nativeWei ?? null,
        bondWei: fresh.bondWei ?? null,
        assetExtraJson: fresh.assetExtraJson ?? null,
        fetchedAt: new Date(now).toISOString(),
        error: null,
      };
      store.upsertBalanceCache(entry);
      cache.set(role, entry);
      return entry;
    } catch (error) {
      const errMsg = error instanceof Error ? error.message : String(error);
      const keepTs =
        cached &&
        hasUsefulCacheValues(cached, isAgentRole) &&
        cached.fetchedAt;
      const entry: BalanceCacheEntry = {
        role,
        address,
        nativeWei: cached?.nativeWei ?? null,
        bondWei: cached?.bondWei ?? null,
        assetExtraJson: cached?.assetExtraJson ?? null,
        fetchedAt: (keepTs ? keepTs : new Date(now).toISOString()) as string,
        error: errMsg,
      };
      store.upsertBalanceCache(entry);
      cache.set(role, entry);
      return entry;
    }
  }

  await Promise.all(
    fleet.services.map(async (svc) => {
      const displayIndex = displayFleetServiceIndex(svc);
      const agentAddr = svc.agent_address;
      const safeAddr = svc.safe_address;
      if (!agentAddr && !safeAddr) return;

      const agentRole = `service.${displayIndex}.agent`;
      const safeRole = `service.${displayIndex}.multisig`;
      const [agent, safe] = await Promise.all([
        agentAddr
          ? getCachedOrFetch(agentRole, agentAddr, true, async () => {
              const native = await rpcClient.getBalance({ address: agentAddr as `0x${string}` });
              return { nativeWei: native.toString() };
            })
          : Promise.resolve<BalanceCacheEntry>({
              role: agentRole, address: '0x', nativeWei: '0', bondWei: '0', fetchedAt: new Date(now).toISOString(),
            }),
        safeAddr
          ? getCachedOrFetch(safeRole, safeAddr, false, async () => {
              const [native, bond] = await Promise.all([
                rpcClient.getBalance({ address: safeAddr as `0x${string}` }),
                rpcClient.readContract({
                  address: chainCfg.olasToken as `0x${string}`,
                  abi: ERC20_BALANCE_OF_ABI,
                  functionName: 'balanceOf',
                  args: [safeAddr as `0x${string}`],
                }),
              ]);
              return { nativeWei: native.toString(), bondWei: bond.toString() };
            })
          : Promise.resolve<BalanceCacheEntry>({
              role: safeRole, address: '0x', nativeWei: '0', bondWei: '0', fetchedAt: new Date(now).toISOString(),
            }),
      ]);
      const agentWei = agent.nativeWei ?? '0';
      const safeNWei = safe.nativeWei ?? '0';
      const safeBWei = safe.bondWei ?? '0';
      const rowErr: ServiceBalanceErrorEntry = {};
      if (agent.error) rowErr.agent = agent.error;
      if (safe.error) rowErr.multisig = safe.error;
      if (Object.keys(rowErr).length) errorsByDisplay[displayIndex] = rowErr;
      out[displayIndex] = {
        agentNativeWei: agentWei,
        safeNativeWei: safeNWei,
        safeBondWei: safeBWei,
      };
    }),
  );
  return { byDisplay: out, errorsByDisplay };
}

/** Collect status inputs without assembling the legacy mega-response. */
export async function gatherGatheredStatusRaw(
  store: Store,
  status: StatusGatherConfig | undefined,
): Promise<GatheredStatusRaw> {
  const shutdownState = store.getShutdownState();
  const daemonStartedAt = store.getDaemonStartedAt();
  const activityCounts = store.getActivityCountsByKind();
  const recentActivity = store.getRecentActivityEvents(12).map((row) => ({
    id: row.id,
    ts: row.ts,
    kind: row.kind,
    requestId: row.requestId,
    serviceIndex: row.serviceIndex,
    txHash: row.txHash,
    solverType: row.solverType,
    outcome: row.outcome,
  }));
  const lastRewardClaimTickAt = store.getConfigValue('last_reward_claim_tick_at');
  const taskRunReadModel = store.taskRunReadModel();
  const daily = resolveMasterDailyEstimateWei(
    status?.masterEthDailyEstimateWei,
    status?.pollIntervalMs ?? 5000,
  );

  // portfolio.v0 lifecycle data — best-effort, never throws
  let portfolioV0: ReturnType<typeof gatherPortfolioV0Status> | undefined;
  try {
    portfolioV0 = gatherPortfolioV0Status(
      taskRunReadModel,
      store,
      status?.engine?.workingDirRoot ?? DEFAULT_ENGINE_WORKING_DIR_ROOT,
    );
  } catch {
    portfolioV0 = undefined;
  }

  let taskRuns: ReturnType<typeof gatherTaskRunsStatus> | undefined;
  try {
    taskRuns = gatherTaskRunsStatus(taskRunReadModel);
  } catch {
    taskRuns = undefined;
  }

  // Enrich task-relative outcomes from the network's verdict tallies
  // (spec/2026-05-22-run-outcome.md). DISPLAY signal — degrade silently to
  // null on any discovery failure; never surface a wrong 'fail'.
  if (taskRuns && status?.discovery) {
    try {
      const solveTaskIds = [
        ...new Set(
          [...taskRuns.recentTasks, ...taskRuns.inFlight]
            .filter((r) => r.taskRole !== 'evaluation' && r.state === 'COMPLETE' && r.taskId)
            .map((r) => r.taskId as string),
        ),
      ];
      const tallies: Map<string, VerdictTallyResult> = solveTaskIds.length
        ? await status.discovery.getVerdictTallies({ taskIds: solveTaskIds })
        : new Map();
      applyOutcomes(taskRuns.recentTasks, tallies);
      applyOutcomes(taskRuns.inFlight, tallies);
    } catch {
      // Outcomes stay null → SPA renders '—'/'awaiting'.
    }
  }

  let harnessRollup: ReturnType<typeof buildHarnessRollup> | undefined;
  try {
    const hr = status?.harnessReadiness?.();
    if (hr) {
      harnessRollup = buildHarnessRollup(hr.snapshot, hr.joinedHarnessesByCid);
    }
  } catch {
    // Best-effort: leave harnessRollup unset so assembleStatusV1 falls
    // through to the default-ready posture.
  }

  let predictionOperator: PredictionOperatorStatusForApi | null = null;
  let predictionOperatorError: string | undefined;
  if (status?.config) {
    try {
      const solverNetName = derivePredictionSolverNetName(status.config);
      const raw = await getCachedPredictionOperatorStatus(
        status.config,
        status.configPath ?? '<default>',
        solverNetName,
      );
      predictionOperator = narrowOperatorStatusForApi(raw);
    } catch (error) {
      predictionOperatorError = errorMessage(error);
    }
  }

  let predictionV1: PredictionV1Status | undefined;
  try {
    predictionV1 = gatherPredictionV1Status(taskRunReadModel, {
      operator: predictionOperator,
      operatorError: predictionOperatorError,
    });
  } catch (error) {
    const lifecycleError = errorMessage(error);
    predictionV1 = predictionV1Unavailable(
      predictionOperator,
      predictionOperatorError
        ? `${predictionOperatorError}; prediction lifecycle unavailable: ${lifecycleError}`
        : `Prediction lifecycle unavailable: ${lifecycleError}`,
    );
  }

  const baseRaw: GatheredStatusRaw = {
    shutdownState,
    daemonRuntime: readDaemonRuntime(status?.earningDir),
    daemonStartedAt,
    passwordRotationAt: resolvePasswordRotationAt(status?.passwordRotation),
    dbPath: store.path,
    earningDir: status?.earningDir,
    activityCounts,
    recentActivity,
    lastRewardClaimTickAt,
    rewardClaimIntervalMs: status?.rewardClaimIntervalMs ?? 0,
    fleet: null,
    rpc: { ok: true },
    master: { address: null },
    pollIntervalMs: status?.pollIntervalMs ?? 5000,
    masterDailyEstimateWei: daily.toString(),
    portfolioV0,
    predictionV1,
    taskRuns,
    serviceBalances: {},
    pendingByService: {},
    claimedByService: store.getClaimedRewardsByService(),
    claimedStakingRewardsLast24hWei: store.getClaimedRewardsLast24hWei(),
    harnessRollup,
  };

  if (!status) {
    return { ...baseRaw, hintsScope: 'sqlite_only' };
  }

  const earningStore = new FleetStateStore(status.earningDir);
  const fleet = await earningStore.tryLoadExisting();
  const migrationArchive = await earningStore.loadMigrationArchive();

  const vk = chainKey(status.network);
  const chainCfg = getChainConfig(vk, {
    testnetL2DeploymentPath: status.testnetL2DeploymentPath,
    testnetL2TokenDeploymentPath: status.testnetL2TokenDeploymentPath,
    testnetMechDeploymentPath: status.testnetMechDeploymentPath,
    testnetStolasDeploymentPath: status.testnetStolasDeploymentPath,
  });

  const raw: GatheredStatusRaw = {
    ...baseRaw,
    fleet,
    migrationArchive: migrationArchive.entries.length > 0 ? migrationArchive : undefined,
    rpc: { ok: false, error: undefined },
    // Pre-Stage-1 (fleet state missing or fleet_stage === 'none'):
    // stage1MinMasterEth returns the FULL bootstrap budget — Stage 1 transfer
    // + Stage 2 reserve + per-extra-service top-ups — so the operator funds
    // ONCE and the daemon doesn't re-prompt at the Stage 2 gate. See
    // jinn-mono-u34i (gate-vs-transfer parity) and the one-shot-funding
    // follow-up.
    // Post-Stage-1, fall back to the existing 1× / 2× minEoaGasEth heuristic
    // (the operator already funded Stage 1; this gate only needs to cover
    // what's left).
    minMasterEthWei: (
      !fleet || fleet.fleet_stage === 'none'
        ? stage1MinMasterEth(chainCfg, status?.config?.targetServices ?? 1)
        : // Stage 2 master gas budget — minEoaGasEth (stake gas) + per-extra-
          // service transfers. The historic `× 2` for fresh fleets was wrong:
          // it double-counted a service-1 transfer that doesn't fire (HD-1
          // carries Stage 1 leftover). Dropped in jinn-mono-u34i so the
          // operator-facing 0.020 ETH budget actually clears Stage 2's gate.
          chainCfg.minEoaGasEth +
            chainCfg.minEoaGasEth *
              BigInt(Math.max(0, (status?.config?.targetServices ?? 1) - 1))
    ).toString(),
    master: {
      address: fleet?.master_address ?? null,
    },
    rewardClaimIntervalMs: status.rewardClaimIntervalMs,
  };

  // Auto-restake gating (issue #651). Must mirror main.ts:~2520-2523 — when
  // that predicate changes (evictionCheckIntervalMs > 0 && stakingMode ===
  // 'standard' && !!CHAIN_CONFIG.distributorAddress), this one must change
  // too. `stOlasDistributorAddress` is the same on-chain artifact threaded
  // through `StatusGatherConfig`.
  const evictionIntervalMs = status.config?.evictionCheckIntervalMs ?? 0;
  raw.evictionCheckIntervalMs = evictionIntervalMs;
  raw.autoRestakeEnabled =
    evictionIntervalMs > 0 &&
    status.config?.stakingMode === 'standard' &&
    !!status.stOlasDistributorAddress;

  const viemChain = status.network === 'testnet' ? baseSepolia : base;
  const client = createPublicClient({
    chain: viemChain,
    transport: http(status.rpcUrl),
  });

  try {
    const [blockNumber, chainId] = await Promise.all([
      client.getBlockNumber(),
      client.getChainId(),
    ]);
    raw.rpc = {
      ok: true,
      chainId,
      blockNumber: blockNumber.toString(),
    };
  } catch (e) {
    raw.rpc = {
      ok: false,
      error: e instanceof Error ? e.message : String(e),
    };
  }

  if (fleet?.master_address) {
    try {
      const bal = await client.getBalance({
        address: fleet.master_address as `0x${string}`,
      });
      raw.master = {
        address: fleet.master_address,
        balanceWei: bal.toString(),
      };
    } catch (e) {
      raw.master = {
        address: fleet.master_address,
        error: e instanceof Error ? e.message : String(e),
      };
    }
  }

  if (fleet) {
    const per: Record<
      number,
      { counts: Record<string, number>; lastEventAt: string | null }
    > = {};
    for (const svc of fleet.services) {
      const di = displayFleetServiceIndex(svc);
      per[di] = {
        counts: store.getActivityCountsForService(di),
        lastEventAt: store.getLastEventAtForService(di),
      };
    }
    raw.perServiceActivity = per;
    const bal = await gatherServiceBalances(store, client, fleet, chainCfg);
    raw.serviceBalances = bal.byDisplay;
    if (Object.keys(bal.errorsByDisplay).length > 0) {
      raw.serviceBalanceErrors = bal.errorsByDisplay;
    }
  }

  return raw;
}

export async function gatherStatusForApi(
  store: Store,
  status: StatusGatherConfig | undefined,
): Promise<StatusV1Response> {
  const raw = await gatherGatheredStatusRaw(store, status);
  const body = assembleStatusV1(raw);
  // Loop-completion + impl-state commit cadence (#959). Both are read-only and
  // degrade to zeroes / an empty list — they never throw the status endpoint.
  body.loopCompletion = gatherLoopCompletion(store.taskRunReadModel());
  if (status?.engine?.implStateDirRoot) {
    body.implStateCadence = gatherImplStateCadence(status.engine.implStateDirRoot);
  }
  const caps = status?.spendCaps;
  if (caps && Object.keys(caps).length > 0) {
    const now = new Date();
    const resetsAt = new Date(
      Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1),
    ).toISOString();
    body.spend = {
      credentials: Object.entries(caps).map(([credentialId, capUsd]) => {
        const spentTodayUsd = store.spentTodayMicros(credentialId, now) / 1_000_000;
        return { credentialId, capUsd, spentTodayUsd, paused: isOverSpendCap(spentTodayUsd, capUsd), resetsAt };
      }),
    };
  }
  const aiUnitsCfg = status?.aiUnits;
  if (aiUnitsCfg) {
    const now = new Date();
    const blockResetsAt = blockResetsAtUtc(now).toISOString();
    const weekResetsAt = weekResetsAtUtc(now).toISOString();
    // Dedupe credentials across manifests — multiple SolverNets on the same
    // credential share one row.
    const uniqueCredentials = new Set(Object.values(aiUnitsCfg.manifestCredentials));
    // Peg: usd_micros = units / 100 * GPT_5_4_MINI_USD_PER_BLOCK * 1e6.
    // Inverse (USD micros -> units) for the legacy unit surface (#1006).
    const usdMicrosToUnits = (usdMicros: number): number =>
      (usdMicros / 1_000_000 / GPT_5_4_MINI_USD_PER_BLOCK) * 100;
    body.aiUnits = {
      credentials: [...uniqueCredentials].map((credentialId) => {
        const block = store.usdMicrosThisBlock(credentialId, now);
        const week = store.usdMicrosThisWeek(credentialId, now);
        const paused =
          block.usdMicros >= aiUnitsCfg.capPerBlockUsdMicros ||
          week.usdMicros >= aiUnitsCfg.capPerWeekUsdMicros;
        return {
          credentialId,
          // #1006: legacy unit fields, derived from USD via the peg.
          unitsThisBlock: usdMicrosToUnits(block.usdMicros),
          unitsThisWeek: usdMicrosToUnits(week.usdMicros),
          capPerBlock: aiUnitsCfg.capPerBlock,
          capPerWeek: aiUnitsCfg.capPerWeek,
          // USD fields (issue #1004).
          usdMicrosThisBlock: block.usdMicros,
          usdMicrosThisWeek: week.usdMicros,
          capPerBlockUsdMicros: aiUnitsCfg.capPerBlockUsdMicros,
          capPerWeekUsdMicros: aiUnitsCfg.capPerWeekUsdMicros,
          // estimated = the summed figure includes any estimate-backed cost
          // (a telemetry-less/heuristic harness such as Hermes, or an
          // in-flight claimed row not yet harvested); false only when every
          // contributing row is harvested actual telemetry (issue #1004 AC4).
          estimated: block.estimated || week.estimated,
          paused,
          // active = this credential has spend in the current 7d window, so it
          // is the one actually being worked against (distinguishes a
          // configured-but-idle credential from the live one — issue #891).
          // Cold-start caveat: a working harness reads active=false until its
          // first cost row lands in the window (fresh node or just-reset 7d
          // window), so this can transiently under-report the live credential.
          active: week.usdMicros > 0,
          blockResetsAt,
          weekResetsAt,
        };
      }),
    };
  }
  return body;
}
