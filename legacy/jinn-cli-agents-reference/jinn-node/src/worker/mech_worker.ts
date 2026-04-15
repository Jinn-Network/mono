import { config, secrets, type WorkerMechFilterMode } from '../config/index.js';
import { existsSync, unlinkSync } from 'fs';
import { Web3 } from 'web3';
import { graphQLRequest } from '../http/client.js';
// Import ABI from mech-client-ts package
import marketplaceAbi from '@jinn-network/mech-client-ts/dist/abis/MechMarketplace.json' with { type: 'json' };
import { workerLogger, flushLogger } from '../logging/index.js';
import { claimRequest as apiClaimRequest, resetControlApiSigner } from './control_api_client.js';
import { deliverViaSafe } from '@jinn-network/mech-client-ts/dist/post_deliver.js';
import { getMechAddress, getServicePrivateKey, getMechChainConfig, getServiceSafeAddress, getMiddlewarePath } from '../env/operate-profile.js';
import { dispatchExistingJob } from '../agent/mcp/tools/dispatch_existing_job.js';
import { getInheritedEnv } from './status/autoDispatch.js';
import { serializeError } from './logging/errors.js';
import { safeParseToolResponse } from './tool_utils.js';
import { processOnce as processJobOnce } from './orchestration/jobRunner.js';
import { marketplaceInteract } from '@jinn-network/mech-client-ts/dist/marketplace_interact.js';
import { shouldStop } from './cycleControl.js';
import { checkAndDispatchScheduledVentures } from './ventures/ventureWatcher.js';
import { acquireSafeLock } from './safeTxMutex.js';
import { checkGeminiQuotaAvailability } from './llm/geminiQuota.js';
import { recordIdleCycle, recordExecutionTime, updateFleetState } from './healthcheck.js';
import { maybeDistributeFunds } from './funding/FundDistributor.js';
import { getMechAddressesForMultipleContracts, parseStakingContracts } from './filters/stakingFilter.js';
import {
  getWorkerCredentialInfo,
  getWorkerOperatorCapabilityInfo,
  isJobEligibleForWorker,
  isJobEligibleForOperatorCapabilities,
  jobRequiresCredentials,
  getRequiredCredentials,
  resolveMissingOperatorCapabilities,
  reprobeWithRequestId,
  resetCredentialInfoCache,
} from './filters/credentialFilter.js';
import { ServiceRotator } from './rotation/ServiceRotator.js';
import { getActiveService, setActiveService } from './rotation/ActiveServiceContext.js';
import { resetCachedAddress as resetSigningProxyAddress, startSigningProxy } from '../agent/signing-proxy.js';
import { maybeCallCheckpoint } from './staking/checkpoint.js';
import { checkEpochGate } from './staking/epochGate.js';
import { maybeSubmitHeartbeat, maybeSubmitHeartbeatForService } from './staking/heartbeat.js';
import { resolveServiceConfig, clearServiceConfigCache, type ResolvedServiceConfig } from './onchain/serviceResolver.js';
import { checkAndRestakeServices } from './staking/restake.js';
import { ensureOperatorRegistered } from './register-operator.js';

export { formatSummaryForPr, autoCommitIfNeeded } from './git/autoCommit.js';

type UnclaimedRequest = {
  id: string;           // on-chain requestId (decimal string or 0x)
  mech: string;         // mech address (0x...) — the priority mech assigned to this request
  requester: string;    // requester address (0x...)
  workstreamId?: string; // workstream context for dependency resolution
  blockTimestamp?: number;
  dependencies?: string[];  // job definition IDs or names that must be delivered first
  ipfsHash?: string;
  delivered?: boolean;
  responseTimeout?: number; // absolute unix timestamp (seconds) after which any mech can deliver
  enabledTools?: string[];  // MCP tools required by this job (from Ponder)
  jobName?: string;         // job name from Ponder (e.g. '__heartbeat__')
};

type JobDefinitionStatus = {
  exists: boolean;
  lastStatus?: string;
  lastInteraction?: number;
  name?: string;
};


const PONDER_GRAPHQL_URL = config.services.ponderUrl;
const CONTROL_API_URL = config.services.controlApiUrl;
const SINGLE_SHOT = process.argv.includes('--single') || process.argv.includes('--single-job');
const USE_CONTROL_API = config.services.useControlApi;

function isHeartbeatLeaderWorker(): boolean {
  const workerId = process.env.WORKER_ID || '';
  return !workerId || workerId.endsWith('-1') || workerId === 'default';
}

// Track jobs executed in this session to prevent re-execution on delivery failure
// This prevents infinite loops when delivery fails but Control API allows re-claiming
// Uses Map<id, timestamp> instead of Set for TTL-based eviction
const executedJobsThisSession = new Map<string, number>();
let consecutiveStuckCycles = 0;
let lastStuckRequestIds: string[] = [];

// Earning window job tracking
let earningWindowJobCount = 0;
let earningWindowId: string | null = null;

// Parse --runs=<N> flag for controlled execution cycles
const MAX_RUNS = (() => {
  if (SINGLE_SHOT) return 1; // --single is equivalent to --runs=1
  const arg = process.argv.find(arg => arg.startsWith('--runs='));
  if (!arg) return undefined; // Infinite loop (default behavior)
  const value = parseInt(arg.split('=')[1], 10);
  return isNaN(value) || value < 1 ? undefined : value;
})();

// Parse --max-cycles=<N> flag for cyclic workstreams
const MAX_CYCLES = (() => {
  const arg = process.argv.find(arg => arg.startsWith('--max-cycles='));
  if (!arg) return undefined;
  const value = parseInt(arg.split('=')[1], 10);
  return isNaN(value) || value < 1 ? undefined : value;
})();

if (MAX_CYCLES !== undefined) {
  process.env.WORKER_MAX_CYCLES = String(MAX_CYCLES);
}

// Parse --stuck-exit-cycles=<N> flag or WORKER_STUCK_EXIT_CYCLES for watchdog exit
const MAX_STUCK_CYCLES = (() => {
  const arg = process.argv.find(arg => arg.startsWith('--stuck-exit-cycles='));
  const envValue = config.worker.stuckExitCycles > 0 ? String(config.worker.stuckExitCycles) : undefined;
  const raw = arg ? arg.split('=')[1] : envValue;
  if (!raw) return undefined;
  const value = parseInt(raw, 10);
  return isNaN(value) || value < 1 ? undefined : value;
})();

// Adaptive polling configuration for CPU optimization
// When idle, polling interval increases exponentially up to max to reduce CPU usage
const WORKER_POLL_BASE_MS = config.worker.pollBaseMs;
const WORKER_POLL_MAX_MS = config.worker.pollMaxMs;
const WORKER_POLL_BACKOFF_FACTOR = config.worker.pollBackoffFactor;

// Earning schedule: "HH:MM-HH:MM" in local timezone (e.g., "22:00-08:00")
// When set, worker only claims jobs during this window.
// Supports overnight windows (start > end wraps past midnight).
// Unset = always earning (current behavior).
const EARNING_SCHEDULE = config.filtering.earningSchedule || null;

// Max jobs per earning window. Unset = unlimited (current behavior).
const EARNING_MAX_JOBS = config.filtering.earningMaxJobs > 0 ? config.filtering.earningMaxJobs : undefined;

// Workstream filtering: parse --workstream=<id> flag or WORKSTREAM_FILTER env var
// Supports multiple workstreams via:
//   - Comma-separated: "0x123,0x456,0x789"
//   - JSON array: '["0x123","0x456"]'
//   - Single value: "0x123"
const WORKSTREAM_FILTERS: string[] = (() => {
  // CLI flag overrides config
  const arg = process.argv.find(arg => arg.startsWith('--workstream='));
  if (arg) {
    const raw = arg.split('=')[1];
    if (!raw || raw === 'none') return [];
    if (raw.startsWith('[')) {
      try {
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed)) return parsed.map(s => String(s).trim()).filter(Boolean);
      } catch { /* fall through */ }
    }
    return raw.split(',').map(s => s.trim()).filter(Boolean);
  }
  // From config (already an array)
  return config.filtering.workstreams;
})();

// Legacy single-value alias for backward compatibility in logging
const WORKSTREAM_FILTER = WORKSTREAM_FILTERS.length === 1 ? WORKSTREAM_FILTERS[0] : undefined;

// Template IDs for x402 gateway job pickup (legacy; dynamic validation uses Supabase)
const VENTURE_TEMPLATE_IDS: string[] = config.filtering.ventureTemplateIds;

// Venture filtering: when set, only claim requests belonging to these venture IDs.
// Requests with ventureId=null are excluded when this filter is active.
const VENTURE_FILTERS: string[] = config.filtering.ventures;

// Always set WORKER_STOP_FILE so external stop signals can terminate the worker
if (!process.env.WORKER_STOP_FILE) {
  const stopFileSuffix = WORKSTREAM_FILTERS.length > 0
    ? (WORKSTREAM_FILTERS.length === 1
      ? WORKSTREAM_FILTERS[0]
      : `multi-${WORKSTREAM_FILTERS.length}`)
    : `pid-${process.pid}`;
  process.env.WORKER_STOP_FILE = `/tmp/jinn-stop-cycle-${stopFileSuffix}`;
}

// Clear any stale stop file from previous runs so fresh starts aren't blocked
// The stop file can be created by requestStop() or external operators
if (process.env.WORKER_STOP_FILE && existsSync(process.env.WORKER_STOP_FILE)) {
  try {
    unlinkSync(process.env.WORKER_STOP_FILE);
    workerLogger.info({ stopFile: process.env.WORKER_STOP_FILE }, 'Cleared stale stop file from previous run');
  } catch {
    // Ignore errors - file might have been deleted between check and unlink
  }
}

// On-chain resolved service config (populated at startup)
let resolvedConfig: ResolvedServiceConfig | null = null;

/**
 * Resolve the currently active service config.
 * In multi-service mode this follows ActiveServiceContext (rotated service mech),
 * then falls back to startup-resolved config for single-service mode.
 */
async function getRuntimeResolvedConfig(): Promise<ResolvedServiceConfig | null> {
  const active = getActiveService();
  if (active?.mechAddress) {
    try {
      return await resolveServiceConfig(active.mechAddress, secrets.rpcUrl);
    } catch (e: any) {
      workerLogger.warn(
        { error: serializeError(e), activeMech: active.mechAddress, serviceId: active.serviceId },
        'Failed to resolve active service config from on-chain state'
      );
    }
  }

  return resolvedConfig;
}

// Auto-reposting configuration
const ENABLE_AUTO_REPOST = config.worker.enableAutoRepost;
const MIN_TIME_BETWEEN_REPOSTS = 5 * 60 * 1000; // 5 minutes

// Track recent reposts to prevent loops
const recentReposts = new Map<string, number>();

/**
 * Parse "HH:MM-HH:MM" schedule and check if current time is inside the window.
 * Handles overnight windows (e.g., "22:00-08:00").
 */
