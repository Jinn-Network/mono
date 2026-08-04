/**
 * Pure assembly for GET /v1/status JSON (testable without RPC or filesystem).
 */

import {
  isOperationalServiceStep,
  isStakedLikeServiceStep,
  type FleetState,
} from '../earning/types.js';
import { displayFleetServiceIndex } from '../earning/fleet-display-index.js';
import type { EarningMigrationArchive } from '../earning/store.js';
import type { PortfolioV0Status } from './portfolio-v0-build.js';
import type { PredictionV1Status } from './prediction-v1-build.js';
import type { TaskRunsStatus } from './task-runs-build.js';
import type { LoopCompletionStatus, ImplStateCadenceStatus } from './loop-completion-build.js';
import type { EvidenceIndexingStatus } from '../types/evidence-indexing.js';
import { DEFAULT_HARNESS_ROLLUP, type HarnessRollup } from './status-harness-rollup.js';
import {
  buildCostSurfaceStatus,
  type CostSurfaceStatus,
} from '../spend/cost-surface-status.js';
import { DEFAULT_MASTER_ETH_DAILY_WEI } from '../earning/master-gas.js';
import { buildInfo } from '../build-info.js';
import type { PhaseDTransitionUsageDiagnostics } from '../compatibility/phase-d-transition-usage.js';
import type { OperatorVerticalMode } from '../types/operator-vertical-mode.js';

export type StatusHintsScope = 'full' | 'sqlite_only';

export interface ServiceBalanceErrorEntry {
  agent?: string;
  multisig?: string;
}

/** Per-credential daily spend row exposed on /v1/status. */
export interface SpendCredentialRow {
  credentialId: string;
  capUsd: number;
  spentTodayUsd: number;
  paused: boolean;
  resetsAt: string;
}

/** Per-credential daily spend block; present on /v1/status when caps are configured. */
export interface SpendStatus {
  credentials: SpendCredentialRow[];
}

/** The AI-units window a paused credential is binding on, or `null` when not paused. */
export type AiUnitsPausedWindow = 'block' | 'week' | null;

/** Per-credential AI-units row exposed on /v1/status (issues #815, #1004). */
export interface AiUnitsCredentialRow {
  credentialId: string;
  // #1006: legacy unit-denominated fields the SPA reads today. Derived from
  // the USD accumulator via the GPT-5.4-mini peg so they track the real gate.
  // Remove when #1006 migrates the SPA to the USD fields below.
  unitsThisBlock: number;
  unitsThisWeek: number;
  capPerBlock: number;
  capPerWeek: number;
  /** Actual USD spend this 6h block, in micros (issue #1004). */
  usdMicrosThisBlock: number;
  /** Actual USD spend this 7d window, in micros (issue #1004). */
  usdMicrosThisWeek: number;
  /** USD ceiling for the block / week, in micros (issue #1004). */
  capPerBlockUsdMicros: number;
  capPerWeekUsdMicros: number;
  /**
   * True when the summed figure includes any estimate-backed cost: a
   * telemetry-less/heuristic harness such as Hermes (whose delivered actual
   * cost is itself a heuristic), or an in-flight claimed row not yet
   * harvested. False only when every contributing row is harvested actual
   * telemetry. Issue #1004 (AC4).
   */
  estimated: boolean;
  /**
   * True when at least one known configured task projection would make the
   * block or week sum exceed its cap. Unknown projections fail open.
   */
  paused: boolean;
  /**
   * True when this credential has recorded spend in the current 7d window —
   * i.e. it is the credential the daemon is actually working against, not a
   * configured-but-idle one. Distinguishes an active harness from a merely
   * enrolled one in the /v1/status footprint (issue #891).
   */
  active: boolean;
  /**
   * The binding window when `paused` is true, using the daemon gate's shared
   * projected-debit classifier. Across multiple tasks on one credential,
   * block wins if any known projection is block-gated; otherwise week wins
   * when any known projection is week-gated. `null` when no known projection
   * is blocked. Lets the SPA render the pause reason without re-deriving the
   * decision locally (issue #830, item 2).
   */
  pausedWindow: AiUnitsPausedWindow;
  /** ISO timestamp of the next 6h block boundary (00:00 / 06:00 / 12:00 / 18:00 UTC). */
  blockResetsAt: string;
  /**
   * ISO timestamp claims resume for the 7d window. When the week window is
   * binding, this is the accurate rolling-window resume instant for the
   * credential's largest known configured projection (the moment enough
   * in-window spend expires that `remaining + projected <= cap`; see
   * `Store.weekWindowResumeAt`). `null` means the projection alone exceeds
   * the weekly cap, so no spend expiry can schedule a resume without a model
   * or cap change. Otherwise this falls back to the coarse
   * `weekResetsAtUtc(now)` (`now + 7d`) instant, which is not
   * operator-relevant in that case (issue #830, item 1).
   */
  weekResetsAt: string | null;
}

