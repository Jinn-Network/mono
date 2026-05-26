/**
 * Best-effort status collection for GET /v1/status (RPC + earning store + SQLite).
 */

import { createPublicClient, getAddress, http, parseAbiItem, type PublicClient } from 'viem';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

/** Narrow RPC surface for balance fan-out (avoids PublicClient / chain-specific getBlock incompatibilities). */
type StatusBalanceRpc = Pick<PublicClient, 'getBalance' | 'readContract'>;
import { base, baseSepolia } from 'viem/chains';
import type { Store } from '../store/store.js';
import type { JinnConfig } from '../config.js';
import type { CredentialId } from '../spend/credential.js';
import { isOverSpendCap } from '../daemon/spend-cap-gate.js';
import { FleetStateStore } from '../earning/store.js';
import {
  DEFAULT_TESTNET_ARTIFACTS,
  getChainConfig,
  loadJinnMviConfig,
} from '../earning/contracts.js';
import { createJinnL1PublicClient } from '../earning/viem-clients.js';
import { stage1MinMasterEth } from '../earning/bootstrap.js';
import { JINN_STAKING_ABI } from '../earning/jinn-rewards.js';
import type { FleetState } from '../earning/types.js';
import { displayFleetServiceIndex } from '../earning/fleet-display-index.js';
import {
  assembleStatusV1,
  type GatheredStatusRaw,
  pendingTjinnStatus,
  type ServiceBalanceErrorEntry,
  type StatusV1Response,
  TJINN_PUBLIC_INVALID_SAFE_ERROR,
  TJINN_PUBLIC_PARTIAL_ERROR,
  TJINN_PUBLIC_READ_ERROR,
  type TjinnServiceStatus,
  type TjinnStatus,
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
import { gatherTaskRunsStatus } from './task-runs-build.js';
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

const JINN_DISTRIBUTOR_CLAIMED_ABI = [
  {
    type: 'function',
    name: 'totalClaimedOperator',
    stateMutability: 'view',
    inputs: [{ name: 'serviceId', type: 'uint256' }],
    outputs: [{ name: '', type: 'uint256' }],
  },
] as const;

/**
 * `Claimed` event item for `getLogs({ event, args })`. Matches the
 * Solidity signature in
 * `contracts/src/jinn/distribution/JinnDistributor.sol` so the operator
 * 24h-minted sum can be computed without a separate indexer.
 */
const JINN_DISTRIBUTOR_CLAIMED_EVENT = parseAbiItem(
  'event Claimed(uint256 indexed serviceId, address indexed multisig, uint256 operatorMinted, uint256 daoMinted, uint256 totalEntitledOperator, uint256 totalEntitledDao)',
);

const TJINN_BALANCE_CACHE_TTL_MS = 30_000;
const TJINN_BALANCE_TIMEOUT_MS = 6_000;

/**
 * Approximate Sepolia blocks per 24 hours. The chain produces a block every
 * ~12s; 86_400 / 12 = 7_200. We pad to 7_500 to absorb the occasional
 * slower block and keep the window comfortably within the common 10k-block
 * `eth_getLogs` cap.
 */
const SEPOLIA_BLOCKS_PER_24H = 7_500n;

/**
 * tJINN token address + chain id resolved from the bundled JINN MVI L1
 * deployment artifact — the single source of truth. Used only when the caller
 * (`main.ts`) does not thread explicit values through `StatusGatherConfig`
 * (e.g. test callers, sqlite-only introspection without config). Lazy + cached
 * so the artifact read happens at most once per process.
 */
let cachedTjinnArtifactIdentity: { tokenAddress: string; chainId: number } | undefined;
function defaultTjinnIdentity(): { tokenAddress: string; chainId: number } {
  if (!cachedTjinnArtifactIdentity) {
    let tokenAddress: string | undefined;
    let chainId: number | undefined;
    try {
      const mvi = loadJinnMviConfig({ l1ArtifactPath: DEFAULT_TESTNET_ARTIFACTS.jinnMviL1 });
      tokenAddress = mvi.jinn;
      chainId = mvi.l1ChainId;
    } catch {
      // Fall through to the hard defaults below if the artifact is unreadable.
    }
    cachedTjinnArtifactIdentity = {
      tokenAddress: tokenAddress ?? '0x0bc0B2f733bF4229FD58Baaac5ebFEf2AEc83C4A',
      chainId: chainId ?? 11155111,
    };
  }
  return cachedTjinnArtifactIdentity;
}

function resolveTjinnIdentity(
  status: StatusGatherConfig | undefined,
): { tokenAddress: string; chainId: number } {
  const fallback = defaultTjinnIdentity();
  return {
    tokenAddress: status?.tjinnTokenAddress ?? fallback.tokenAddress,
    chainId: status?.tjinnChainId ?? fallback.chainId,
  };
}

interface TjinnBalanceSnapshot {
  chainId: number;
  balances: Map<string, string>;
  operatorClaimedByService: Map<number, string>;
  /**
   * Sum of `Claimed.operatorMinted` over the last 24h, keyed by serviceId.
   * Missing entries indicate "no claims observed in the window" → 0; a null
   * top-level `operatorMintedLast24hWei` is only produced when the log
   * query itself failed (see `claimedLast24hError`).
   */
  operatorMintedLast24hByService: Map<number, string>;
  errors: Map<string, string>;
  claimedErrors: Map<number, string>;
  /** Set when the 24h `getLogs` query failed; the field is then reported as null. */
  claimedLast24hError: string | null;
}

/** Fill a fresh errors Map with `TJINN_PUBLIC_READ_ERROR` for every key. */
function errorsForAllKeys(keys: Iterable<string>): Map<string, string> {
  const errors = new Map<string, string>();
  for (const key of keys) {
    errors.set(key, TJINN_PUBLIC_READ_ERROR);
  }
  return errors;
}

function errorsForAllServiceIds(serviceIds: Iterable<number>): Map<number, string> {
  const errors = new Map<number, string>();
  for (const serviceId of serviceIds) {
    errors.set(serviceId, TJINN_PUBLIC_READ_ERROR);
  }
  return errors;
}

const tjinnBalanceCache = new Map<
  string,
  { expiresAt: number; promise: Promise<TjinnBalanceSnapshot> }
>();

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

const predictionOperatorStatusCache = new WeakMap<JinnConfig, Map<string, Promise<PredictionOperatorStatus>>>();

/**
 * Module-scoped first-seen-evicted tracker for the suppression window (issue #651).
 *
 * Key: `${chain}:${serviceId}`. Value: epoch ms when this gatherer first
 * observed `getStakingState === 2` for the service. Cleared as soon as the
 * service is no longer reported evicted, so a successful auto-restake (or a
 * manual one) immediately resets the window.
 *
 * Lives at module scope intentionally: gather-status is invoked on every
 * status read and we need state to persist across reads. The daemon is
 * single-process; no cross-instance coordination required.
 */
const evictionFirstSeenMs = new Map<string, number>();

/** Test-only: clear the first-seen-evicted tracker. Do not call from production code. */
export function __resetEvictionFirstSeenForTests(): void {
  evictionFirstSeenMs.clear();
}

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

export interface StatusGatherConfig {
  earningDir: string;
  rpcUrl: string;
  /**
   * tJINN ERC-20 token address — resolved from the bundled JINN MVI L1
   * deployment artifact in `main.ts` (single source of truth). Optional so
   * test callers can omit it; gather-status falls back to the artifact-derived
   * default when absent.
   */
  tjinnTokenAddress?: string;
  /** tJINN chain id — resolved from the same artifact as `tjinnTokenAddress`. */
  tjinnChainId?: number;
  /** JinnDistributor address used for real operator lifetime claimed totals. */
  tjinnDistributorAddress?: string;
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

function tJinnBalanceCacheKey(
  ethereumRpcUrl: string,
  distributorAddress: string | undefined,
  safeKeys: readonly string[],
  serviceIds: readonly number[],
): string {
  return [
    ethereumRpcUrl,
    distributorAddress ?? '',
    [...safeKeys].sort().join(','),
    [...serviceIds].sort((a, b) => a - b).join(','),
  ].join('\0');
}

function timeoutError(message: string): Error {
  const error = new Error(message);
  error.name = 'TimeoutError';
  return error;
}

function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  message: string,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(timeoutError(message)), timeoutMs);
    promise
      .then(resolve, reject)
      .finally(() => clearTimeout(timer));
  });
}