function checkEarningWindow(schedule: string): { inWindow: boolean; msUntilWindow: number } {
  const match = schedule.match(/^(\d{1,2}):(\d{2})-(\d{1,2}):(\d{2})$/);
  if (!match) {
    workerLogger.warn({ schedule }, 'Invalid EARNING_SCHEDULE format, expected HH:MM-HH:MM');
    return { inWindow: true, msUntilWindow: 0 }; // fail open
  }

  const [, sh, sm, eh, em] = match;
  const startMinutes = parseInt(sh) * 60 + parseInt(sm);
  const endMinutes = parseInt(eh) * 60 + parseInt(em);

  const now = new Date();
  const nowMinutes = now.getHours() * 60 + now.getMinutes();

  let inWindow: boolean;
  if (startMinutes <= endMinutes) {
    // Same-day window (e.g., "09:00-17:00")
    inWindow = nowMinutes >= startMinutes && nowMinutes < endMinutes;
  } else {
    // Overnight window (e.g., "22:00-08:00")
    inWindow = nowMinutes >= startMinutes || nowMinutes < endMinutes;
  }

  if (inWindow) return { inWindow: true, msUntilWindow: 0 };

  // Calculate ms until window opens
  let minutesUntil = startMinutes - nowMinutes;
  if (minutesUntil <= 0) minutesUntil += 24 * 60;

  return { inWindow: false, msUntilWindow: minutesUntil * 60 * 1000 };
}

/**
 * Get a stable ID for the current earning window (for resetting the job counter).
 * Format: "YYYY-MM-DD-HH:MM" using the window's start time.
 */
function getCurrentWindowId(schedule: string): string {
  const match = schedule.match(/^(\d{1,2}):(\d{2})-/);
  if (!match) return 'unknown';
  const startHour = parseInt(match[1]);
  const startMin = parseInt(match[2]);
  const now = new Date();
  const nowMinutes = now.getHours() * 60 + now.getMinutes();
  const startMinutes = startHour * 60 + startMin;

  // If we're well before the start time (>12h away), the window started yesterday
  const windowDate = new Date(now);
  if (startMinutes > nowMinutes + 12 * 60) {
    windowDate.setDate(windowDate.getDate() - 1);
  }
  return `${windowDate.toISOString().slice(0, 10)}-${String(startHour).padStart(2, '0')}:${String(startMin).padStart(2, '0')}`;
}

const DEFAULT_BASE_BRANCH = config.git.defaultBaseBranch;

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DEPENDENCY_STALE_MS = config.dependencies.staleMs;
const DEPENDENCY_REDISPATCH_COOLDOWN_MS = config.dependencies.redispatchCooldownMs;
const DEPENDENCY_MISSING_FAIL_MS = config.dependencies.missingFailMs;
const DEPENDENCY_CANCEL_COOLDOWN_MS = config.dependencies.cancelCooldownMs;
const ENABLE_DEPENDENCY_REDISPATCH = config.dependencies.redispatch;
const ENABLE_DEPENDENCY_AUTOFAIL = config.dependencies.autofail;

const dependencyRedispatchAttempts = new Map<string, number>();
const dependencyCancelAttempts = new Map<string, number>();

// Staking checkpoint: check every N cycles if epoch is overdue and call checkpoint()
// maybeCallCheckpoint() is a single cheap RPC read that short-circuits if not overdue,
// so there's no benefit to gating it behind many cycles. Default to every cycle.
const WORKER_CHECKPOINT_CYCLES = parseInt(process.env.WORKER_CHECKPOINT_CYCLES || '1');

// Staking heartbeat: submit marketplace requests to meet liveness requirement.
// At 30s base poll, 5 cycles = ~2.5 min. Submits 1 request per check if deficit exists.
const WORKER_HEARTBEAT_CYCLES = config.worker.heartbeatCycles;

// Venture watcher: check dispatch schedules every N cycles (~ every 2-3 min at default polling)
const ENABLE_VENTURE_WATCHER = config.worker.enableVentureWatcher;
const WORKER_VENTURE_WATCHER_CYCLES = config.worker.ventureWatcherCycles;

// Fund distribution: check service Safe/agent EOA balances and top up from Master Safe.
// At 30s base poll, 120 cycles = ~60 min. Only active when WORKER_MULTI_SERVICE=true.
const WORKER_FUND_CHECK_CYCLES = config.worker.fundCheckCycles;

// Periodic cleanup of global maps to prevent unbounded growth over weeks of uptime
const MAP_CLEANUP_INTERVAL_CYCLES = 50;
const EXECUTED_JOBS_MAX_AGE_MS = 24 * 60 * 60 * 1000; // 24 hours
const REPOST_MAX_AGE_MS = 60 * 60 * 1000; // 1 hour
const DEPENDENCY_MAP_MAX_AGE_MS = 4 * 60 * 60 * 1000; // 4 hours

function cleanupGlobalMaps(): void {
  const now = Date.now();
  let cleaned = 0;

  for (const [id, ts] of executedJobsThisSession) {
    if (now - ts > EXECUTED_JOBS_MAX_AGE_MS) { executedJobsThisSession.delete(id); cleaned++; }
  }
  for (const [id, ts] of recentReposts) {
    if (now - ts > REPOST_MAX_AGE_MS) { recentReposts.delete(id); cleaned++; }
  }
  for (const [key, ts] of dependencyRedispatchAttempts) {
    if (now - ts > DEPENDENCY_MAP_MAX_AGE_MS) { dependencyRedispatchAttempts.delete(key); cleaned++; }
  }
  for (const [key, ts] of dependencyCancelAttempts) {
    if (now - ts > DEPENDENCY_MAP_MAX_AGE_MS) { dependencyCancelAttempts.delete(key); cleaned++; }
  }

  if (cleaned > 0) {
    workerLogger.debug({
      cleaned, sizes: {
        executedJobs: executedJobsThisSession.size,
        reposts: recentReposts.size,
        redispatch: dependencyRedispatchAttempts.size,
        cancel: dependencyCancelAttempts.size,
      }
    }, 'Cleaned up stale global map entries');
  }
}

// Job processing logic has been moved to worker/orchestration/jobRunner.ts
// This file now serves as a CLI wrapper that handles request discovery, claiming, and orchestration delegation

// Mech filter configuration
type MechFilterMode = WorkerMechFilterMode;
interface MechFilterConfig {
  mode: MechFilterMode;
  addresses: string[]; // lowercase, only used for 'list', 'single', and 'staking' modes
  stakingContract?: string; // only set for 'staking' mode
}

// Legacy staking pool where heartbeat delivery should be skipped.
const HEARTBEAT_SKIP_STAKING_CONTRACTS = new Set<string>([
  '0x0dfafbf570e9e813507aae18aa08dfba0abc5139',
]);

function shouldSkipHeartbeatForStakingContract(stakingContract: string | null | undefined): boolean {
  if (!stakingContract) return false;
  return HEARTBEAT_SKIP_STAKING_CONTRACTS.has(stakingContract.toLowerCase());
}

function getActiveStakingContractForService(runtimeResolvedConfig: ResolvedServiceConfig | null): string | null {
  if (runtimeResolvedConfig?.stakingContract) {
    return runtimeResolvedConfig.stakingContract;
  }
  const configuredContracts = parseStakingContracts(config.staking.contract || '');
  return configuredContracts[0] || null;
}

// Cache for staking filter addresses (async initialization)
let cachedStakingAddresses: string[] | null = null;
let stakingAddressesFetchedAt: number = 0;

/**
 * Get mech filter configuration.
 * Priority order:
 * 1. WORKER_MECH_FILTER_MODE='staking' with WORKER_STAKING_CONTRACT
 * 2. WORKER_MECH_FILTER_MODE='list' or legacy WORKER_MECH_FILTER_LIST
 * 3. WORKER_MECH_FILTER_MODE='any'
 * 4. WORKER_MECH_FILTER_MODE='single' or fallback to getMechAddress()
 */
async function getMechFilterConfig(): Promise<MechFilterConfig> {
  const explicitMode = config.worker.mechFilterMode;
  // Fall through to runtime-resolved staking contract (same pattern as epoch gate)
  const runtimeResolved = await getRuntimeResolvedConfig();
  const stakingContractRaw = config.staking.contract || runtimeResolved?.stakingContract || undefined;
  const filterList = config.filtering.mechFilterList || undefined;

  // Deprecation warning for legacy WORKER_MECH_FILTER_LIST
  if (filterList && !explicitMode) {
    workerLogger.warn({
      envVar: 'WORKER_MECH_FILTER_LIST',
      recommendation: "Use WORKER_MECH_FILTER_MODE='staking' with WORKER_STAKING_CONTRACT instead"
    }, 'WORKER_MECH_FILTER_LIST is deprecated - consider migrating to staking-based filtering');
  }

  // Mode 1: Staking-based filtering (new recommended approach)
  // Supports comma-separated contracts: WORKER_STAKING_CONTRACT=0xAAA,0xBBB
  if (explicitMode === 'staking' || (stakingContractRaw && !explicitMode)) {
    if (!stakingContractRaw) {
      workerLogger.error('WORKER_MECH_FILTER_MODE=staking requires WORKER_STAKING_CONTRACT');
      return { mode: 'single', addresses: [] };
    }

    // Parse comma-separated staking contracts
    const contracts = parseStakingContracts(stakingContractRaw);

    // Fetch mech addresses from all staking contracts in parallel
    const addresses = await getMechAddressesForMultipleContracts(contracts);

    if (addresses.length === 0) {
      workerLogger.warn({
        stakingContracts: contracts,
        note: 'No mechs found staked in any contract - will not match any requests'
      }, 'Staking filter returned no addresses');
    }

    return {
      mode: 'staking',
      addresses,
      stakingContract: contracts[0],
    };
  }

  // Mode 2: Explicit "any" mode
  if (explicitMode === 'any' || filterList?.toLowerCase() === 'any') {
    return { mode: 'any', addresses: [] };
  }

  // Mode 3: List mode (from WORKER_MECH_FILTER_LIST or explicit mode)
  if (explicitMode === 'list' || (filterList && filterList.toLowerCase() !== 'any')) {
    const addresses = (filterList || '').split(',').map(a => a.trim().toLowerCase()).filter(Boolean);
    if (addresses.length > 0) {
      return { mode: 'list', addresses };
    }
  }

  // Mode 4: Fallback to single mech from getMechAddress()
  const single = getMechAddress();
  if (single) {
    return { mode: 'single', addresses: [single.toLowerCase()] };
  }

  return { mode: 'single', addresses: [] };
}

function isUuid(value: string): boolean {
  return UUID_REGEX.test(value);
}

function isTerminalStatus(status?: string): boolean {
  return status === 'COMPLETED' || status === 'FAILED';
}

async function getJobDefinitionStatus(jobDefinitionId: string): Promise<JobDefinitionStatus> {
  try {
    const query = `query CheckJobDefStatus($jobDefId: String!) {
      jobDefinitions(where: { id: $jobDefId }) {
        items {
          id
          name
          lastStatus
          lastInteraction
        }
      }
    }`;

    const data = await graphQLRequest<{
      jobDefinitions: { items: Array<{ id: string; name?: string; lastStatus?: string; lastInteraction?: string }> };
    }>({
      url: PONDER_GRAPHQL_URL,
      query,
      variables: { jobDefId: jobDefinitionId },
      context: { operation: 'getJobDefinitionStatus', jobDefinitionId },
    });

    const jobDef = data?.jobDefinitions?.items?.[0];
    if (!jobDef) {
      return { exists: false };
    }

    return {
      exists: true,
      name: jobDef.name,
      lastStatus: jobDef.lastStatus,
      lastInteraction: jobDef.lastInteraction ? Number(jobDef.lastInteraction) : undefined,
    };
  } catch (e: any) {
    workerLogger.warn({
      jobDefinitionId,
      error: serializeError(e),
    }, 'Failed to fetch job definition status');
    return { exists: false };
  }
}