/** Per-credential AI-units block; present on /v1/status when AI-units gating is on. */
export interface AiUnitsStatus {
  credentials: AiUnitsCredentialRow[];
}

/**
 * One-time shape-v2 config migration report, present only on the boot where
 * `migrateConfigShapeV2` produced a report with `migrated === true` (see
 * `client/src/config/migrate-shape-v2.ts`, `getLastConfigMigrationReport`).
 *
 * `capsUnset` is true when the migrated `claimPolicy` is missing or its
 * `spendCapWei`/`aiUnitCap` are unset. Per coordinator amendment 1 (F7
 * reversed), this is informational, not action-required: the host's USD
 * spend gates (spec §6.5) remain the operative bound whether or not
 * per-claim caps are set — exactly today's behavior (spec §9).
 */
export interface ConfigMigrationStatus {
  readonly shapeVersion: 2;
  readonly wiringEntries: number;
  readonly postingEntries: number;
  readonly backupPath?: string;
  readonly capsUnset: boolean;
}

export interface GatheredStatusRaw {
  /** sqlite_only: only SQLite-backed fields (e2e / API without fleet context). */
  hintsScope?: StatusHintsScope;
  /**
   * Running client version (issue #641). Absent ⇒ the assembler falls back to
   * `buildInfo.implVersion`.
   */
  version?: string;
  /**
   * Latest published `@jinn-network/client` version from the npm registry, or
   * `null` when the check hasn't resolved / is disabled (issue #641).
   */
  latestVersion?: string | null;
  shutdownState: string | null;
  daemonRuntime?: {
    pidPath: string;
    pid: number | null;
    alive: boolean;
    stale: boolean;
  };
  daemonStartedAt?: string | null;
  /** Durable Phase D compatibility-use counters exposed for an external observation window. */
  phaseDTransitionUsage?: PhaseDTransitionUsageDiagnostics;
  /**
   * The daemon's resolved product mode (#2380), threaded from `main.ts`'s call to
   * `resolveConfiguredOperatorVerticalMode` — never re-derived here. Absent ⇒ `assembleStatusV1`
   * defaults to `'legacy'`, matching the fact that `GET /v1/status` only exists on the legacy
   * entry point (native has no API server; see `native-phase-d-observability.ts`'s durable
   * snapshot for its equivalent).
   */
  effectiveMode?: OperatorVerticalMode;
  /**
   * Resolved ISO mtime of the keystore-password file, or `null` when the
   * password is env-sourced or the file is missing/unreadable. Computed at
   * request time in `gatherGatheredStatusRaw` from the threaded
   * `passwordRotation` descriptor; projected into `security.lastPasswordRotationAt`
   * by `assembleStatusV1`. Absent on `raw` ⇒ assembler emits `null` (issue #441).
   */
  passwordRotationAt?: string | null;
  dbPath: string;
  earningDir?: string;
  activityCounts: Record<string, number>;
  recentActivity: Array<{
    id: number;
    ts: string | null;
    kind: string;
    requestId: string | null;
    serviceIndex: number | null;
    txHash: string | null;
    solverType: string | null;
    outcome: string | null;
  }>;
  lastRewardClaimTickAt: string | null;
  rewardClaimIntervalMs: number;
  fleet: FleetState | null;
  rpc: { ok: boolean; chainId?: number; blockNumber?: string; error?: string };
  master: {
    address: string | null;
    balanceWei?: string;
    error?: string;
  };
  /**
   * On-demand staking reward queue total (wei). Populated only by `jinn rewards`
   * splicing the result of `sumPendingStakingRewards` onto raw, never on the
   * /v1/status hot path (#992).
   */
  pendingStakingRewardsWei?: string;
  /** Error from the on-demand staking reward read. Kept off /v1/status hot path. */
  pendingStakingRewardsError?: string;
  /**
   * ISO timestamp when the staking contract will next accept a checkpoint.
   * Populated only by `jinn rewards` on demand, never on the /v1/status hot
   * path (#992).
   */
  nextCheckpointAt?: string;
  pollIntervalMs: number;
  /** Resolved daily burn estimate for runway (wei string). */
  masterDailyEstimateWei: string;
  minMasterEthWei?: string;
  /** L1 (Ethereum Sepolia) master native balance for the L1 gas-runway warning (#1296). */
  l1Master?: { address: string | null; balanceWei?: string; error?: string };
  /** Minimum L1 master ETH floor (wei string). Absent ⇒ no l1MasterGas runway. */
  minL1MasterEthWei?: string;
  /** Resolved L1 daily burn estimate for runway (wei string). */
  l1MasterDailyEstimateWei?: string;
  /** portfolio.v0 lifecycle data — populated by gather-status from the SQLite store. */
  portfolioV0?: PortfolioV0Status;
  /** prediction.v1 operator/lifecycle data — populated by gather-status from the SQLite store. */
  predictionV1?: PredictionV1Status;
  /** Generic task-run lifecycle data across all SolverNets. */
  taskRuns?: TaskRunsStatus;
  serviceBalances?: Record<number, { agentNativeWei: string; safeNativeWei: string; safeBondWei: string }>;
  /** Last balance fetch error per service (display index). Present when a fetch failed. */
  serviceBalanceErrors?: Record<number, ServiceBalanceErrorEntry>;
  perServiceActivity?: Record<
    number,
    { counts: Record<string, number>; lastEventAt: string | null }
  >;
  /**
   * Per-service pending staking reward queue (wei) keyed by display index.
   * Populated only by `jinn rewards` on demand, never on the /v1/status hot
   * path (#992).
   */
  pendingByService?: Record<number, string>;
  claimedByService?: Record<number, { total: string; lastAt: string; lastTxHash: string }>;
  /** Sum of stOLAS reward_claims rows in the last 24 hours (wei). */
  claimedStakingRewardsLast24hWei?: string;
  migrationArchive?: EarningMigrationArchive;
  /**
   * Harness readiness rollup — single boolean + name + reason summary across
   * all joined harnesses. Populated by gather-status from the daemon's
   * HarnessReadinessRegistry when threaded through `StatusGatherConfig`.
   * Absent → assembleStatusV1 emits a default-ready rollup so callers that
   * don't thread it (sqlite-only contexts, older tests) still see the field
   * on the wire. See `status-harness-rollup.ts`.
   */
  harnessRollup?: HarnessRollup;
  /**
   * Mirror of the `main.ts` predicate that gates the EvictionLoop:
   * `evictionCheckIntervalMs > 0 && stakingMode === 'standard' && !!distributorAddress`.
   * Exposed on `/v1/status` as `autoRestake` for observability.
   */
  autoRestakeEnabled?: boolean;
  /** Configured EvictionLoop poll interval in milliseconds (0 when the loop is disabled). */
  evictionCheckIntervalMs?: number;
  /** One-time shape-v2 config migration report (see `ConfigMigrationStatus`). */
  configMigration?: ConfigMigrationStatus;
}