async function readTjinnBalances(
  ethereumRpcUrl: string,
  tokenAddress: string,
  distributorAddress: string | undefined,
  expectedChainId: number,
  safeToAddress: Map<string, `0x${string}`>,
  serviceIds: readonly number[],
): Promise<TjinnBalanceSnapshot> {
  const safeEntries = [...safeToAddress.entries()];
  const client = createJinnL1PublicClient(ethereumRpcUrl, 'sepolia');
  const chainId = await client.getChainId();
  const balances = new Map<string, string>();
  const operatorClaimedByService = new Map<number, string>();
  const operatorMintedLast24hByService = new Map<number, string>();

  if (chainId !== expectedChainId) {
    return {
      chainId,
      balances,
      operatorClaimedByService,
      operatorMintedLast24hByService,
      errors: errorsForAllKeys(safeToAddress.keys()),
      claimedErrors: errorsForAllServiceIds(serviceIds),
      claimedLast24hError: TJINN_PUBLIC_READ_ERROR,
    };
  }

  const errors = new Map<string, string>();
  // Single multicall3 round-trip (Sepolia has multicall3). `allowFailure: true`
  // preserves the per-Safe partial-failure handling — a failed entry yields a
  // `{ status: 'failure' }` result rather than rejecting the whole batch.
  const results = await client.multicall({
    allowFailure: true,
    contracts: safeEntries.map(([, safeAddress]) => ({
      address: tokenAddress as `0x${string}`,
      abi: ERC20_BALANCE_OF_ABI,
      functionName: 'balanceOf',
      args: [safeAddress],
    })),
  });

  for (let i = 0; i < results.length; i++) {
    const result = results[i]!;
    const key = safeEntries[i]?.[0];
    if (!key) continue;
    if (result.status === 'success') {
      balances.set(key, (result.result as bigint).toString());
    } else {
      errors.set(key, TJINN_PUBLIC_READ_ERROR);
    }
  }

  const claimedErrors = new Map<number, string>();
  if (distributorAddress && serviceIds.length > 0) {
    const claimedResults = await client.multicall({
      allowFailure: true,
      contracts: serviceIds.map((serviceId) => ({
        address: distributorAddress as `0x${string}`,
        abi: JINN_DISTRIBUTOR_CLAIMED_ABI,
        functionName: 'totalClaimedOperator',
        args: [BigInt(serviceId)],
      })),
    });

    for (let i = 0; i < claimedResults.length; i++) {
      const serviceId = serviceIds[i];
      if (serviceId === undefined) continue;
      const result = claimedResults[i]!;
      if (result.status === 'success') {
        operatorClaimedByService.set(serviceId, (result.result as bigint).toString());
      } else {
        claimedErrors.set(serviceId, TJINN_PUBLIC_READ_ERROR);
      }
    }
  }

  let claimedLast24hError: string | null = null;
  if (distributorAddress && serviceIds.length > 0) {
    try {
      const latest = await client.getBlockNumber();
      const fromBlock =
        latest > SEPOLIA_BLOCKS_PER_24H ? latest - SEPOLIA_BLOCKS_PER_24H : 0n;
      const logs = await client.getLogs({
        address: distributorAddress as `0x${string}`,
        event: JINN_DISTRIBUTOR_CLAIMED_EVENT,
        args: { serviceId: serviceIds.map((id) => BigInt(id)) },
        fromBlock,
        toBlock: latest,
      });
      const sums = new Map<number, bigint>();
      for (const log of logs) {
        const args = log.args as { serviceId?: bigint; operatorMinted?: bigint };
        if (args.serviceId === undefined || args.operatorMinted === undefined) continue;
        const id = Number(args.serviceId);
        sums.set(id, (sums.get(id) ?? 0n) + args.operatorMinted);
      }
      for (const serviceId of serviceIds) {
        operatorMintedLast24hByService.set(
          serviceId,
          (sums.get(serviceId) ?? 0n).toString(),
        );
      }
    } catch {
      claimedLast24hError = TJINN_PUBLIC_READ_ERROR;
    }
  }

  return {
    chainId,
    balances,
    operatorClaimedByService,
    operatorMintedLast24hByService,
    errors,
    claimedErrors,
    claimedLast24hError,
  };
}