function shouldThrottle(map: Map<string, number>, key: string, cooldownMs: number): boolean {
  const last = map.get(key);
  if (!last) return false;
  return Date.now() - last < cooldownMs;
}

async function maybeRedispatchDependency(params: {
  request: UnclaimedRequest;
  dependencyId: string;
  status: JobDefinitionStatus;
}): Promise<void> {
  if (!ENABLE_DEPENDENCY_REDISPATCH) return;
  if (!params.request.workstreamId) return;
  if (!params.status.lastStatus) return;

  const lastInteractionMs = params.status.lastInteraction ? params.status.lastInteraction * 1000 : undefined;
  if (!lastInteractionMs) return;
  if (Date.now() - lastInteractionMs < DEPENDENCY_STALE_MS) return;

  const redispatchable = new Set(['DELEGATING', 'WAITING', 'PENDING']);
  if (!redispatchable.has(params.status.lastStatus)) return;

  const key = `${params.request.workstreamId}:${params.dependencyId}`;
  if (shouldThrottle(dependencyRedispatchAttempts, key, DEPENDENCY_REDISPATCH_COOLDOWN_MS)) return;

  try {
    dependencyRedispatchAttempts.set(key, Date.now());
    workerLogger.warn({
      requestId: params.request.id,
      dependencyId: params.dependencyId,
      lastStatus: params.status.lastStatus,
      lastInteraction: params.status.lastInteraction,
    }, 'Dependency appears stale; re-dispatching dependency job definition');

    await dispatchExistingJob({
      jobId: params.dependencyId,
      workstreamId: params.request.workstreamId,
      message: `Auto-redispatch: dependency stale (${params.status.lastStatus}) with no activity for ${Math.round((Date.now() - lastInteractionMs) / 60000)}m`,
      // Include inherited env vars for workstream-level config propagation
      additionalContext: { env: getInheritedEnv() }
    });
  } catch (e: any) {
    workerLogger.warn({
      requestId: params.request.id,
      dependencyId: params.dependencyId,
      error: serializeError(e),
    }, 'Failed to re-dispatch stale dependency');
  }
}

async function maybeCancelMissingDependency(params: {
  request: UnclaimedRequest;
  dependencyId: string;
}): Promise<void> {
  if (!ENABLE_DEPENDENCY_AUTOFAIL) return;
  if (!params.request.blockTimestamp) return;

  const requestAgeMs = Date.now() - params.request.blockTimestamp * 1000;
  if (requestAgeMs < DEPENDENCY_MISSING_FAIL_MS) return;

  const key = `${params.request.id}:${params.dependencyId}`;
  if (shouldThrottle(dependencyCancelAttempts, key, DEPENDENCY_CANCEL_COOLDOWN_MS)) return;
  dependencyCancelAttempts.set(key, Date.now());

  const mechAddress = getMechAddress();
  const safeAddress = getServiceSafeAddress();
  const privateKey = getServicePrivateKey();
  const rpcHttpUrl = secrets.rpcUrl;
  const chainConfig = getMechChainConfig();

  if (!mechAddress || !safeAddress || !privateKey) {
    workerLogger.warn({
      requestId: params.request.id,
      dependencyId: params.dependencyId,
    }, 'Cannot auto-cancel missing dependency: missing service credentials');
    return;
  }

  try {
    const resultContent = {
      requestId: params.request.id,
      output: `Job cancelled: missing dependency job definition ${params.dependencyId}`,
      telemetry: {},
      artifacts: [],
      cancelled: true,
    };

    const releaseCancelLock = await acquireSafeLock(safeAddress);
    let delivery;
    try {
      delivery = await (deliverViaSafe as any)({
        chainConfig,
        requestId: params.request.id,
        resultContent,
        targetMechAddress: mechAddress,
        safeAddress,
        privateKey,
        rpcHttpUrl,
        wait: true,
      });
    } finally {
      releaseCancelLock();
    }

    workerLogger.warn({
      requestId: params.request.id,
      dependencyId: params.dependencyId,
      txHash: delivery?.tx_hash,
    }, 'Auto-cancelled request due to missing dependency');
  } catch (e: any) {
    workerLogger.warn({
      requestId: params.request.id,
      dependencyId: params.dependencyId,
      error: serializeError(e),
    }, 'Failed to auto-cancel request for missing dependency');
  }
}

async function fetchRecentRequests(limit: number = 10): Promise<UnclaimedRequest[]> {
  try {
    const mechFilter = await getMechFilterConfig();

    if (mechFilter.mode !== 'any' && mechFilter.addresses.length === 0) {
      workerLogger.warn({
        mode: mechFilter.mode,
        stakingContract: mechFilter.stakingContract
      }, 'Cannot fetch requests without mech address, WORKER_MECH_FILTER_LIST, or staked mechs');
      return [];
    }

    workerLogger.info({
      ponderUrl: PONDER_GRAPHQL_URL,
      mechFilterMode: mechFilter.mode,
      mechFilterAddresses: mechFilter.mode === 'any' ? 'any' : mechFilter.addresses,
      stakingContract: mechFilter.stakingContract,
      workstreamFilter: WORKSTREAM_FILTERS.length > 0 ? WORKSTREAM_FILTERS : 'none',
      ventureFilter: VENTURE_FILTERS.length > 0 ? VENTURE_FILTERS : 'none'
    }, 'Fetching requests from Ponder');

    // Build where conditions based on filter mode
    // 'staking' mode uses the same query structure as 'list' mode
    const whereConditions: string[] = ['delivered: false'];
    if (mechFilter.mode === 'list' || mechFilter.mode === 'staking') {
      whereConditions.push('mech_in: $mechs');
    } else if (mechFilter.mode === 'single') {
      whereConditions.push('mech: $mech');
    }
    // 'any' mode: no mech filter

    // Workstream filtering: single vs multiple
    if (WORKSTREAM_FILTERS.length === 1) {
      whereConditions.push('workstreamId: $workstreamId');
    } else if (WORKSTREAM_FILTERS.length > 1) {
      whereConditions.push('workstreamId_in: $workstreamIds');
    }

    // Venture filtering: only claim requests belonging to allowed ventures
    if (VENTURE_FILTERS.length === 1) {
      whereConditions.push('ventureId: $ventureId');
    } else if (VENTURE_FILTERS.length > 1) {
      whereConditions.push('ventureId_in: $ventureIds');
    }
    const whereClause = `{ ${whereConditions.join(', ')} }`;

    // Build query variables definition
    const varDefs: string[] = ['$limit: Int!'];
    if (mechFilter.mode === 'list' || mechFilter.mode === 'staking') {
      varDefs.push('$mechs: [String!]!');
    } else if (mechFilter.mode === 'single') {
      varDefs.push('$mech: String!');
    }
    if (WORKSTREAM_FILTERS.length === 1) {
      varDefs.push('$workstreamId: String!');
    } else if (WORKSTREAM_FILTERS.length > 1) {
      varDefs.push('$workstreamIds: [String!]!');
    }
    if (VENTURE_FILTERS.length === 1) {
      varDefs.push('$ventureId: String!');
    } else if (VENTURE_FILTERS.length > 1) {
      varDefs.push('$ventureIds: [String!]!');
    }

    // Query our local Ponder GraphQL (custom schema) - FILTER BY MECH AND UNDELIVERED (and optionally WORKSTREAM)
    // Sort desc so newest requests appear first — prevents old undelivered requests from filling the pagination limit
    const query = `query RecentRequests(${varDefs.join(', ')}) {
  requests(
    where: ${whereClause}
    orderBy: "blockTimestamp"
    orderDirection: "desc"
    limit: $limit
  ) {
    items {
      id
      mech
      sender
      workstreamId
      ventureId
      ipfsHash
      blockTimestamp
      delivered
      dependencies
      enabledTools
      jobName
    }
  }
}`;

    const variables: any = { limit };
    if (mechFilter.mode === 'list' || mechFilter.mode === 'staking') {
      variables.mechs = mechFilter.addresses;
    } else if (mechFilter.mode === 'single') {
      variables.mech = mechFilter.addresses[0];
    }
    if (WORKSTREAM_FILTERS.length === 1) {
      variables.workstreamId = WORKSTREAM_FILTERS[0];
    } else if (WORKSTREAM_FILTERS.length > 1) {
      variables.workstreamIds = WORKSTREAM_FILTERS;
    }
    if (VENTURE_FILTERS.length === 1) {
      variables.ventureId = VENTURE_FILTERS[0];
    } else if (VENTURE_FILTERS.length > 1) {
      variables.ventureIds = VENTURE_FILTERS;
    }

    const data = await graphQLRequest<{ requests: { items: any[] } }>({
      url: PONDER_GRAPHQL_URL,
      query,
      variables,
      context: { operation: 'fetchRecentRequests', mechFilterMode: mechFilter.mode }
    });
    const items: any[] = data?.requests?.items || [];
    workerLogger.info({ totalItems: items.length, items: items.map(r => ({ id: r.id, delivered: r.delivered, dependencies: r.dependencies })) }, 'Ponder GraphQL response (workstream query)');

    // Query 2: Template-based jobs from x402 gateway
    // Runs when Supabase is configured (dynamic validation) OR VENTURE_TEMPLATE_IDS is set (legacy).
    // These jobs have jobName containing "(via x402)" and may not match any workstream filter.
    // Template ownership is validated later in jobRunner via Supabase query.
    let templateItems: any[] = [];
    const ENABLE_TEMPLATE_PICKUP = !!(secrets.supabaseUrl || VENTURE_TEMPLATE_IDS.length > 0);
    if (ENABLE_TEMPLATE_PICKUP) {
      try {
        const templateWhereConditions: string[] = ['delivered: false', 'jobName_contains: "(via x402)"'];
        if (mechFilter.mode === 'list' || mechFilter.mode === 'staking') {
          templateWhereConditions.push('mech_in: $mechs');
        } else if (mechFilter.mode === 'single') {
          templateWhereConditions.push('mech: $mech');
        }
        if (VENTURE_FILTERS.length === 1) {
          templateWhereConditions.push('ventureId: $ventureId');
        } else if (VENTURE_FILTERS.length > 1) {
          templateWhereConditions.push('ventureId_in: $ventureIds');
        }
        const templateWhereClause = `{ ${templateWhereConditions.join(', ')} }`;

        const templateVarDefs: string[] = ['$tLimit: Int!'];
        if (mechFilter.mode === 'list' || mechFilter.mode === 'staking') {
          templateVarDefs.push('$mechs: [String!]!');
        } else if (mechFilter.mode === 'single') {
          templateVarDefs.push('$mech: String!');
        }
        if (VENTURE_FILTERS.length === 1) {
          templateVarDefs.push('$ventureId: String!');
        } else if (VENTURE_FILTERS.length > 1) {
          templateVarDefs.push('$ventureIds: [String!]!');
        }

        const templateQuery = `query TemplateRequests(${templateVarDefs.join(', ')}) {
  requests(
    where: ${templateWhereClause}
    orderBy: "blockTimestamp"
    orderDirection: "desc"
    limit: $tLimit
  ) {
    items {
      id
      mech
      sender
      workstreamId
      ventureId
      ipfsHash
      blockTimestamp
      delivered
      dependencies
    }
  }
}`;

        const templateVars: any = { tLimit: limit };
        if (mechFilter.mode === 'list' || mechFilter.mode === 'staking') {
          templateVars.mechs = mechFilter.addresses;
        } else if (mechFilter.mode === 'single') {
          templateVars.mech = mechFilter.addresses[0];
        }
        if (VENTURE_FILTERS.length === 1) {
          templateVars.ventureId = VENTURE_FILTERS[0];
        } else if (VENTURE_FILTERS.length > 1) {
          templateVars.ventureIds = VENTURE_FILTERS;
        }

        const templateData = await graphQLRequest<{ requests: { items: any[] } }>({
          url: PONDER_GRAPHQL_URL,
          query: templateQuery,
          variables: templateVars,
          context: { operation: 'fetchTemplateRequests', mechFilterMode: mechFilter.mode }
        });
        templateItems = templateData?.requests?.items || [];
        if (templateItems.length > 0) {
          workerLogger.info({ count: templateItems.length }, 'Template-based requests found (via x402)');
        }
      } catch (e) {
        workerLogger.warn({ error: serializeError(e) }, 'Template request query failed; continuing with workstream results only');
      }
    }

    // Merge and deduplicate results from both queries
    const seenIds = new Set<string>();
    const allItems: any[] = [];

    for (const r of items) {
      const id = String(r.id);
      if (!seenIds.has(id)) {
        seenIds.add(id);
        allItems.push(r);
      }
    }
    for (const r of templateItems) {
      const id = String(r.id);
      if (!seenIds.has(id)) {
        seenIds.add(id);
        allItems.push(r);
      }
    }

    workerLogger.info({
      workstreamResults: items.length,
      templateResults: templateItems.length,
      mergedTotal: allItems.length,
    }, 'Merged request results');

    return allItems.map((r: any) => ({
      id: String(r.id),
      mech: String(r.mech),
      requester: String(r.sender || ''),
      workstreamId: r?.workstreamId ? String(r.workstreamId) : undefined,
      ipfsHash: r?.ipfsHash ? String(r.ipfsHash) : undefined,
      blockTimestamp: Number(r.blockTimestamp),
      delivered: Boolean(r?.delivered === true),
      dependencies: Array.isArray(r?.dependencies) ? r.dependencies.map((dep: any) => String(dep)) : undefined,
      enabledTools: Array.isArray(r?.enabledTools) ? r.enabledTools : undefined,
      jobName: r?.jobName ? String(r.jobName) : undefined,
      ventureId: r?.ventureId ? String(r.ventureId) : undefined,
    })) as UnclaimedRequest[];
  } catch (e) {
    workerLogger.warn({ error: serializeError(e) }, 'Ponder GraphQL not reachable; returning empty set');
    return [];
  }
}