export interface StatusV1Response {
  statusMode: 'full' | 'sqlite_only';
  /** Running client version (issue #641). */
  version: string;
  /**
   * Latest published `@jinn-network/client` version from the npm registry, or
   * `null` when the start-time check hasn't resolved / is disabled. The SPA's
   * `useNotifications` adapter fires `update_available` when it differs from
   * `version` (issue #641).
   */
  latestVersion: string | null;
  daemon: {
    shutdownState: string | null;
    startedAt: string | null;
    dbPath: string;
    timestamp: string;
  };
  rpc: GatheredStatusRaw['rpc'];
  fleet: {
    loaded: boolean;
    chain?: string;
    stakingMode?: string;
    masterAddress?: string | null;
    services: Array<{
      index: number;
      step: string;
      serviceId: number | null;
      safeAddress: string | null;
      mechAddress: string | null;
      stakingAddress: string | null;
      agentId: string | null;
      identityRegistryAddress: string | null;
      safeBoundToAgent: boolean;
      identityBindingStatus: 'bound' | 'pending' | 'not_applicable';
    }>;
    stakedLikeCount: number;
    completeCount: number;
  };
  /**
   * Auto-restake (EvictionLoop) feature gating. Mirrors `main.ts`'s
   * `evictionCheck` predicate. Observability on `/v1/status` (issue #773).
   */
  autoRestake: {
    enabled: boolean;
    checkIntervalMs: number;
  };
  activity: {
    counts: Record<string, number>;
    recent: GatheredStatusRaw['recentActivity'];
  };
  rewards: {
    claimLoopIntervalMs: number;
    lastClaimTickAt: string | null;
    claimedStakingRewardsWei: string;
    claimedStakingRewardsLast24hWei: string | null;
  };
  /** Per-role ETH balance (master / agent / Safe). Wei strings, base-10. */
  balances: {
    eth: {
      master: { address: string | null; balanceWei: string | null; error?: string };
      agent:  { address: string | null; balanceWei: string | null; error?: string };
      safe:   { address: string | null; balanceWei: string | null; error?: string };
    };
  };
  masterGas: {
    address: string | null;
    balanceWei?: string;
    dailyEstimateWei: string;
    /** Approximate days of excess ETH above minimum at daily estimate (if computable). */
    runwayDaysExcess?: string;
    minEthWei?: string;
    error?: string;
  };
  /**
   * L1 (Ethereum Sepolia) master gas runway — parallel to `masterGas` but for
   * the L1 governance chain (#1296). Present only when the L1 master balance
   * was gathered (testnet with an ethereumRpcUrl); omitted on mainnet /
   * sqlite-only / older callers.
   */
  l1MasterGas?: {
    address: string | null;
    balanceWei?: string;
    dailyEstimateWei: string;
    runwayDaysExcess?: string;
    minEthWei?: string;
    error?: string;
  };
  earnings: {
    hint: string;
  };
  nextActions: string[];
  /** portfolio.v0 lifecycle data — optional, absent when not available. */
  portfolioV0?: PortfolioV0Status;
  /** prediction.v1 operator/lifecycle data — optional, absent when not available. */
  predictionV1?: PredictionV1Status;
  /** Generic task-run lifecycle data across all SolverNets. */
  taskRuns?: TaskRunsStatus;
  /**
   * Loop-completion rollup over task_runs.solution_outputs_json gating phases
   * (#959). Always present — defaults to all-zero when there are no rows.
   */
  loopCompletion?: LoopCompletionStatus;
  /**
   * Per-repo impl-state commit cadence under the impl-state root (#959).
   * Present only when an impl-state root was threaded through the gather
   * config; `repos` is empty when the root is absent / has no git repos.
   */
  implStateCadence?: ImplStateCadenceStatus;
  /**
   * Evidence indexing-failure rollup, fed by the `EvidenceDriverLoop` (Task
   * 11). Present only when the composition root threads a live driver
   * through `StatusGatherConfig.evidenceDriver`.
   */
  evidenceIndexing?: EvidenceIndexingStatus;
  /** Per-credential daily spend block — present when caps are configured. */
  spend?: SpendStatus;
  /** Per-credential AI-units 6h-block + 7d-window block — issue #815. */
  aiUnits?: AiUnitsStatus;
  /** Per-harness billing path for join/settings cost UI (#474). */
  costSurface: CostSurfaceStatus;
  /**
   * Harness readiness rollup — always present (default-ready when no rollup
   * input was threaded through gather-status). Consumed by the SPA's
   * `useNotifications` adapter to fire `harness_not_ready` when any joined
   * SolverNet's harness is unready. See `status-harness-rollup.ts`.
   */
  harness: HarnessRollup;
  /**
   * Security posture sub-object — always present. `lastPasswordRotationAt`
   * is the ISO mtime of the on-disk keystore-password file (the proxy for
   * "when the password was last set/rotated"), or `null` when the password
   * is env-sourced (`JINN_PASSWORD`, no file) or the file is missing /
   * unreadable. Consumed by the operator-app `password_rotation_due`
   * notification (issue #441).
   */
  security: { lastPasswordRotationAt: string | null };
  /** One-time shape-v2 config migration report — see `GatheredStatusRaw.configMigration`. */
  configMigration?: ConfigMigrationStatus;
  /** Durable compatibility-use diagnostics; collectors use this for Phase D zero-use gates. */
  phaseDTransitionUsage?: PhaseDTransitionUsageDiagnostics;
  /** The daemon's resolved product mode (#2380) — see `GatheredStatusRaw.effectiveMode`. Always
   *  present; defaults to `'legacy'` when the gatherer didn't thread a value. */
  effectiveMode: OperatorVerticalMode;
}