async function getCachedTjinnBalances(
  ethereumRpcUrl: string,
  tokenAddress: string,
  distributorAddress: string | undefined,
  expectedChainId: number,
  safeToAddress: Map<string, `0x${string}`>,
  serviceIds: readonly number[],
): Promise<TjinnBalanceSnapshot> {
  const safeKeys = [...safeToAddress.keys()].sort();
  const sortedServiceIds = [...serviceIds].sort((a, b) => a - b);
  const cacheKey = tJinnBalanceCacheKey(
    ethereumRpcUrl,
    distributorAddress,
    safeKeys,
    sortedServiceIds,
  );
  const now = Date.now();
  const cached = tjinnBalanceCache.get(cacheKey);
  if (cached && cached.expiresAt > now) {
    return cached.promise;
  }

  const promise = withTimeout(
    readTjinnBalances(
      ethereumRpcUrl,
      tokenAddress,
      distributorAddress,
      expectedChainId,
      safeToAddress,
      sortedServiceIds,
    ),
    TJINN_BALANCE_TIMEOUT_MS,
    'tJINN balance collection timed out',
  ).catch((): TjinnBalanceSnapshot => {
    return {
      chainId: expectedChainId,
      balances: new Map<string, string>(),
      operatorClaimedByService: new Map<number, string>(),
      operatorMintedLast24hByService: new Map<number, string>(),
      errors: errorsForAllKeys(safeKeys),
      claimedErrors: errorsForAllServiceIds(sortedServiceIds),
      claimedLast24hError: TJINN_PUBLIC_READ_ERROR,
    };
  });
  tjinnBalanceCache.set(cacheKey, {
    expiresAt: now + TJINN_BALANCE_CACHE_TTL_MS,
    promise,
  });
  return promise;
}