// Cached Web3/contract instances — avoids re-creation on every poll cycle
let cachedWeb3: InstanceType<typeof Web3> | null = null;
let cachedWeb3RpcUrl: string | null = null;
let cachedMarketplaceContract: any = null;
const MARKETPLACE_ADDRESS = '0xf24eE42edA0fc9b33B7D41B06Ee8ccD2Ef7C5020';
// Multicall3 is deployed at the same address on all EVM chains
const MULTICALL3_ADDRESS = '0xcA11bde05977b3631167028862bE2a173976CA11';
const MULTICALL3_ABI = [
  {
    inputs: [{ components: [{ name: 'target', type: 'address' }, { name: 'callData', type: 'bytes' }], name: 'calls', type: 'tuple[]' }],
    name: 'aggregate',
    outputs: [{ name: 'blockNumber', type: 'uint256' }, { name: 'returnData', type: 'bytes[]' }],
    stateMutability: 'view',
    type: 'function',
  },
] as const;
// Max calls per multicall batch — stay well within gas limits
const MULTICALL_BATCH_SIZE = 100;

function getWeb3Singleton(rpcUrl: string): InstanceType<typeof Web3> {
  if (cachedWeb3 && cachedWeb3RpcUrl === rpcUrl) return cachedWeb3;
  cachedWeb3 = new Web3(rpcUrl);
  cachedWeb3RpcUrl = rpcUrl;
  cachedMarketplaceContract = null; // Invalidate contract on new provider
  return cachedWeb3;
}

function getMarketplaceContract(web3: InstanceType<typeof Web3>): any {
  if (cachedMarketplaceContract) return cachedMarketplaceContract;
  cachedMarketplaceContract = new (web3 as any).eth.Contract(marketplaceAbi, MARKETPLACE_ADDRESS);
  return cachedMarketplaceContract;
}

async function filterUnclaimed(requests: UnclaimedRequest[]): Promise<UnclaimedRequest[]> {
  if (requests.length === 0) return [];
  // Filter out already delivered requests first (from indexer)
  const notDelivered = requests.filter(r => !r.delivered);
  if (notDelivered.length === 0) return [];
  // Validate against marketplace delivery status to avoid stale indexer data
  try {
    const rpcHttpUrl = secrets.rpcUrl;
    if (!rpcHttpUrl) {
      workerLogger.debug('RPC URL missing; falling back to Ponder status');
      return notDelivered;
    }

    const web3 = getWeb3Singleton(rpcHttpUrl);
    const marketplace = getMarketplaceContract(web3);
    const multicall = new (web3 as any).eth.Contract(MULTICALL3_ABI, MULTICALL3_ADDRESS);

    // Encode all mapRequestIdInfos calls
    const calls = notDelivered.map(request => ({
      target: MARKETPLACE_ADDRESS,
      callData: marketplace.methods.mapRequestIdInfos(String(request.id)).encodeABI(),
    }));

    // mapRequestIdInfos return type: (address, address, address, uint256, uint256, bytes32)
    const RETURN_TYPES = ['address', 'address', 'address', 'uint256', 'uint256', 'bytes32'];
    const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';
    const filtered: UnclaimedRequest[] = [];

    // Process in chunks to avoid gas limit issues
    for (let i = 0; i < calls.length; i += MULTICALL_BATCH_SIZE) {
      const chunk = calls.slice(i, i + MULTICALL_BATCH_SIZE);
      const chunkRequests = notDelivered.slice(i, i + MULTICALL_BATCH_SIZE);

      try {
        const { returnData } = await multicall.methods.aggregate(chunk).call();

        for (let j = 0; j < chunkRequests.length; j++) {
          try {
            const decoded = web3.eth.abi.decodeParameters(RETURN_TYPES, returnData[j]) as any;
            const deliveryMech = decoded[1]; // second output is deliveryMech
            const responseTimeout = decoded[3]; // fourth output is responseTimeout
            const isDelivered = deliveryMech !== ZERO_ADDRESS;

            if (!isDelivered) {
              const timeoutValue = Number(responseTimeout);
              if (Number.isFinite(timeoutValue)) {
                chunkRequests[j].responseTimeout = timeoutValue;
              }
              filtered.push(chunkRequests[j]);
            } else {
              workerLogger.debug({
                requestId: String(chunkRequests[j].id),
                deliveredByMech: deliveryMech,
              }, 'Request already delivered in marketplace by another mech - filtering out');
            }
          } catch (decodeErr) {
            workerLogger.warn({ requestId: String(chunkRequests[j].id), error: serializeError(decodeErr) }, 'Failed to decode marketplace status; keeping request');
            filtered.push(chunkRequests[j]);
          }
        }
      } catch (batchErr) {
        // If multicall fails for a chunk, keep all requests in that chunk
        workerLogger.warn({ error: serializeError(batchErr), chunkSize: chunk.length, offset: i }, 'Multicall batch failed; keeping all requests in chunk');
        filtered.push(...chunkRequests);
      }
    }

    workerLogger.info({ total: notDelivered.length, kept: filtered.length, rpcCalls: Math.ceil(calls.length / MULTICALL_BATCH_SIZE) }, 'Marketplace status check via multicall');
    return filtered;
  } catch (e) {
    workerLogger.warn({ error: serializeError(e) }, 'Error checking marketplace status, falling back to Ponder status');
    return notDelivered;
  }
}

type DeliverabilityCheckReason =
  | 'claimable'
  | 'priority_window_active'
  | 'unknown_response_timeout';

function isClaimableByOwnMechNow(
  request: UnclaimedRequest,
  ownMech: string,
  nowSec: number,
): { claimable: boolean; reason: DeliverabilityCheckReason; secondsRemaining?: number } {
  // Priority mech can always deliver.
  if (request.mech.toLowerCase() === ownMech.toLowerCase()) {
    return { claimable: true, reason: 'claimable' };
  }

  // If timeout is unknown, fail closed to avoid claiming work we likely can't deliver.
  if (typeof request.responseTimeout !== 'number' || !Number.isFinite(request.responseTimeout)) {
    return { claimable: false, reason: 'unknown_response_timeout' };
  }

  // After timeout, any mech can deliver.
  if (nowSec > request.responseTimeout) {
    return { claimable: true, reason: 'claimable' };
  }

  return {
    claimable: false,
    reason: 'priority_window_active',
    secondsRemaining: Math.max(0, request.responseTimeout - nowSec),
  };
}

/**
 * Resolve a dependency identifier to a job definition ID.
 * If the identifier is already a UUID, return it as-is.
 * If the identifier is a job name, try to resolve it within the workstream context.
 */
async function resolveJobDefinitionId(
  workstreamId: string | undefined,
  identifier: string
): Promise<string> {
  // Check if identifier is already a UUID
  const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  if (UUID_REGEX.test(identifier)) {
    return identifier;
  }

  // If no workstream context, can't resolve - return original
  if (!workstreamId) {
    workerLogger.debug({ identifier }, 'Cannot resolve dependency without workstream context');
    return identifier;
  }

  try {
    // Try to resolve by querying for requests with this job name in the workstream
    const query = `query ResolveJobDef($workstreamId: String!, $jobName: String!) {
      requests(
        where: { workstreamId: $workstreamId, jobName: $jobName }
        orderBy: "blockTimestamp"
        orderDirection: "desc"
        limit: 1
      ) {
        items {
          jobDefinitionId
        }
      }
    }`;

    const data = await graphQLRequest<{
      requests: { items: Array<{ jobDefinitionId?: string }> };
    }>({
      url: PONDER_GRAPHQL_URL,
      query,
      variables: { workstreamId, jobName: identifier },
      context: { operation: 'resolveJobDefinitionId', identifier, workstreamId }
    });

    const requests = data?.requests?.items || [];
    if (requests.length > 0 && requests[0].jobDefinitionId) {
      const resolvedId = requests[0].jobDefinitionId;
      workerLogger.debug({
        identifier,
        resolvedId,
        workstreamId
      }, 'Resolved job name to definition ID');
      return resolvedId;
    }

    // Not found - return original identifier
    workerLogger.debug({
      identifier,
      workstreamId
    }, 'Could not resolve job name - no matching requests found');
    return identifier;
  } catch (e: any) {
    workerLogger.warn({
      identifier,
      workstreamId,
      error: serializeError(e)
    }, 'Failed to resolve dependency identifier');
    return identifier;
  }
}

/**
 * Check if a job definition has at least one successfully delivered request.
 * This does NOT check child jobs - dependencies are shallow by design.
 * 
 * Rationale: Jobs only deliver when their agent decides they're complete.
 * If children are critical, the parent waits for them before delivering.
 * Dependencies just need to know "did this job finish?" (delivered = yes).
 */