/**
 * Resolve the master daily gas estimate used by the operator dashboard's
 * "Nd runway" display. Honours `JINN_MASTER_ETH_DAILY_WEI` (threaded via the
 * `explicit` arg) when set; otherwise returns the conservative default.
 * The `_pollIntervalMs` parameter is vestigial since the poll-based blend
 * was removed in #288; kept so the gather-status call site stays unchanged.
 */
export function resolveMasterDailyEstimateWei(
  explicit: string | undefined,
  _pollIntervalMs: number,
): bigint {
  if (explicit !== undefined && /^\d+$/.test(explicit.trim())) {
    return BigInt(explicit.trim());
  }
  return DEFAULT_MASTER_ETH_DAILY_WEI;
}

function fleetSummary(
  fleet: FleetState | null,
): StatusV1Response['fleet'] {
  if (!fleet) {
    return {
      loaded: false,
      services: [],
      stakedLikeCount: 0,
      completeCount: 0,
    };
  }
  const services = fleet.services.map(s => {
    const di = displayFleetServiceIndex(s);
    return {
    index: di,
    step: s.step,
    serviceId: s.service_id,
    safeAddress: s.safe_address,
    mechAddress: s.mech_address,
    stakingAddress: s.staking_address,
    agentId: s.agent_id ?? null,
    identityRegistryAddress: s.identity_registry_address ?? null,
    safeBoundToAgent: s.safe_bound_to_agent === true,
    identityBindingStatus: (
      s.safe_bound_to_agent === true
        ? 'bound'
        : s.agent_id && s.safe_address
          ? 'pending'
          : 'not_applicable'
    ) as 'bound' | 'pending' | 'not_applicable',
    };
  });
  const stakedLikeCount = fleet.services.filter(s => isStakedLikeServiceStep(s.step)).length;
  const completeCount = fleet.services.filter(s => isOperationalServiceStep(s.step)).length;
  return {
    loaded: true,
    chain: fleet.chain,
    stakingMode: fleet.staking_mode,
    masterAddress: fleet.master_address,
    services,
    stakedLikeCount,
    completeCount,
  };
}