async function sumPendingStakingRewards(
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

/**
 * Resolve the public error string for a tJINN status with at least one error.
 *
 * Flattened from a 3-deep nested ternary into guard clauses:
 *  - partial success (some balances read) → PARTIAL
 *  - only invalid-Safe errors             → INVALID_SAFE
 *  - otherwise (RPC read failures)        → READ_ERROR
 *
 * Caller must only invoke this when `hasInvalidSafe || hasReadError` is true.
 */
function tjinnPublicError(opts: {
  hasInvalidSafe: boolean;
  hasReadError: boolean;
  hasAnyBalance: boolean;
}): string {
  if (opts.hasAnyBalance) return TJINN_PUBLIC_PARTIAL_ERROR;
  if (opts.hasInvalidSafe && !opts.hasReadError) return TJINN_PUBLIC_INVALID_SAFE_ERROR;
  return TJINN_PUBLIC_READ_ERROR;
}

async function gatherTjinnStatus(
  ethereumRpcUrl: string | undefined,
  tokenAddress: string,
  distributorAddress: string | undefined,
  chainId: number,
  fleet: FleetState | null,
): Promise<TjinnStatus> {
  if (!fleet) {
    return pendingTjinnStatus(tokenAddress, chainId);
  }

  const services: TjinnServiceStatus[] = [];
  const safeToAddress = new Map<string, `0x${string}`>();
  const serviceIds = new Set<number>();

  for (const svc of fleet.services) {
    const index = displayFleetServiceIndex(svc);
    const serviceId = svc.service_id ?? null;
    if (serviceId !== null) {
      serviceIds.add(serviceId);
    }
    const safeAddress = svc.safe_address;
    if (!safeAddress) {
      services.push({
        index,
        serviceId,
        safeAddress: null,
        balanceWei: null,
        operatorClaimedWei: null,
        state: 'pending',
        error: null,
      });
      continue;
    }
    try {
      const checksum = getAddress(safeAddress);
      const key = checksum.toLowerCase();
      services.push({
        index,
        serviceId,
        safeAddress: checksum,
        balanceWei: null,
        operatorClaimedWei: null,
        state: 'pending',
        error: null,
      });
      safeToAddress.set(key, checksum as `0x${string}`);
    } catch {
      services.push({
        index,
        serviceId,
        safeAddress,
        balanceWei: null,
        operatorClaimedWei: null,
        state: 'error',
        error: TJINN_PUBLIC_INVALID_SAFE_ERROR,
      });
    }
  }

  const safeCount = safeToAddress.size;
  if (safeCount === 0) {
    const invalid = services.find((svc) => svc.state === 'error')?.error;
    return pendingTjinnStatus(tokenAddress, chainId, {
      state: invalid ? 'error' : 'pending',
      safeCount,
      services,
      error: invalid ?? null,
    });
  }

  if (!ethereumRpcUrl) {
    return pendingTjinnStatus(tokenAddress, chainId, { safeCount, services });
  }

  const snapshot = await getCachedTjinnBalances(
    ethereumRpcUrl,
    tokenAddress,
    distributorAddress,
    chainId,
    safeToAddress,
    [...serviceIds],
  );
  let total = 0n;
  for (const balance of snapshot.balances.values()) {
    total += BigInt(balance);
  }
  const allClaimedReadsAvailable =
    !!distributorAddress &&
    serviceIds.size > 0 &&
    snapshot.claimedErrors.size === 0 &&
    [...serviceIds].every((serviceId) => snapshot.operatorClaimedByService.has(serviceId));
  let operatorClaimedWei: string | null = null;
  if (allClaimedReadsAvailable) {
    let claimedTotal = 0n;
    for (const serviceId of serviceIds) {
      claimedTotal += BigInt(snapshot.operatorClaimedByService.get(serviceId) ?? '0');
    }
    operatorClaimedWei = claimedTotal.toString();
  }
  // 24h-window sum: null when the log query errored or there are no services.
  let operatorMintedLast24hWei: string | null = null;
  if (
    !!distributorAddress &&
    serviceIds.size > 0 &&
    snapshot.claimedLast24hError === null
  ) {
    let last24hTotal = 0n;
    for (const serviceId of serviceIds) {
      last24hTotal += BigInt(snapshot.operatorMintedLast24hByService.get(serviceId) ?? '0');
    }
    operatorMintedLast24hWei = last24hTotal.toString();
  }
  const hasInvalidSafe = services.some((svc) => svc.error === TJINN_PUBLIC_INVALID_SAFE_ERROR);
  const hasReadError = snapshot.errors.size > 0;
  const hasAnyError = hasInvalidSafe || hasReadError;
  const hasAnyBalance = snapshot.balances.size > 0;
  const publicError = hasAnyError
    ? tjinnPublicError({ hasInvalidSafe, hasReadError, hasAnyBalance })
    : null;

  return pendingTjinnStatus(tokenAddress, snapshot.chainId, {
    state: hasAnyError ? 'error' : 'ready',
    safeBalanceWei: hasAnyBalance ? total.toString() : null,
    operatorClaimedWei,
    operatorMintedLast24hWei,
    safeCount,
    services: services.map((svc): TjinnServiceStatus => {
      const operatorClaimedForService =
        svc.serviceId !== null
          ? (snapshot.operatorClaimedByService.get(svc.serviceId) ?? null)
          : null;
      if (!svc.safeAddress) return { ...svc, operatorClaimedWei: operatorClaimedForService };
      if (svc.state === 'error') return { ...svc, operatorClaimedWei: operatorClaimedForService };
      const key = svc.safeAddress.toLowerCase();
      const balance = snapshot.balances.get(key);
      if (balance !== undefined) {
        return {
          ...svc,
          state: 'ready',
          balanceWei: balance,
          operatorClaimedWei: operatorClaimedForService,
          error: null,
        };
      }
      return {
        ...svc,
        state: 'error',
        operatorClaimedWei: operatorClaimedForService,
        error: snapshot.errors.get(key) ?? TJINN_PUBLIC_READ_ERROR,
      };
    }),
    error: publicError,
  });
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
  const daily = resolveMasterDailyEstimateWei(
    status?.masterEthDailyEstimateWei,
    status?.pollIntervalMs ?? 5000,
  );

  const tjinnIdentity = resolveTjinnIdentity(status);

  // portfolio.v0 lifecycle data — best-effort, never throws
  let portfolioV0: ReturnType<typeof gatherPortfolioV0Status> | undefined;
  try {
    portfolioV0 = gatherPortfolioV0Status(
      store,
      status?.engine?.workingDirRoot ?? DEFAULT_ENGINE_WORKING_DIR_ROOT,
    );
  } catch {
    portfolioV0 = undefined;
  }

  let taskRuns: ReturnType<typeof gatherTaskRunsStatus> | undefined;
  try {
    taskRuns = gatherTaskRunsStatus(store);
  } catch {
    taskRuns = undefined;
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
    predictionV1 = gatherPredictionV1Status(store, {
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
    tjinnTokenAddress: tjinnIdentity.tokenAddress,
    tjinnChainId: tjinnIdentity.chainId,
    tjinnDistributorAddress: status?.tjinnDistributorAddress,
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

  // Start the Sepolia tJINN read up front so it overlaps the Base-RPC fan-out
  // below for free. `gatherTjinnStatus` is internally error-safe (it catches
  // and returns a snapshot), so the promise never rejects — it is awaited at
  // the point its result is assigned to `raw.tJinn`.
  const tJinnPromise = gatherTjinnStatus(
    status.network === 'testnet' ? status.config?.ethereumRpcUrl : undefined,
    tjinnIdentity.tokenAddress,
    status.tjinnDistributorAddress,
    tjinnIdentity.chainId,
    fleet,
  );

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
  // 'standard' && !!distributorAddress), this one must change too.
  const evictionIntervalMs = status.config?.evictionCheckIntervalMs ?? 0;
  raw.evictionCheckIntervalMs = evictionIntervalMs;
  raw.autoRestakeEnabled =
    evictionIntervalMs > 0 &&
    status.config?.stakingMode === 'standard' &&
    !!status.tjinnDistributorAddress;

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

  if (fleet && raw.rpc.ok) {
    const pr = await sumPendingStakingRewards(status.rpcUrl, status.network, fleet);
    if ('sum' in pr) {
      raw.pendingStakingRewardsWei = pr.sum;
      raw.pendingByService = pr.pendingByService;
      if (pr.nextCheckpointAt) raw.nextCheckpointAt = pr.nextCheckpointAt;
    } else {
      raw.pendingRewardsError = pr.error;
    }

    // Eviction state + inactivity — best-effort; never blocks the rest of status assembly.
    try {
      const evictedByServiceIndex: Record<number, boolean> = {};
      const inactivityByServiceIndex: Record<number, number> = {};
      await Promise.all(
        fleet.services.map(async (svc) => {
          const serviceId = svc.service_id;
          const stakingProxy = svc.staking_address;
          if (!serviceId || !stakingProxy) return;
          const di = displayFleetServiceIndex(svc);
          try {
            const [state, info] = await Promise.all([
              client.readContract({
                address: stakingProxy as `0x${string}`,
                abi: JINN_STAKING_ABI,
                functionName: 'getStakingState',
                args: [BigInt(serviceId)],
              }),
              client.readContract({
                address: stakingProxy as `0x${string}`,
                abi: JINN_STAKING_ABI,
                functionName: 'getServiceInfo',
                args: [BigInt(serviceId)],
              }).catch(() => null),
            ]);
            // getStakingState returns uint8; 2 = Evicted enum value
            evictedByServiceIndex[di] = Number(state) === 2;
            // getServiceInfo returns a struct — inactivity is seconds of accumulated inactivity
            if (info != null) {
              const inactivity = (info as { inactivity: bigint }).inactivity;
              if (typeof inactivity === 'bigint') {
                inactivityByServiceIndex[di] = Number(inactivity);
              }
            }
          } catch {
            // Transient RPC errors: skip silently; evicted defaults to false
          }
        }),
      );
      raw.evictedByServiceIndex = evictedByServiceIndex;
      raw.inactivityByServiceIndex = inactivityByServiceIndex;

      // First-seen tracker for the suppression window (issue #651).
      // Key by `${chain}:${serviceId}` to survive multi-chain fleet layouts.
      const nowMs = Date.now();
      const chainKey = fleet?.chain ?? status.network;
      const evictedSinceByServiceIndex: Record<number, string> = {};
      for (const svc of fleet.services) {
        const di = displayFleetServiceIndex(svc);
        const sid = svc.service_id;
        if (sid == null) continue;
        const key = `${chainKey}:${sid}`;
        if (evictedByServiceIndex[di] === true) {
          let firstSeen = evictionFirstSeenMs.get(key);
          if (firstSeen === undefined) {
            firstSeen = nowMs;
            evictionFirstSeenMs.set(key, firstSeen);
          }
          evictedSinceByServiceIndex[di] = new Date(firstSeen).toISOString();
        } else {
          evictionFirstSeenMs.delete(key);
        }
      }
      raw.evictedSinceByServiceIndex = evictedSinceByServiceIndex;
    } catch {
      // Non-fatal: staking state reads should not prevent status from returning
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

  // The tJINN read started up front (overlapping the Base-RPC fan-out). It is
  // awaited here, as late as possible — after ALL other awaited Base-chain work
  // — so the up-to-4s tJINN timeout never serializes the Base fan-out behind it.
  // `gatherTjinnStatus` is internally error-safe, so a plain await is safe.
  raw.tJinn = await tJinnPromise;

  return raw;
}

export async function gatherStatusForApi(
  store: Store,
  status: StatusGatherConfig | undefined,
): Promise<StatusV1Response> {
  const raw = await gatherGatheredStatusRaw(store, status);
  const body = assembleStatusV1(raw);
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
  return body;
}