export async function isJobDefinitionComplete(jobDefinitionId: string): Promise<boolean> {
  try {
    const status = await getJobDefinitionStatus(jobDefinitionId);
    if (!status.exists) {
      workerLogger.debug({ jobDefinitionId }, 'Job definition not found');
      return false;
    }

    // Job definition is complete only if lastStatus is terminal (COMPLETED/FAILED)
    // DELEGATING and WAITING mean work is still in progress
    const isComplete = isTerminalStatus(status.lastStatus);

    workerLogger.debug({
      jobDefinitionId,
      lastStatus: status.lastStatus,
      isComplete
    }, 'Job definition completion check (status-based)');

    return isComplete;
  } catch (e: any) {
    workerLogger.warn({
      jobDefinitionId,
      error: serializeError(e)
    }, 'Failed to check job definition completion - assuming not complete');
    return false;
  }
}

/**
 * Check if all job definition dependencies for a request are complete
 */
async function checkDependenciesMet(request: UnclaimedRequest): Promise<boolean> {
  // If no dependencies, job can proceed
  if (!request.dependencies || request.dependencies.length === 0) {
    return true;
  }

  try {
    // Resolve each dependency (name to ID if needed) and check completion
    const results = await Promise.all(
      request.dependencies.map(async (identifier) => {
        const resolvedId = await resolveJobDefinitionId(request.workstreamId, identifier);

        if (!isUuid(resolvedId)) {
          workerLogger.warn({
            requestId: request.id,
            identifier,
            resolvedId,
          }, 'Dependency identifier is not a UUID; cannot validate');
          return { identifier, resolvedId, isComplete: false, status: { exists: false } as JobDefinitionStatus };
        }

        const status = await getJobDefinitionStatus(resolvedId);
        const isComplete = status.exists && isTerminalStatus(status.lastStatus);

        if (!isComplete) {
          if (!status.exists) {
            await maybeCancelMissingDependency({ request, dependencyId: resolvedId });
          } else {
            await maybeRedispatchDependency({ request, dependencyId: resolvedId, status });
          }
        }

        return { identifier, resolvedId, isComplete, status };
      })
    );

    const allComplete = results.every(r => r.isComplete);

    if (!allComplete) {
      const incomplete = results.filter(r => !r.isComplete);
      workerLogger.info({
        requestId: request.id,
        totalDeps: request.dependencies.length,
        incompleteDeps: incomplete.map(r => ({
          identifier: r.identifier,
          resolvedId: r.resolvedId,
          wasResolved: r.identifier !== r.resolvedId,  // Shows if name→UUID resolution happened
          lastStatus: r.status?.lastStatus || (isUuid(r.resolvedId) ? 'UNKNOWN' : 'UNRESOLVED'),
          lastInteraction: r.status?.lastInteraction
        })),
      }, 'Dependencies not met - waiting for job definitions to complete');
    }

    return allComplete;
  } catch (e: any) {
    workerLogger.warn({
      requestId: request.id,
      error: serializeError(e)
    }, 'Failed to check dependencies - assuming not met');
    return false;
  }
}

/**
 * Filter requests to only include those with met dependencies
 */
async function filterByDependencies(requests: UnclaimedRequest[]): Promise<UnclaimedRequest[]> {
  const results = await Promise.all(
    requests.map(async (request) => ({
      request,
      canProceed: await checkDependenciesMet(request)
    }))
  );

  return results.filter(r => r.canProceed).map(r => r.request);
}

async function tryClaim(request: UnclaimedRequest): Promise<boolean> {
  const resolvedWorkstreamId = request.workstreamId || request.id;

  // Skip jobs already executed this session (prevents re-execution loop on delivery failure)
  if (executedJobsThisSession.has(request.id)) {
    workerLogger.info({
      requestId: request.id,
      workstreamId: resolvedWorkstreamId
    }, 'Already executed this session - skipping to prevent re-execution loop');
    return false;
  }

  try {
    // Control API is the only path for claiming
    try {
      const res = await apiClaimRequest(request.id);
      // Skip if already claimed by another worker or stuck IN_PROGRESS
      if (res?.alreadyClaimed) {
        workerLogger.info({
          requestId: request.id,
          status: res.status,
          workstreamId: resolvedWorkstreamId
        }, 'Already claimed - skipping');
        return false;
      }
      if (res && (res.status === 'IN_PROGRESS' || res.status === 'COMPLETED')) {
        const ok = res.status === 'IN_PROGRESS';
        workerLogger.info({
          requestId: request.id,
          status: res.status,
          workstreamId: resolvedWorkstreamId
        }, ok ? 'Claimed via Control API' : 'Already handled via Control API');
        return ok;
      }
      workerLogger.info({
        requestId: request.id,
        status: res?.status,
        workstreamId: resolvedWorkstreamId
      }, 'Unexpected claim response');
      return false;
    } catch (e: any) {
      workerLogger.info({
        requestId: request.id,
        reason: serializeError(e),
        workstreamId: resolvedWorkstreamId
      }, 'Control API claim failed');
      return false;
    }
  } catch (e: any) {
    workerLogger.warn({
      requestId: request.id,
      error: serializeError(e),
      workstreamId: resolvedWorkstreamId
    }, 'Claim error');
    return false;
  }
}


/**
 * Get branch information for a job definition by querying its codeMetadata
 * 
 * This queries the jobDefinition table directly for codeMetadata.branch.name, which is the same
 * data source used when passing child branch info to parents (via completedChildRuns).
 * This unifies how branch info is retrieved across the system.
 * 
 * @param jobDefinitionId - The job definition ID to get branch info for
 * @returns Branch name and base branch if found, null otherwise
 */
export async function getDependencyBranchInfo(jobDefinitionId: string): Promise<{
  branchName?: string;
  baseBranch?: string;
} | null> {
  try {
    // Query the job definition directly for codeMetadata
    // This is the same data source used for child → parent branch info
    const query = `query GetDependencyBranch($jobDefId: String!) {
      jobDefinition(id: $jobDefId) {
        id
        codeMetadata
      }
    }`;

    const data = await graphQLRequest<{
      jobDefinition: { id: string; codeMetadata?: any } | null;
    }>({
      url: PONDER_GRAPHQL_URL,
      query,
      variables: { jobDefId: jobDefinitionId },
      context: { operation: 'getDependencyBranchInfo', jobDefinitionId }
    });

    const jobDef = data?.jobDefinition;
    if (!jobDef) {
      workerLogger.debug({ jobDefinitionId }, 'No job definition found for dependency');
      return null;
    }

    // Extract branch info from codeMetadata
    const codeMetadata = jobDef.codeMetadata;
    if (!codeMetadata) {
      workerLogger.debug({ jobDefinitionId }, 'No codeMetadata on dependency job definition');
      return null;
    }

    // codeMetadata.branch.name contains the branch name
    // codeMetadata.baseBranch contains the base branch
    const branchName = codeMetadata.branch?.name;
    const baseBranch = codeMetadata.baseBranch || DEFAULT_BASE_BRANCH;

    if (branchName) {
      workerLogger.debug({
        jobDefinitionId,
        branchName,
        baseBranch
      }, 'Found branch info from dependency job definition codeMetadata');

      return { branchName, baseBranch };
    }

    workerLogger.debug({ jobDefinitionId }, 'No branch name in dependency codeMetadata');
    return null;
  } catch (e: any) {
    workerLogger.warn({
      jobDefinitionId,
      error: serializeError(e)
    }, 'Failed to get dependency branch info');
    return null;
  }
}



/**
 * Check if a job chain is complete by verifying all requests are delivered
 */
async function isChainComplete(rootJobDefinitionId: string): Promise<boolean> {
  try {
    const data = await graphQLRequest<{ requests: { items: Array<{ id: string; delivered: boolean }> } }>({
      url: PONDER_GRAPHQL_URL,
      query: `query($rootId: String!) {
        requests(where: { sourceJobDefinitionId: $rootId }) {
          items {
            id
            delivered
          }
        }
      }`,
      variables: { rootId: rootJobDefinitionId },
      context: { operation: 'isChainComplete', rootJobDefinitionId }
    });
    const requests = data?.requests?.items || [];

    if (requests.length === 0) {
      return false; // No requests in chain
    }

    // Check if all requests are delivered
    return requests.every((req: any) => req.delivered);
  } catch (e) {
    workerLogger.error({ error: e, rootJobDefinitionId }, `Error checking chain completion for ${rootJobDefinitionId}`);
    return false;
  }
}

/**
 * Check if a job should be reposted based on recent repost history
 */
function shouldRepost(rootJobDefinitionId: string): boolean {
  const now = Date.now();
  const lastRepost = recentReposts.get(rootJobDefinitionId);

  if (lastRepost && (now - lastRepost) < MIN_TIME_BETWEEN_REPOSTS) {
    return false;
  }

  return true;
}

/**
 * Repost an existing job definition using the dispatch_existing_job pattern
 */
async function repostExistingJob(jobDefinitionId: string): Promise<void> {
  try {
    // Query for the most recent request of this job to establish lineage
    const queryData = await graphQLRequest<{ requests: { items: Array<{ id: string }> } }>({
      url: PONDER_GRAPHQL_URL,
      query: `query {
        requests(
          where: { jobDefinitionId: "${jobDefinitionId}" },
          orderBy: "blockTimestamp",
          orderDirection: "desc",
          limit: 1
        ) {
          items { id }
        }
      }`,
      context: { operation: 'repostExistingJob', jobDefinitionId }
    });
    const mostRecentRequest = queryData?.requests?.items?.[0];

    // Build message indicating this is a repost after completion
    const message = mostRecentRequest ? JSON.stringify({
      content: "Reposting job after workstream completion",
      from: mostRecentRequest.id,
      to: jobDefinitionId
    }) : undefined;

    const result = await dispatchExistingJob({
      jobId: jobDefinitionId,
      message,
      // Include inherited env vars for workstream-level config propagation
      additionalContext: { env: getInheritedEnv() }
    });

    // Parse the result to check if it was successful
    const { ok, data, message: errMsg } = safeParseToolResponse(result);
    if (!ok) {
      workerLogger.error(`Cannot repost job ${jobDefinitionId}: ${errMsg || 'Unknown error'}`);
      return;
    }

    // Track the repost to prevent loops
    recentReposts.set(jobDefinitionId, Date.now());

    workerLogger.info(`Successfully reposted job (${jobDefinitionId}) after chain completion`);
    workerLogger.info({ data }, 'Repost result');

  } catch (e) {
    workerLogger.error({ error: e, jobDefinitionId }, `Error reposting job ${jobDefinitionId}`);
  }
}

/**
 * Check for completed decomposition chains and repost root jobs if needed
 */
async function checkAndRepostCompletedChains(): Promise<void> {
  if (!ENABLE_AUTO_REPOST) {
    return;
  }

  try {
    // Find all root job definitions (no sourceJobDefinitionId)
    const data = await graphQLRequest<{ jobDefinitions: { items: Array<{ id: string; name: string }> } }>({
      url: PONDER_GRAPHQL_URL,
      query: `query {
        jobDefinitions(where: { sourceJobDefinitionId: { equals: null } }, limit: 100) {
          items {
            id
            name
          }
        }
      }`,
      context: { operation: 'checkAndRepostCompletedChains' }
    });
    const rootJobDefs = data?.jobDefinitions?.items || [];

    for (const rootJobDef of rootJobDefs) {
      // Skip if recently reposted
      if (!shouldRepost(rootJobDef.id)) {
        continue;
      }

      // Check if chain is complete and repost if needed
      if (await isChainComplete(rootJobDef.id)) {
        workerLogger.info(`Found completed chain for root job ${rootJobDef.name}, reposting...`);
        await repostExistingJob(rootJobDef.id);
      }
    }
  } catch (e) {
    workerLogger.error({ error: e }, 'Error checking for completed chains');
  }
}