function computeRunwayDaysExcess(
  balanceWei: bigint,
  minWei: bigint | undefined,
  daily: bigint,
): string | undefined {
  if (daily === 0n) return undefined;
  if (minWei !== undefined) {
    if (balanceWei <= minWei) return '0';
    const excess = balanceWei - minWei;
    if (excess <= 0n) return '0';
    return (excess / daily).toString();
  }
  if (balanceWei <= 0n) return '0';
  return (balanceWei / daily).toString();
}

function sumClaimedRewardsLast24hWei(raw: GatheredStatusRaw): string | null {
  const value = raw.claimedStakingRewardsLast24hWei;
  if (value === undefined) return null;
  return value;
}

function sumClaimedRewardsWei(raw: GatheredStatusRaw): bigint {
  let total = 0n;
  for (const claim of Object.values(raw.claimedByService ?? {})) {
    try {
      total += BigInt(claim.total);
    } catch {
      /* ignore malformed legacy rows */
    }
  }
  return total;
}

function buildEarningsHint(raw: GatheredStatusRaw, fleetSum: StatusV1Response['fleet']): string {
  if (raw.hintsScope === 'sqlite_only') {
    return 'Fleet and on-chain earnings hints omitted in API-only mode.';
  }
  if (!fleetSum.loaded || fleetSum.services.length === 0) {
    return 'No fleet services in local state — earnings accrue after staking completes.';
  }
  return 'On-chain staking reward queue is reported by `jinn rewards`, not /v1/status.';
}