async function fetchSpecificRequest(requestId: string): Promise<UnclaimedRequest | null> {
  try {
    const query = `query GetRequest($id: String!) {
  requests(where: { id: $id }) {
    items {
      id
      mech
      sender
      ipfsHash
      blockTimestamp
      delivered
      dependencies
      enabledTools
      jobName
    }
  }
}`;
    const data = await graphQLRequest<{ requests: { items: any[] } }>({
      url: PONDER_GRAPHQL_URL,
      query,
      variables: { id: requestId },
      context: { operation: 'fetchSpecificRequest', requestId }
    });
    const items = data?.requests?.items || [];
    if (items.length === 0) return null;
    const r = items[0];
    return {
      id: String(r.id),
      mech: String(r.mech),
      requester: String(r.sender || ''),
      ipfsHash: r?.ipfsHash ? String(r.ipfsHash) : undefined,
      blockTimestamp: Number(r.blockTimestamp),
      delivered: Boolean(r?.delivered === true),
      dependencies: Array.isArray(r?.dependencies) ? r.dependencies.map((dep: any) => String(dep)) : undefined,
      enabledTools: Array.isArray(r?.enabledTools) ? r.enabledTools : undefined,
      jobName: r?.jobName ? String(r.jobName) : undefined
    };
  } catch (e: any) {
    workerLogger.warn({ error: serializeError(e) }, 'Error fetching specific request');
    return null;
  }
}


/**
 * Process one iteration of the worker loop.
 * @returns true if a job was processed, false if idle (no work found or claimed)
 */
async function processOnce(): Promise<boolean> {
  // This mech address is for request targeting/routing.
  // Claim ownership in Control API is derived from the signed service EOA.
  const workerAddress = getMechAddress();
  if (!workerAddress) {
    workerLogger.error('Missing service mech address in .operate config or environment');
    return false;
  }

  // Optional: target a specific request id if provided (for deterministic tests).
  // A targeted recovery run should bypass epoch pickup gating.
  const targetIdEnv = (config.filtering.targetRequestId || '').trim();

  // Staking target gate: stop claiming if request target met for this epoch
  // Use resolved config (on-chain derived) with env var override
  const runtimeResolvedConfig = await getRuntimeResolvedConfig();
  const stakingContract = getActiveStakingContractForService(runtimeResolvedConfig);
  if (!targetIdEnv && stakingContract && runtimeResolvedConfig) {
    const gate = await checkEpochGate(stakingContract, runtimeResolvedConfig.serviceId, runtimeResolvedConfig.marketplace);
    if (gate.targetMet) {
      const resetIn = Math.max(0, gate.nextCheckpoint - Math.floor(Date.now() / 1000));
      workerLogger.info({
        activities: gate.activityCount,
        target: gate.target,
        resetsInSeconds: resetIn,
      }, `Staking target met (${gate.activityCount}/${gate.target}) — skipping job pickup`);
      return false;
    }
  } else if (targetIdEnv) {
    workerLogger.info({ target: targetIdEnv }, 'Bypassing staking target gate for targeted request');
  }

  let candidates: UnclaimedRequest[];

  if (targetIdEnv) {
    const targetHex = targetIdEnv.startsWith('0x') ? targetIdEnv.toLowerCase() : ('0x' + BigInt(targetIdEnv).toString(16)).toLowerCase();
    const specificRequest = await fetchSpecificRequest(targetHex);
    if (!specificRequest) {
      consecutiveStuckCycles = 0;
      lastStuckRequestIds = [];
      workerLogger.info({ target: targetHex }, 'Target request not found in Ponder');
      return false;
    }
    if (specificRequest.delivered) {
      consecutiveStuckCycles = 0;
      lastStuckRequestIds = [];
      workerLogger.info({ target: targetHex }, 'Target request already delivered');
      return false;
    }

    // Check dependencies even for targeted requests
    const depsMet = await checkDependenciesMet(specificRequest);
    if (!depsMet) {
      consecutiveStuckCycles = 0;
      lastStuckRequestIds = [];
      workerLogger.info({ target: targetHex }, 'Target request dependencies not met - skipping');
      return false;
    }

    candidates = [specificRequest];
    workerLogger.info({ target: targetHex }, 'Targeting specific request');

    // Always apply operator capability filtering (e.g. github token capability).
    const operatorInfo = await getWorkerOperatorCapabilityInfo();
    const missing = resolveMissingOperatorCapabilities(
      specificRequest.enabledTools,
      operatorInfo.capabilities,
    );
    if (missing.length > 0) {
      consecutiveStuckCycles = 0;
      lastStuckRequestIds = [];
      workerLogger.info(
        { target: targetHex, missingOperatorCapabilities: missing },
        'Target request is not eligible for this worker operator capabilities',
      );
      return false;
    }
  } else {
    const recent = await fetchRecentRequests(50);
    candidates = await filterUnclaimed(recent);
    if (candidates.length === 0) {
      consecutiveStuckCycles = 0;
      lastStuckRequestIds = [];
      workerLogger.info('No unclaimed on-chain requests found');
      return false;
    }

    // Filter by dependencies - only process jobs whose dependencies are met
    candidates = await filterByDependencies(candidates);
    if (candidates.length === 0) {
      consecutiveStuckCycles = 0;
      lastStuckRequestIds = [];
      workerLogger.info('No requests with met dependencies found');
      return false;
    }

    // Filter by operator-local capability (e.g. validated github token)
    const operatorInfo = await getWorkerOperatorCapabilityInfo();
    const ineligibleByOperator = candidates.filter(
      c => !isJobEligibleForOperatorCapabilities(c.enabledTools, operatorInfo.capabilities),
    );
    if (ineligibleByOperator.length > 0) {
      const missingCapabilities = new Set<string>();
      for (const candidate of ineligibleByOperator) {
        const missing = resolveMissingOperatorCapabilities(
          candidate.enabledTools,
          operatorInfo.capabilities,
        );
        for (const capability of missing) {
          missingCapabilities.add(capability);
        }
      }
      workerLogger.info(
        {
          skippedRequestCount: ineligibleByOperator.length,
          requestIds: ineligibleByOperator.map(c => c.id),
          missingOperatorCapabilities: [...missingCapabilities],
        },
        'Skipping requests requiring unavailable operator capabilities',
      );
    }

    candidates = candidates.filter(c =>
      isJobEligibleForOperatorCapabilities(c.enabledTools, operatorInfo.capabilities),
    );
    if (candidates.length === 0) {
      consecutiveStuckCycles = 0;
      lastStuckRequestIds = [];
      workerLogger.info('No eligible requests after operator capability filter');
      return false;
    }

    // Filter by credential capability (discovered via bridge probe at startup).
    // Always filter — even when bridge is down (providers empty), so credential-requiring
    // jobs are never claimed by workers that can't execute them.
    const credInfo = await getWorkerCredentialInfo();
    const ineligibleByCred = candidates.filter(
      c => !isJobEligibleForWorker(c.enabledTools, credInfo.providers),
    );
    if (ineligibleByCred.length > 0) {
      workerLogger.info(
        {
          skippedRequestCount: ineligibleByCred.length,
          requestIds: ineligibleByCred.map(c => c.id),
          workerProviders: [...credInfo.providers],
        },
        'Skipping requests requiring unavailable credentials',
      );
    }

    candidates = candidates.filter(c => isJobEligibleForWorker(c.enabledTools, credInfo.providers));
    if (candidates.length === 0) {
      consecutiveStuckCycles = 0;
      lastStuckRequestIds = [];
      workerLogger.info('No eligible requests after credential filter');
      return false;
    }
    // Trusted operators: process credential jobs first, leaving non-credential jobs for public pool
    if (credInfo.isTrusted) {
      candidates.sort((a, b) => {
        const aPriority = jobRequiresCredentials(a.enabledTools) ? 0 : 1;
        const bPriority = jobRequiresCredentials(b.enabledTools) ? 0 : 1;
        return aPriority - bPriority;
      });
    }
  }

  // Heartbeat coordination: only leader worker should claim heartbeat jobs.
  // Non-leaders skip them before claim to avoid nonce collisions on delivery.
  if (!isHeartbeatLeaderWorker()) {
    const nonHeartbeat = candidates.filter(c => c.jobName !== '__heartbeat__');
    if (nonHeartbeat.length !== candidates.length) {
      workerLogger.info({
        skippedHeartbeats: candidates.length - nonHeartbeat.length,
      }, 'Skipping heartbeat requests on non-leader worker');
    }
    candidates = nonHeartbeat;
  }

  if (shouldSkipHeartbeatForStakingContract(stakingContract)) {
    const nonHeartbeat = candidates.filter(c => c.jobName !== '__heartbeat__');
    if (nonHeartbeat.length !== candidates.length) {
      workerLogger.info({
        stakingContract,
        skippedHeartbeats: candidates.length - nonHeartbeat.length,
      }, 'Skipping heartbeat requests on legacy staking contract');
    }
    candidates = nonHeartbeat;
  }

  if (candidates.length === 0) {
    consecutiveStuckCycles = 0;
    lastStuckRequestIds = [];
    workerLogger.info('No eligible requests after heartbeat-leader filter');
    return false;
  }

  // Deliverability guard: skip requests that our mech cannot deliver yet.
  // This avoids claiming requests that will result in no-op marketplace deliveries.
  if (!targetIdEnv) {
    const nowSec = Math.floor(Date.now() / 1000);
    const nonClaimableInPriorityWindow: string[] = [];
    const nonClaimableUnknownTimeout: string[] = [];
    const deliverableCandidates = candidates.filter(request => {
      const verdict = isClaimableByOwnMechNow(request, workerAddress, nowSec);
      if (verdict.claimable) return true;

      if (verdict.reason === 'priority_window_active') {
        nonClaimableInPriorityWindow.push(request.id);
      } else {
        nonClaimableUnknownTimeout.push(request.id);
      }
      return false;
    });

    if (deliverableCandidates.length !== candidates.length) {
      workerLogger.info({
        claimableNow: deliverableCandidates.length,
        skippedPriorityWindow: nonClaimableInPriorityWindow.length,
        skippedUnknownTimeout: nonClaimableUnknownTimeout.length,
        skippedPriorityWindowRequestIds: nonClaimableInPriorityWindow.slice(0, 10),
        skippedUnknownTimeoutRequestIds: nonClaimableUnknownTimeout.slice(0, 10),
      }, 'Skipping requests we cannot deliver yet');
    }

    candidates = deliverableCandidates;
    if (candidates.length === 0) {
      consecutiveStuckCycles = 0;
      lastStuckRequestIds = [];
      workerLogger.info('No eligible requests after deliverability guard');
      return false;
    }
  }

  const eligibleCandidates = candidates.filter(c => !executedJobsThisSession.has(c.id));
  if (eligibleCandidates.length === 0) {
    consecutiveStuckCycles += 1;
    lastStuckRequestIds = candidates.map(c => c.id);
    workerLogger.warn({
      consecutiveStuckCycles,
      maxStuckCycles: MAX_STUCK_CYCLES,
      requestIds: lastStuckRequestIds
    }, 'All candidates already executed this session - stuck cycle');

    if (MAX_STUCK_CYCLES !== undefined && consecutiveStuckCycles >= MAX_STUCK_CYCLES) {
      workerLogger.error({
        consecutiveStuckCycles,
        requestIds: lastStuckRequestIds
      }, 'Stuck cycle limit reached; exiting to allow restart');
      process.exit(2);
    }
    return false;
  }

  consecutiveStuckCycles = 0;
  lastStuckRequestIds = [];

  // Try to claim a request — verify venture credentials BEFORE claiming.
  // There's no unclaim API, so we must confirm eligibility before taking ownership.
  let target: UnclaimedRequest | null = null;
  let quotaAvailableNow: boolean | null = null;
  for (const c of candidates) {
    if (executedJobsThisSession.has(c.id)) continue;

    // For credential-requiring jobs, verify venture-scoped credentials before claiming.
    // The startup probe discovers global credentials; the per-job reprobe resolves
    // venture-scoped credentials (requestId → workstream → venture → credentials).
    if (jobRequiresCredentials(c.enabledTools)) {
      const required = getRequiredCredentials(c.enabledTools ?? []);
      try {
        const jobCredInfo = await reprobeWithRequestId(c.id);
        if (!isJobEligibleForWorker(c.enabledTools, jobCredInfo.providers)) {
          workerLogger.info(
            { requestId: c.id, required, available: [...jobCredInfo.providers] },
            'Skipping — venture lacks required credentials',
          );
          continue;
        }

      } catch (err) {
        workerLogger.warn(
          { requestId: c.id, error: err instanceof Error ? err.message : String(err) },
          'Cannot verify venture credentials — skipping credential-requiring job',
        );
        continue;
      }
    }

    if (c.jobName !== '__heartbeat__') {
      if (quotaAvailableNow === null) {
        const quotaResult = await checkGeminiQuotaAvailability({
          reason: 'pre_claim',
          requestId: c.id,
          jobName: c.jobName,
        });
        quotaAvailableNow = quotaResult.available;

        if (!quotaAvailableNow) {
          const retryAfterSeconds = quotaResult.retryAfterMs && quotaResult.retryAfterMs > 0
            ? Math.ceil(quotaResult.retryAfterMs / 1000)
            : null;
          workerLogger.warn({
            requestId: c.id,
            retryAfterSeconds,
            detail: quotaResult.detail,
          }, 'Gemini quota unavailable before claim — skipping agent jobs this cycle');
        }
      }

      if (!quotaAvailableNow) {
        continue;
      }
    }

    const ok = await tryClaim(c);
    if (ok) {
      target = c;
      break;
    }
  }

  if (!target) return false;

  // Check if this is a heartbeat request — deliver immediately without agent execution
  // Uses jobName from Ponder index (reliable) instead of IPFS metadata fetch (can fail)
  if (target.jobName === '__heartbeat__') {
    if (shouldSkipHeartbeatForStakingContract(stakingContract)) {
      workerLogger.info(
        { requestId: target.id, stakingContract },
        'Skipping claimed heartbeat request on legacy staking contract'
      );
      executedJobsThisSession.set(target.id, Date.now());
      return false;
    }

    workerLogger.info({ requestId: target.id }, 'Heartbeat request — auto-delivering');
    const mechAddress = getMechAddress();
    const safeAddress = getServiceSafeAddress();
    const privateKey = getServicePrivateKey();
    const rpcHttpUrl = secrets.rpcUrl;
    const chainConfig = getMechChainConfig();

    if (mechAddress && safeAddress && privateKey) {
      const releaseHbLock = await acquireSafeLock(safeAddress);
      try {
        await (deliverViaSafe as any)({
          chainConfig,
          requestId: target.id,
          resultContent: { heartbeat: true, ts: Date.now() },
          targetMechAddress: mechAddress,
          safeAddress,
          privateKey,
          rpcHttpUrl,
          wait: true,
        });
        workerLogger.info({ requestId: target.id }, 'Heartbeat delivered');
      } catch (deliveryErr: any) {
        workerLogger.warn({ requestId: target.id, error: deliveryErr.message }, 'Heartbeat delivery failed');
      } finally {
        releaseHbLock();
      }
    }
    executedJobsThisSession.set(target.id, Date.now());
    return true;
  }

  // Pre-execution guard: skip non-own-mech requests still within priority window.
  // After responseTimeout, any mech can deliver — but during the window, only the
  // priority mech can, so executing would waste LLM credits.
  const ownMech = workerAddress;
  if (target.mech.toLowerCase() !== ownMech.toLowerCase()) {
    const now = Math.floor(Date.now() / 1000);
    if (target.responseTimeout && now <= target.responseTimeout) {
      workerLogger.info({
        requestId: target.id,
        targetMech: target.mech,
        ownMech,
        responseTimeout: target.responseTimeout,
        secondsRemaining: target.responseTimeout - now,
      }, 'Skipping non-own-mech request still within priority window — would waste LLM credits');
      return false;
    }
    workerLogger.info({
      requestId: target.id,
      targetMech: target.mech,
      ownMech,
      responseTimeout: target.responseTimeout,
    }, 'Non-own-mech request past priority window — will execute and deliver via own mech');
  }

  // Delegate job execution to orchestrator
  try {
    await processJobOnce(target, workerAddress);
  } finally {
    // Mark as executed even if delivery fails to prevent re-execution loop
    executedJobsThisSession.set(target.id, Date.now());
    workerLogger.debug({ requestId: target.id }, 'Marked job as executed this session');
  }

  // Post-job delay to spread API usage over time (helps with quota limits)
  const jobDelayMs = config.worker.jobDelayMs;
  if (jobDelayMs > 0) {
    workerLogger.info({ delayMs: jobDelayMs }, 'Post-job delay before next cycle');
    await new Promise(r => setTimeout(r, jobDelayMs));
  }

  return true; // Job was processed
}

/**
 * Health check for Control API at startup
 */
async function checkControlApiHealth(): Promise<void> {
  if (!USE_CONTROL_API) {
    return; // Control API disabled, skip check
  }

  try {
    // Use the REST /health endpoint which bypasses ERC-8128 auth
    const healthUrl = CONTROL_API_URL!.replace(/\/graphql\/?$/, '/health');
    const res = await fetch(healthUrl, { method: 'GET', signal: AbortSignal.timeout(10_000) });
    if (!res.ok) {
      throw new Error(`HTTP ${res.status}: ${res.statusText}`);
    }
    const body = await res.json() as any;
    if (body?.status !== 'ok') {
      throw new Error(`Unhealthy response: ${JSON.stringify(body)}`);
    }
    workerLogger.info({ controlApiUrl: CONTROL_API_URL, nodeId: body.nodeId }, 'Control API health check passed');
  } catch (e: any) {
    workerLogger.error({
      error: serializeError(e),
      controlApiUrl: CONTROL_API_URL
    }, 'Control API is not running - worker cannot start');
    throw new Error('Control API health check failed: ' + serializeError(e) + '\n\nPlease start Control API with: yarn control:dev');
  }
}

// Repost check frequency limiting configuration
const WORKER_REPOST_CHECK_CYCLES = config.worker.repostCheckCycles;