function buildNextActions(raw: GatheredStatusRaw, fleetSum: StatusV1Response['fleet']): string[] {
  const actions: string[] = [];

  if (raw.hintsScope === 'sqlite_only') {
    return [
      'Full operations status requires daemon start with status context, or run `npm run status` while the daemon is up.',
    ];
  }

  if (!raw.rpc.ok) {
    actions.push('Restore RPC access (check rpcUrl / network) for live balances and rewards.');
  }

  if (!fleetSum.loaded) {
    actions.push('Run bootstrap (`jinn run` with JINN_PASSWORD) to create fleet and staking state.');
  } else {
    if (!raw.fleet?.master_address) {
      actions.push('Complete earning bootstrap so master_address is recorded.');
    }
    for (const s of raw.fleet?.services ?? []) {
      if (s.error) {
        actions.push(`Service ${s.index}: ${s.error}`);
      }
      if (!isOperationalServiceStep(s.step)) {
        actions.push(`Resume service ${s.index}: local step "${s.step}" — re-run jinn run.`);
      } else if (s.step === 'safe_binding_pending') {
        actions.push(`Service ${s.index}: identity binding pending; daemon will retry setAgentWallet on next bootstrap.`);
      }
    }
  }

  if (raw.master.address && raw.minMasterEthWei && raw.master.balanceWei !== undefined) {
    const bal = BigInt(raw.master.balanceWei);
    const min = BigInt(raw.minMasterEthWei);
    if (bal < min) {
      actions.push('Fund master EOA with more ETH for gas (below configured minimum).');
    }
  }

  const daily = BigInt(raw.masterDailyEstimateWei);
  if (
    daily > 0n &&
    raw.master.balanceWei !== undefined &&
    raw.minMasterEthWei !== undefined
  ) {
    const bal = BigInt(raw.master.balanceWei);
    const min = BigInt(raw.minMasterEthWei);
    const excess = bal > min ? bal - min : 0n;
    const days = excess / daily;
    if (days < 3n && raw.rpc.ok) {
      actions.push('Master ETH runway is low; top up the master wallet soon.');
    }
  }

  if (raw.rewardClaimIntervalMs > 0 && !raw.lastRewardClaimTickAt && fleetSum.stakedLikeCount > 0) {
    actions.push('Reward claim loop is enabled; last tick time will appear after the first distributor pass.');
  }

  const dedup = [...new Set(actions)];
  if (dedup.length === 0) {
    dedup.push('No urgent actions — daemon loops and reward claims run on schedule.');
  }
  return dedup;
}

function buildEthBalances(raw: GatheredStatusRaw): StatusV1Response['balances']['eth'] {
  const primaryService = raw.fleet?.services?.[0];
  const di = primaryService !== undefined ? displayFleetServiceIndex(primaryService) : undefined;
  const row = di !== undefined ? raw.serviceBalances?.[di] : undefined;
  const rowErr = di !== undefined ? raw.serviceBalanceErrors?.[di] : undefined;

  return {
    master: {
      address: raw.master.address,
      balanceWei: raw.master.balanceWei ?? null,
      ...(raw.master.error !== undefined ? { error: raw.master.error } : {}),
    },
    agent: {
      address: primaryService?.agent_address ?? null,
      balanceWei: row?.agentNativeWei ?? null,
      ...(rowErr?.agent !== undefined ? { error: rowErr.agent } : {}),
    },
    safe: {
      address: primaryService?.safe_address ?? null,
      balanceWei: row?.safeNativeWei ?? null,
      ...(rowErr?.multisig !== undefined ? { error: rowErr.multisig } : {}),
    },
  };
}

export function assembleStatusV1(raw: GatheredStatusRaw): StatusV1Response {
  const fleetSum = fleetSummary(raw.fleet);
  const mode: 'full' | 'sqlite_only' = raw.hintsScope === 'sqlite_only' ? 'sqlite_only' : 'full';
  const claimedRewardsWei = sumClaimedRewardsWei(raw);
  const runway =
    raw.master.balanceWei !== undefined
      ? computeRunwayDaysExcess(
          BigInt(raw.master.balanceWei),
          raw.minMasterEthWei !== undefined ? BigInt(raw.minMasterEthWei) : undefined,
          BigInt(raw.masterDailyEstimateWei),
        )
      : undefined;
  // L1 (Ethereum Sepolia) gas runway (#1296). Computed only when the L1 master
  // balance was gathered and an L1 daily estimate is present.
  const l1Runway =
    raw.l1Master?.balanceWei !== undefined && raw.l1MasterDailyEstimateWei !== undefined
      ? computeRunwayDaysExcess(
          BigInt(raw.l1Master.balanceWei),
          raw.minL1MasterEthWei !== undefined ? BigInt(raw.minL1MasterEthWei) : undefined,
          BigInt(raw.l1MasterDailyEstimateWei),
        )
      : undefined;

  return {
    statusMode: mode,
    version: raw.version ?? buildInfo.implVersion,
    effectiveMode: raw.effectiveMode ?? 'legacy',
    latestVersion: raw.latestVersion ?? null,
    daemon: {
      shutdownState: raw.shutdownState,
      startedAt: raw.daemonStartedAt ?? null,
      dbPath: raw.dbPath,
      timestamp: new Date().toISOString(),
    },
    rpc: raw.rpc,
    fleet: fleetSum,
    autoRestake: {
      enabled: raw.autoRestakeEnabled === true,
      checkIntervalMs: raw.evictionCheckIntervalMs ?? 0,
    },
    activity: {
      counts: raw.activityCounts,
      recent: raw.recentActivity,
    },
    rewards: {
      claimLoopIntervalMs: raw.rewardClaimIntervalMs,
      lastClaimTickAt: raw.lastRewardClaimTickAt,
      claimedStakingRewardsWei: claimedRewardsWei.toString(),
      claimedStakingRewardsLast24hWei: sumClaimedRewardsLast24hWei(raw),
    },
    balances: { eth: buildEthBalances(raw) },
    masterGas: {
      address: raw.master.address,
      balanceWei: raw.master.balanceWei,
      dailyEstimateWei: raw.masterDailyEstimateWei,
      runwayDaysExcess:
        raw.master.balanceWei !== undefined && runway !== undefined ? runway : undefined,
      minEthWei: raw.minMasterEthWei,
      error: raw.master.error,
    },
    ...(raw.l1Master !== undefined
      ? {
          l1MasterGas: {
            address: raw.l1Master.address,
            balanceWei: raw.l1Master.balanceWei,
            dailyEstimateWei: raw.l1MasterDailyEstimateWei ?? '0',
            runwayDaysExcess:
              raw.l1Master.balanceWei !== undefined && l1Runway !== undefined
                ? l1Runway
                : undefined,
            minEthWei: raw.minL1MasterEthWei,
            error: raw.l1Master.error,
          },
        }
      : {}),
    earnings: {
      hint: buildEarningsHint(raw, fleetSum),
    },
    nextActions: buildNextActions(raw, fleetSum),
    costSurface: buildCostSurfaceStatus(process.env),
    harness: raw.harnessRollup ?? DEFAULT_HARNESS_ROLLUP,
    security: { lastPasswordRotationAt: raw.passwordRotationAt ?? null },
    ...(raw.portfolioV0 !== undefined ? { portfolioV0: raw.portfolioV0 } : {}),
    ...(raw.predictionV1 !== undefined ? { predictionV1: raw.predictionV1 } : {}),
    ...(raw.taskRuns !== undefined ? { taskRuns: raw.taskRuns } : {}),
    ...(raw.configMigration !== undefined ? { configMigration: raw.configMigration } : {}),
    ...(raw.phaseDTransitionUsage !== undefined
      ? { phaseDTransitionUsage: raw.phaseDTransitionUsage }
      : {}),
  };
}