async function main() {
  workerLogger.info('Mech worker starting');

  // Start worker-level signing proxy — available for all dispatch paths
  // (parent dispatch, loop/timeout recovery, dependency redispatch, repost, etc.)
  // The proxy runs on 127.0.0.1 with a random port and bearer token.
  let signingProxy = await startSigningProxy();
  process.env.AGENT_SIGNING_PROXY_URL = signingProxy.url;
  process.env.AGENT_SIGNING_PROXY_TOKEN = signingProxy.secret;
  workerLogger.info({ url: signingProxy.url }, 'Worker-level signing proxy started');

  // Resolve on-chain service config from mech address
  // This derives serviceId, safe, marketplace, and staking contract from chain state
  const mechAddress = getMechAddress();
  const rpcUrl = secrets.rpcUrl;
  if (mechAddress && rpcUrl) {
    try {
      resolvedConfig = await resolveServiceConfig(mechAddress, rpcUrl);
      workerLogger.info({ resolved: resolvedConfig }, 'On-chain service config resolved');
    } catch (e: any) {
      workerLogger.warn({ error: serializeError(e) }, 'On-chain service resolution failed — falling back to env vars');
    }
  }

  // Auto-restake evicted services before proceeding
  // Routes through middleware's Safe tx path (same as `yarn wallet:restake`)
  let pendingRestakeAt: number | null = null;

  if (config.worker.autoRestake) {
    const password = secrets.operatePassword;
    if (password && rpcUrl) {
      try {
        const results = await checkAndRestakeServices({ rpcUrl, operatePassword: password });
        const restaked = results.filter(r => r.success);
        const blocked = results.filter(r => !r.success && r.previousState === 2);
        if (restaked.length > 0) {
          workerLogger.info({ restaked: restaked.map(r => `#${r.serviceId}`) },
            `Auto-restaked ${restaked.length} evicted service(s)`);
          clearServiceConfigCache();
          resolvedConfig = await resolveServiceConfig(mechAddress!, rpcUrl);
        }
        if (blocked.length > 0) {
          const earliest = Math.min(...blocked.map(r => r.unstakeAvailableAt ?? Infinity));
          if (earliest !== Infinity) {
            pendingRestakeAt = earliest;
            workerLogger.warn({
              blocked: blocked.map(r => ({ id: r.serviceId, reason: r.reason })),
              retryAt: new Date(earliest * 1000).toISOString(),
            }, `${blocked.length} evicted service(s) in cooldown — will retry after cooldown expires`);
          }
        }
      } catch (e: any) {
        workerLogger.warn({ error: e.message }, 'Auto-restake check failed (non-fatal)');
      }
    }
  }

  // Verify Control API is running before processing any jobs
  await checkControlApiHealth();

  // Auto-register with credential bridge (idempotent, non-blocking)
  await ensureOperatorRegistered();

  // Initialize multi-service rotation if enabled
  let rotator: ServiceRotator | null = null;
  if (config.worker.multiService) {
    const middlewarePath = getMiddlewarePath();
    if (middlewarePath) {
      try {
        rotator = new ServiceRotator({
          rpcUrl: secrets.rpcUrl,
          middlewarePath,
          activityPollMs: config.worker.activityPollMs,
          activityCacheTtlMs: config.worker.activityCacheTtlMs,
        });
        const initial = await rotator.initialize();
        setActiveService(rotator.buildIdentity(initial.service));
        workerLogger.info({
          activeService: initial.service.serviceConfigId,
          serviceId: initial.service.serviceId,
          reason: initial.reason,
        }, 'Multi-service rotation active');
      } catch (err: any) {
        workerLogger.error({ error: err?.message || String(err) }, 'Failed to initialize multi-service rotation, falling back to single-service');
        rotator = null;
      }
    } else {
      workerLogger.warn('WORKER_MULTI_SERVICE enabled but no middleware path found');
    }
  }

  // Log earning schedule at startup
  if (EARNING_SCHEDULE) {
    workerLogger.info({ schedule: EARNING_SCHEDULE, maxJobs: EARNING_MAX_JOBS ?? 'unlimited' }, 'Earning schedule configured');
  }

  if (ENABLE_VENTURE_WATCHER) {
    workerLogger.info({ everyCycles: WORKER_VENTURE_WATCHER_CYCLES }, 'Venture watcher enabled');
  }

  if (SINGLE_SHOT) {
    await processOnce();
    await signingProxy.close().catch(() => { });
    await flushLogger();
    process.exit(0);
  }

  let runCount = 0;

  // Adaptive polling state
  let consecutiveIdleCycles = 0;
  let currentPollIntervalMs = WORKER_POLL_BASE_MS;

  // Repost check frequency limiting
  let cyclesSinceLastRepostCheck = 0;
  let cyclesSinceLastCleanup = 0;
  let cyclesSinceLastCheckpoint = 0;
  let cyclesSinceLastHeartbeat = 0;
  let cyclesSinceLastVentureCheck = 0;
  // Start near threshold so first fund check runs within ~2 cycles of startup
  let cyclesSinceLastFundCheck = WORKER_FUND_CHECK_CYCLES - 2;

  for (; ;) {
    const cycleStart = Date.now();
    try {
      if (shouldStop()) {
        workerLogger.info('Stop signal detected before poll - exiting worker loop');
        return;
      }

      // Earning schedule gate: skip polling if outside earning window
      if (EARNING_SCHEDULE) {
        const { inWindow, msUntilWindow } = checkEarningWindow(EARNING_SCHEDULE);
        if (!inWindow) {
          workerLogger.info({ schedule: EARNING_SCHEDULE, sleepMs: msUntilWindow }, 'Outside earning window - sleeping until window opens');
          // Sleep until window opens (capped at 1 hour to recheck for stop signals)
          await new Promise(r => setTimeout(r, Math.min(msUntilWindow, 60 * 60 * 1000)));
          continue;
        }

        // Reset job counter if this is a new window
        const windowId = getCurrentWindowId(EARNING_SCHEDULE);
        if (windowId !== earningWindowId) {
          earningWindowJobCount = 0;
          earningWindowId = windowId;
          workerLogger.info({ windowId, maxJobs: EARNING_MAX_JOBS ?? 'unlimited' }, 'New earning window started');
        }
      }

      // Earning job cap: skip polling if cap reached for this window
      if (EARNING_MAX_JOBS !== undefined && earningWindowJobCount >= EARNING_MAX_JOBS) {
        workerLogger.info({ jobCount: earningWindowJobCount, maxJobs: EARNING_MAX_JOBS }, 'Earning job cap reached for this window - sleeping');
        await new Promise(r => setTimeout(r, 5 * 60 * 1000));
        continue;
      }

      // Check for completed chains only every Nth cycle (reduces DB queries when idle)
      cyclesSinceLastRepostCheck++;
      if (cyclesSinceLastRepostCheck >= WORKER_REPOST_CHECK_CYCLES) {
        await checkAndRepostCompletedChains();
        cyclesSinceLastRepostCheck = 0;
      }

      // Evict stale entries from global maps to prevent unbounded growth
      cyclesSinceLastCleanup++;
      if (cyclesSinceLastCleanup >= MAP_CLEANUP_INTERVAL_CYCLES) {
        cleanupGlobalMaps();
        cyclesSinceLastCleanup = 0;
      }

      // Call staking checkpoint if epoch is overdue (permissionless, any EOA can trigger)
      // Checkpoint is per-contract — call each contract from the comma-separated list
      {
        const runtimeResolvedConfig = await getRuntimeResolvedConfig();
        const stakingContract = getActiveStakingContractForService(runtimeResolvedConfig);
        const checkpointContracts = stakingContract ? [stakingContract] : [];
        cyclesSinceLastCheckpoint++;
        if (checkpointContracts.length > 0 && cyclesSinceLastCheckpoint >= WORKER_CHECKPOINT_CYCLES) {
          cyclesSinceLastCheckpoint = 0;
          for (const sc of checkpointContracts) {
            try {
              await maybeCallCheckpoint(sc);
            } catch (e: any) {
              workerLogger.warn({ error: serializeError(e), stakingContract: sc }, 'Staking checkpoint call failed (non-fatal)');
            }
          }
        }

        // Submit heartbeat requests to meet staking liveness requirement
        // Only the leader worker submits heartbeats to avoid Safe nonce collisions
        const isHeartbeatLeader = isHeartbeatLeaderWorker();
        cyclesSinceLastHeartbeat++;
        if (isHeartbeatLeader && cyclesSinceLastHeartbeat >= WORKER_HEARTBEAT_CYCLES) {
          cyclesSinceLastHeartbeat = 0;

          // Multi-service mode: submit heartbeats for ALL staked services
          // Deduplicate by Safe address — services sharing a Safe only need one heartbeat
          // because mapRequestCounts is per-multisig, so one request counts for all.
          if (rotator) {
            const handledSafes = new Set<string>();
            for (const service of rotator.getAllServices()) {
              if (!service.stakingContractAddress || !service.serviceId || !service.mechContractAddress) continue;
              // Skip if we already submitted a heartbeat for this Safe
              const safeKey = service.serviceSafeAddress?.toLowerCase();
              if (safeKey && handledSafes.has(safeKey)) {
                workerLogger.debug({ serviceId: service.serviceId, safe: safeKey }, 'Skipping heartbeat — Safe already handled this cycle');
                continue;
              }
              try {
                const resolved = await resolveServiceConfig(service.mechContractAddress, rpcUrl);
                if (!resolved) continue;
                const gate = await checkEpochGate(service.stakingContractAddress, service.serviceId, resolved.marketplace);
                if (!gate.targetMet) {
                  await maybeSubmitHeartbeatForService(
                    service.stakingContractAddress,
                    service.serviceId,
                    resolved.marketplace,
                    service,
                  );
                  if (safeKey) handledSafes.add(safeKey);
                } else {
                  workerLogger.debug({ serviceId: service.serviceId, activities: gate.activityCount, target: gate.target }, 'Epoch target met — skipping heartbeat');
                }
              } catch (e: any) {
                workerLogger.warn({ serviceId: service.serviceId, error: serializeError(e) }, 'Staking heartbeat failed for service (non-fatal)');
              }
            }
          } else if (checkpointContracts.length > 0 && runtimeResolvedConfig) {
            // Single-service fallback — use the runtime-resolved contract or first from env
            const heartbeatContract = runtimeResolvedConfig.stakingContract || checkpointContracts[0];
            try {
              const gate = await checkEpochGate(
                heartbeatContract,
                runtimeResolvedConfig.serviceId,
                runtimeResolvedConfig.marketplace
              );
              if (!gate.targetMet) {
                await maybeSubmitHeartbeat(
                  heartbeatContract,
                  runtimeResolvedConfig.serviceId,
                  runtimeResolvedConfig.marketplace
                );
              } else {
                workerLogger.debug({ activities: gate.activityCount, target: gate.target }, 'Epoch target met — skipping heartbeat');
              }
            } catch (e: any) {
              workerLogger.warn({ error: serializeError(e) }, 'Staking heartbeat failed (non-fatal)');
            }
          }
        }
      }

      // Venture watcher: check dispatch schedules periodically
      if (ENABLE_VENTURE_WATCHER) {
        cyclesSinceLastVentureCheck++;
        if (cyclesSinceLastVentureCheck >= WORKER_VENTURE_WATCHER_CYCLES) {
          cyclesSinceLastVentureCheck = 0;
          try {
            await checkAndDispatchScheduledVentures();
          } catch (e: any) {
            workerLogger.warn({ error: serializeError(e) }, 'Venture watcher check failed (non-fatal)');
          }
        }
      }

      // Fund distribution: top up service Safes/agents from Master Safe
      if (rotator) {
        cyclesSinceLastFundCheck++;
        if (cyclesSinceLastFundCheck >= WORKER_FUND_CHECK_CYCLES) {
          cyclesSinceLastFundCheck = 0;
          try {
            await maybeDistributeFunds(rotator.getAllServices(), rpcUrl);
          } catch (e: any) {
            workerLogger.warn({ error: serializeError(e) }, 'Fund distribution failed (non-fatal)');
          }
        }
      }

      // Deferred restake: retry once cooldown has elapsed
      if (pendingRestakeAt && Math.floor(Date.now() / 1000) >= pendingRestakeAt) {
        pendingRestakeAt = null; // Only attempt once
        const password = secrets.operatePassword;
        if (password && rpcUrl) {
          try {
            workerLogger.info('Cooldown elapsed — attempting deferred restake');
            const results = await checkAndRestakeServices({ rpcUrl, operatePassword: password });
            const restaked = results.filter(r => r.success);
            if (restaked.length > 0) {
              workerLogger.info({ restaked: restaked.map(r => `#${r.serviceId}`) },
                `Deferred restake succeeded for ${restaked.length} service(s)`);
              clearServiceConfigCache();
              resolvedConfig = await resolveServiceConfig(mechAddress!, rpcUrl);
            }
          } catch (e: any) {
            workerLogger.warn({ error: e.message }, 'Deferred restake failed (non-fatal)');
          }
        }
      }

      const jobProcessed = await processOnce();
      const cycleEnd = Date.now();
      const cycleDurationMs = cycleEnd - cycleStart;

      // Record efficiency metrics for healthcheck
      if (jobProcessed) {
        recordExecutionTime(cycleDurationMs);
        consecutiveIdleCycles = 0;
        currentPollIntervalMs = WORKER_POLL_BASE_MS;
        earningWindowJobCount++;
      } else {
        recordIdleCycle(cycleDurationMs);
        consecutiveIdleCycles++;
        currentPollIntervalMs = Math.min(
          WORKER_POLL_MAX_MS,
          Math.floor(WORKER_POLL_BASE_MS * Math.pow(WORKER_POLL_BACKOFF_FACTOR, consecutiveIdleCycles))
        );
      }
      workerLogger.debug({ consecutiveIdleCycles, nextPollMs: currentPollIntervalMs, jobProcessed, cycleDurationMs }, 'Adaptive polling');

      if (shouldStop()) {
        workerLogger.info('Stop signal detected after job processing - exiting worker loop');
        return;
      }

      // Multi-service rotation check (no-op when rotator is null)
      if (rotator) {
        try {
          const decision = await rotator.reevaluate();
          if (decision.switched) {
            setActiveService(rotator.buildIdentity(decision.service));
            // Flush signer + credential caches so next job uses the new service's key/address
            resetControlApiSigner();
            resetSigningProxyAddress();
            resetCredentialInfoCache();

            // Restart signing proxy with the new service's key
            await signingProxy.close();
            signingProxy = await startSigningProxy();
            process.env.AGENT_SIGNING_PROXY_URL = signingProxy.url;
            process.env.AGENT_SIGNING_PROXY_TOKEN = signingProxy.secret;
            workerLogger.info({ url: signingProxy.url }, 'Signing proxy restarted for new service');

            workerLogger.info({
              activeService: decision.service.serviceConfigId,
              serviceId: decision.service.serviceId,
              reason: decision.reason,
              rotationState: rotator.getState(),
            }, 'Rotated to new service');
          }
          // Update healthcheck fleet state
          updateFleetState(rotator.getState());
        } catch (rotErr: any) {
          workerLogger.warn({ error: rotErr?.message || String(rotErr) }, 'Service rotation check failed');
        }
      }

      // Check if we've reached the max runs limit
      if (MAX_RUNS !== undefined) {
        runCount++;
        if (runCount >= MAX_RUNS) {
          workerLogger.info({ totalRuns: runCount, maxRuns: MAX_RUNS }, 'Reached maximum runs - stopping worker');
          return;
        }
      }
    } catch (e: any) {
      workerLogger.error({ error: serializeError(e) }, 'Error in mech loop');
    }
    await new Promise(r => setTimeout(r, currentPollIntervalMs));
  }

  // Clean up signing proxy on worker exit
  await signingProxy.close().catch(() => { });
  delete process.env.AGENT_SIGNING_PROXY_URL;
  delete process.env.AGENT_SIGNING_PROXY_TOKEN;
}

main().catch((err) => {
  workerLogger.error({ error: serializeError(err) }, 'Fatal: unhandled error escaped main loop');
  process.exit(1);
});
