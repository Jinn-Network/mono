/**
 * SolverTypeDefinition for swe-rebench-v2.v1.
 *
 * Wires the pool builder, state store, and selectNextPostingCandidates
 * policy from the supporting modules (_swe-rebench-v2-pool, _swe-rebench-v2-state,
 * swe-rebench-v2-auto) into the SolverTypeDefinition interface consumed by
 * collectTestnetAutoTaskGenerators.
 *
 * Spec: docs/superpowers/specs/2026-05-06-agent-harness-solvernet-design.md §3.6
 */

import { stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { getSolverNetContract } from '@jinn-network/sdk/solvernets';
import { SweRebenchV2TaskSchema } from '@jinn-network/sdk/solvernets/swe-rebench-v2';
import type { Task } from '../types/task.js';
import type { TaskGenerator } from '../tasks/sources.js';
import type { TaskClaimPolicy, TaskV1 } from '../types/task-document.js';
import { signTaskV1 } from '../tasks/signing.js';
import type { LaunchedSolverNetRecord } from '../solvernets/store.js';
import { uploadToIpfs } from '../adapters/mech/ipfs.js';
import type { SolverTypeDefinition } from './solver-type.js';
import {
  selectNextPostingCandidates,
  summarizePoolState,
  DEFAULT_GENERATOR_CONFIG,
  type GeneratorConfig,
  type InstanceClaimSnapshot,
} from './swe-rebench-v2-auto.js';
import { GeneratorStateStore } from './_swe-rebench-v2-state.js';
import type { TaskCounters } from './_swe-rebench-v2-state.js';
import {
  ValidatedPoolStore,
  filterToScorablePool,
  EVAL_SEMANTICS_VERSION,
  VETTED_POOL_REF_ELIGIBILITY_KEY,
  createVettedPoolArtifactRef,
  exportScorableVettedPoolArtifact,
  hashVettedPoolArtifact,
  loadVettedPoolArtifactScorableEntries,
  readVettedPoolArtifactPublication,
  writeVettedPoolArtifactPublication,
  type AdmissionMode,
  type SolverNetArtifactRef,
} from './_swe-rebench-v2-validated-pool.js';
import {
  loadHeldOutSlate,
  excludeHeldOutSlate,
} from './_swe-rebench-v2-held-out-slate.js';
import {
  buildHistoricalPool,
  fetchHfSplit,
  listMonthlyPartitions,
  type PoolTask,
} from './_swe-rebench-v2-pool.js';
import { fetchHfWithRetry } from '../harnesses/impls/swe-rebench-v2-evaluator/hf-fetcher.js';
import { PoolCacheStore, loadPoolWithCacheFallback } from './_swe-rebench-v2-pool-cache.js';

export const HF_DATASET = 'nebius/SWE-rebench-leaderboard';
const SOLVER_TYPE = 'swe-rebench-v2.v1';
// Held-out eval slate version excluded from the train stream (issue #817).
// Bump this one line when a new slate is reserved; scores are only compared
// within a version, so the bump records a distinct version.
const SLATE_VERSION = 'v1';
const CONTRACT_ID = 'swe-rebench-v2';
const CONTRACT_VERSION = 'v1';
const DEFAULT_IPFS_REGISTRY_URL = 'https://registry.autonolas.tech';

/** How long the pool is cached before a full refresh (24 h). */
const POOL_REFRESH_MS = 24 * 60 * 60 * 1000;

export interface SweRebenchV2ClaimPolicyRuntimeConfig {
  /** @deprecated maxClaims is derived per posting from remaining target successes. */
  maxClaims?: number;
  /** @deprecated use top-level maxClaimsPerOperator. */
  maxClaimsPerOperator?: number;
  /** @deprecated use top-level claimLeaseTtlSeconds. */
  claimLeaseTtlSeconds?: number;
}

export type SweRebenchV2GeneratorRuntimeConfig = Partial<GeneratorConfig> & {
  /** @deprecated ignored. Reposts now trigger on claim-budget exhaustion
   *  observed via the indexer (#802); posting_window_ms is only the on-chain
   *  claim-window deadline, not a repost timer. */
  cooldown_ms?: number;
  /** @deprecated legacy nested shape tolerated on read and flattened on write. */
  claimPolicy?: SweRebenchV2ClaimPolicyRuntimeConfig;
};

/** Config passed to buildGenerator — sourced from env or TestnetAutoContext. */
export interface SweRebenchV2AutoConfig {
  stateDir: string;
  generatorConfig?: SweRebenchV2GeneratorRuntimeConfig;
}

export interface SweRebenchV2GeneratorStaticConfig {
  stateDir?: string;
  ipfsRegistryUrl?: string;
  agentEoa?: `0x${string}`;
  safeAddress?: `0x${string}`;
  agentPrivateKey?: `0x${string}`;
  /** Optional DiscoveryAPI for network-truth success reconciliation (#669). */
  discoveryApi?: import('../discovery/types.js').DiscoveryAPI;
}

export interface MakeSweRebenchV2GeneratorForLaunchedRecordOpts {
  recordRef: { current: LaunchedSolverNetRecord };
  configRef: { current: SweRebenchV2GeneratorRuntimeConfig };
  staticConfig?: SweRebenchV2GeneratorStaticConfig;
}

export interface SweRebenchV2GeneratorStateSnapshot {
  kind: 'swe-rebench-v2';
  lastPollAt?: string;
  lastPollSummary?: {
    poolSize: number;
    posted: number;
    unposted: number;
    live: number;
    repostable: number;
    saturated: number;
  };
  lastError?: { message: string; at: string };
  totalPosted: number;
  lastPostedInstanceId?: string;
  config: GeneratorConfig;
  poolPublicationUpdatedAt?: string;
  poolPublicationPriorSize?: number;
  poolPublicationCurrentSize?: number;
}

export type SweRebenchV2GeneratorTick = TaskGenerator & {
  getState: () => SweRebenchV2GeneratorStateSnapshot;
};

interface InternalSweRebenchV2GeneratorConfig extends SweRebenchV2AutoConfig {
  getGeneratorConfig?: () => SweRebenchV2GeneratorRuntimeConfig | unknown;
  solverNetManifestCid?: string;
  ipfsRegistryUrl?: string;
  discoveryApi?: import('../discovery/types.js').DiscoveryAPI;
  creator?: {
    agentEoa?: `0x${string}`;
    safeAddress?: `0x${string}`;
    agentPrivateKey?: `0x${string}`;
  };
}

export function defaultStateDir(): string {
  return join(process.env['HOME'] ?? homedir(), '.jinn-client', 'swe-rebench-v2');
}

/**
 * Load the full historical SWE-rebench v2 pool from the HF datasets-server.
 * Throws if the splits listing is empty or unreachable. Shared by the
 * generator's pool refresh and the `validate-pool` CLI command.
 */
export async function loadSweRebenchV2Pool(): Promise<PoolTask[]> {
  const splitsUrl = `https://datasets-server.huggingface.co/splits?dataset=${encodeURIComponent(HF_DATASET)}`;
  // Route through the shared HF retry helper so the /splits endpoint gets the
  // same jittered 429-backoff treatment as /rows (issue #578).
  const response = await fetchHfWithRetry(splitsUrl, {});
  if (!response.ok) throw new Error(`HF splits fetch failed: ${response.status}`);
  const json = (await response.json()) as { splits?: Array<{ split: string }> };
  const months = listMonthlyPartitions((json.splits ?? []).map((s) => s.split));
  if (months.length === 0) {
    throw new Error('HF datasets-server returned no monthly partitions for the SWE-rebench v2 pool');
  }
  return buildHistoricalPool({
    months,
    fetchSplit: (split) => fetchHfSplit({ dataset: HF_DATASET, split, limit: 100 }),
  });
}

/** A {@link ValidatedPoolStore} rooted at the swe-rebench-v2 generator's state dir. */
export function getSweRebenchV2ValidatedPoolStore(stateDir?: string): ValidatedPoolStore {
  return new ValidatedPoolStore({ stateDir: stateDir ?? defaultStateDir() });
}

function positiveInt(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : fallback;
}

const DEFAULT_ADMISSION_MODE: AdmissionMode = 'required';

function normalizeGeneratorConfig(raw: unknown): GeneratorConfig {
  const cfg = typeof raw === 'object' && raw !== null
    ? raw as Record<string, unknown>
    : {};
  const legacyPolicy = typeof cfg['claimPolicy'] === 'object' && cfg['claimPolicy'] !== null
    ? cfg['claimPolicy'] as Record<string, unknown>
    : {};
  const N_target_successes = positiveInt(
    cfg['N_target_successes'],
    DEFAULT_GENERATOR_CONFIG.N_target_successes,
  );
  const rawMode = cfg['admissionMode'];
  const admissionMode: AdmissionMode =
    rawMode === 'python-floor' ? 'python-floor' : DEFAULT_ADMISSION_MODE;
  const maxClaimsPerOperator = positiveInt(
    cfg['maxClaimsPerOperator'] ?? legacyPolicy['maxClaimsPerOperator'],
    0,
  );
  return {
    N_target_successes,
    posting_window_ms: positiveInt(
      cfg['posting_window_ms'],
      DEFAULT_GENERATOR_CONFIG.posting_window_ms,
    ),
    post_batch_size: positiveInt(
      cfg['post_batch_size'],
      DEFAULT_GENERATOR_CONFIG.post_batch_size,
    ),
    ...(maxClaimsPerOperator > 0 ? { maxClaimsPerOperator } : {}),
    claimLeaseTtlSeconds: positiveInt(
      cfg['claimLeaseTtlSeconds'] ?? legacyPolicy['claimLeaseTtlSeconds'],
      DEFAULT_GENERATOR_CONFIG.claimLeaseTtlSeconds,
    ),
    admissionMode,
  };
}

function inferLanguageFromPatch(patch: string | undefined): string | undefined {
  if (!patch) return undefined;
  const pathMatches = patch.matchAll(/(?:^|\n)(?:---|\+\+\+) [ab]\/([^\n]+)/g);
  const paths = Array.from(pathMatches, (m) => m[1] ?? '');
  const has = (regex: RegExp) => paths.some((p) => regex.test(p));
  if (has(/\.(ts|tsx)$/u)) return 'typescript';
  if (has(/\.(js|jsx|mjs|cjs)$/u)) return 'javascript';
  if (has(/\.go$/u)) return 'go';
  if (has(/\.(cc|cpp|cxx|hpp|hh|hxx)$/u)) return 'cpp';
  if (has(/\.(c|h)$/u)) return 'c';
  if (has(/\.cs$/u)) return 'cs';
  if (has(/\.java$/u)) return 'java';
  if (has(/\.rs$/u)) return 'rust';
  if (has(/\.dart$/u)) return 'dart';
  if (has(/\.py$/u)) return 'python';
  return undefined;
}

function normalizeLanguage(
  task: PoolTask,
): 'python' | 'javascript' | 'typescript' | 'go' | 'c' | 'cpp' | 'cs' | 'java' | 'rust' | 'dart' {
  const raw = task.language ?? inferLanguageFromPatch(task.patch) ?? inferLanguageFromPatch(task.test_patch);
  const parsed = SweRebenchV2TaskSchema.shape.language.safeParse(raw);
  return parsed.success ? parsed.data : 'python';
}

function repoFromInstanceId(instanceId: string): string {
  const [org, repoAndIssue] = instanceId.split('__');
  if (!org || !repoAndIssue) return 'unknown/unknown';
  const splitAt = repoAndIssue.lastIndexOf('-');
  const repo = splitAt > 0 ? repoAndIssue.slice(0, splitAt) : repoAndIssue;
  return `${org}/${repo}`;
}

function sweRebenchDefaultClaimPolicy(): TaskClaimPolicy {
  const contract = getSolverNetContract({ id: CONTRACT_ID, version: CONTRACT_VERSION });
  const defaults = contract?.claimPolicyDefaults;
  return {
    mode: defaults?.mode === 'serial' ? 'exclusive' : 'parallel',
    maxClaims: defaults?.maxClaims ?? DEFAULT_GENERATOR_CONFIG.N_target_successes,
    maxClaimsPerOperator: defaults?.maxClaimsPerOperator ?? DEFAULT_GENERATOR_CONFIG.N_target_successes,
    claimLeaseTtlSeconds: defaults?.claimLeaseTtlSeconds ?? 60 * 60,
  };
}

function claimPolicyForPosting(
  genConfig: GeneratorConfig,
  remainingTargetSuccesses: number,
): TaskClaimPolicy {
  const defaults = sweRebenchDefaultClaimPolicy();
  const maxClaims = Math.max(1, remainingTargetSuccesses);
  const maxClaimsPerOperator = Math.min(
    maxClaims,
    genConfig.maxClaimsPerOperator ?? maxClaims,
  );
  return {
    ...defaults,
    maxClaims,
    maxClaimsPerOperator,
    claimLeaseTtlSeconds: genConfig.claimLeaseTtlSeconds,
  };
}

interface PublishedVettedPool {
  scorableIds: Set<string> | null;
  artifactRef: SolverNetArtifactRef | null;
  mode: 'published' | 'published-from-local' | 'no-publication' | 'no-manifest';
  // Set only when an existing publication was found stale and re-uploaded; the
  // tick uses presence here as the signal to surface the re-publication state-message.
  republication?: { priorSize: number; currentSize: number; publishedAt: string };
}

async function resolvePublishedVettedPool(args: {
  stateDir: string;
  manifestCid: string | undefined;
  store: ValidatedPoolStore;
  nowIso: string;
  ipfsRegistryUrl: string;
  upload: typeof uploadToIpfs;
}): Promise<PublishedVettedPool> {
  if (!args.manifestCid) {
    return { scorableIds: null, artifactRef: null, mode: 'no-manifest' };
  }

  const existing = await readVettedPoolArtifactPublication({
    stateDir: args.stateDir,
    manifestCid: args.manifestCid,
    evalSemanticsVersion: EVAL_SEMANTICS_VERSION,
  });

  let priorSize: number | undefined;
  if (existing) {
    const scorable = await args.store.getScorableEntries(EVAL_SEMANTICS_VERSION);
    const validatedNewer = scorable !== null && scorable.updatedAt > existing.updatedAt;
    if (!validatedNewer) {
      return {
        scorableIds: loadVettedPoolArtifactScorableEntries(existing.artifact).ids,
        artifactRef: existing.ref,
        mode: 'published',
      };
    }
    priorSize = existing.artifact.entries.length;
  }

  const artifact = await exportScorableVettedPoolArtifact(args.store, EVAL_SEMANTICS_VERSION, {
    generatedAt: args.nowIso,
  });
  if (!artifact || artifact.entries.length === 0) {
    return { scorableIds: null, artifactRef: null, mode: 'no-publication' };
  }

  const artifactCid = await args.upload(args.ipfsRegistryUrl, artifact);
  const artifactRef = createVettedPoolArtifactRef({
    manifestCid: args.manifestCid,
    artifactCid,
    artifactHash: hashVettedPoolArtifact(artifact),
    evalSemanticsVersion: EVAL_SEMANTICS_VERSION,
    publishedAt: args.nowIso,
  });
  await writeVettedPoolArtifactPublication({
    stateDir: args.stateDir,
    ref: artifactRef,
    artifact,
    updatedAt: args.nowIso,
  });
  return {
    scorableIds: loadVettedPoolArtifactScorableEntries(artifact).ids,
    artifactRef,
    mode: 'published-from-local',
    ...(priorSize !== undefined
      ? {
          republication: {
            priorSize,
            currentSize: artifact.entries.length,
            publishedAt: args.nowIso,
          },
        }
      : {}),
  };
}

async function maybeSignTask(
  task: Task,
  opts: {
    creator?: InternalSweRebenchV2GeneratorConfig['creator'];
    createdAt: number;
  },
): Promise<Task> {
  if (
    !task.solverNetManifestCid ||
    !opts.creator?.agentEoa ||
    !opts.creator.safeAddress ||
    !opts.creator.agentPrivateKey
  ) {
    return task;
  }
  const taskDoc: TaskV1 = {
    schemaVersion: 'task.v1',
    id: task.id,
    solverType: task.solverType ?? SOLVER_TYPE,
    contractId: task.contractId ?? CONTRACT_ID,
    contractVersion: task.contractVersion ?? CONTRACT_VERSION,
    solverNetManifestCid: task.solverNetManifestCid,
    role: task.role ?? 'restoration',
    description: task.description,
    window: task.window!,
    spec: task.spec ?? {},
    eligibility: task.eligibility ?? {},
    claimPolicy: task.claimPolicy ?? sweRebenchDefaultClaimPolicy(),
    creator: {
      safeAddress: opts.creator.safeAddress,
      agentEoa: opts.creator.agentEoa,
    },
    createdAt: opts.createdAt,
  };
  return {
    ...task,
    signedTask: await signTaskV1(taskDoc, opts.creator.agentPrivateKey),
  };
}

/**
 * Build a TaskGenerator that wraps the full-historical-pool +
 * post-until-target-successes policy.
 */
function makeSweRebenchV2Generator(config: InternalSweRebenchV2GeneratorConfig): SweRebenchV2GeneratorTick {
  const stateStore = new GeneratorStateStore({ stateDir: config.stateDir });
  const validatedPoolStore = new ValidatedPoolStore({ stateDir: config.stateDir });

  const poolCache = new PoolCacheStore({ stateDir: config.stateDir });
  let pool: PoolTask[] = [];
  let poolLoadedAt = 0;
  let poolFromCache = false;
  let floorWarned = false;
  let publicationWarned = false;
  let slateWarned = false;
  let lastPostedLanguage: string | undefined;
  let lastPollAt: string | undefined;
  let lastPollSummary: SweRebenchV2GeneratorStateSnapshot['lastPollSummary'];
  let lastError: SweRebenchV2GeneratorStateSnapshot['lastError'];
  let totalPosted = 0;
  let lastPostedInstanceId: string | undefined;
  let publishedPoolCache: PublishedVettedPool | null = null;
  let lastValidatedPoolMtimeMs = -1;
  let lastRepublication: PublishedVettedPool['republication'] | undefined;

  async function refreshPool(): Promise<void> {
    const result = await loadPoolWithCacheFallback({
      loadPool: loadSweRebenchV2Pool,
      cache: poolCache,
      currentPool: pool,
    });
    pool = result.pool;
    poolFromCache = result.fromCache;
    lastError = result.error;
    if (!result.error) {
      // Fresh HF load — hold it for the full POOL_REFRESH_MS window.
      poolLoadedAt = Date.now();
    }
    if (result.fromCache) {
      console.warn(
        `[swe-rebench-v2-gen] HF pool refresh failed; serving ${pool.length} tasks from disk cache — ` +
        `generator stays live, will retry HF next poll: ${result.error?.message}`,
      );
    } else if (result.error) {
      console.warn(
        `[swe-rebench-v2-gen] pool refresh failed (pool size ${pool.length}): ${result.error.message}`,
      );
    }
  }

  const tick = async (): Promise<Task[] | null> => {
    const now = Date.now();
    // #802: re-read counters from disk at the start of every tick. last_task_id
    // (and successful) are written by other loops (CreatorLoop.recordLastTaskId,
    // delivery-watcher.recordSuccess) through separate store instances against
    // the same file; without invalidating the long-lived cache here the
    // generator never observes those writes and reposts every tick.
    stateStore.invalidate();
    const runtimeConfig = config.getGeneratorConfig
      ? config.getGeneratorConfig()
      : config.generatorConfig;
    const genConfig = normalizeGeneratorConfig(runtimeConfig);

    // Refresh pool if stale, empty, or currently served from the disk cache
    // (a cache-served pool retries HF every poll so the generator self-heals
    // as soon as HF recovers — #466).
    if (pool.length === 0 || poolFromCache || now - poolLoadedAt > POOL_REFRESH_MS) {
      await refreshPool();
    }
    if (pool.length === 0) {
      lastPollSummary = {
        poolSize: 0,
        posted: 0,
        unposted: 0,
        live: 0,
        repostable: 0,
        saturated: 0,
      };
      return null;
    }
    lastPollAt = new Date(now).toISOString();

    const validatedPoolMtimeMs = await stat(join(config.stateDir, 'validated-pool.json'))
      .then((s) => s.mtimeMs)
      .catch(() => -1);
    if (validatedPoolMtimeMs > lastValidatedPoolMtimeMs) {
      publishedPoolCache = null;
      lastValidatedPoolMtimeMs = validatedPoolMtimeMs;
    }

    let publishedPool: PublishedVettedPool | null = publishedPoolCache;
    if (!publishedPool) {
      publishedPool = await resolvePublishedVettedPool({
        stateDir: config.stateDir,
        manifestCid: config.solverNetManifestCid,
        store: validatedPoolStore,
        nowIso: lastPollAt,
        ipfsRegistryUrl:
          config.ipfsRegistryUrl ??
          process.env['JINN_IPFS_REGISTRY_URL'] ??
          DEFAULT_IPFS_REGISTRY_URL,
        upload: uploadToIpfs,
      }).catch((err) => {
        const message = err instanceof Error ? err.message : String(err);
        lastError = {
          message: `vetted pool publication failed: ${message}`,
          at: new Date().toISOString(),
        };
        console.warn(`[swe-rebench-v2-gen] ${lastError.message}`);
        return null;
      });
      if (publishedPool?.artifactRef) {
        publishedPoolCache = publishedPool;
        if (publishedPool.republication) {
          lastRepublication = publishedPool.republication;
        }
      }
    }
    if (publishedPool === null) {
      lastPollSummary = {
        poolSize: 0,
        posted: 0,
        unposted: 0,
        live: 0,
        repostable: 0,
        saturated: 0,
      };
      return null;
    }
    if (
      genConfig.admissionMode === 'required' &&
      publishedPool.mode === 'no-manifest' &&
      !publicationWarned
    ) {
      publicationWarned = true;
      console.warn(
        `[swe-rebench-v2-gen] no solverNetManifestCid is available, so the launcher cannot stamp a vetted pool artifact ref; admissionMode='required' is fail-closed.`,
      );
    }

    // Restrict to instances in the launcher's published pool artifact. If the
    // launcher has no publication yet but local scorable data exists, the
    // helper above publishes it once before this filter runs. Python-floor is
    // preserved only for local/dev generators.
    const scorableIds = publishedPool.artifactRef
      ? publishedPool.scorableIds
      : genConfig.admissionMode === 'python-floor'
        ? await validatedPoolStore.getScorableIds(EVAL_SEMANTICS_VERSION)
        : null;
    const { pool: scorablePool, mode: poolMode } = filterToScorablePool(
      pool,
      scorableIds,
      genConfig.admissionMode,
    );
    // Held-out eval slate exclusion (issue #817 AC#2). The generator is the
    // single train-stream chokepoint, so dropping slate instances here means
    // they are never posted, never claimable, and never train. The slate is
    // content-addressed and fails loud on hash mismatch at load.
    const slateExcludedBefore = scorablePool.length;
    const eligiblePool = excludeHeldOutSlate(
      scorablePool,
      loadHeldOutSlate(SOLVER_TYPE, SLATE_VERSION).instanceIds,
    );
    if (eligiblePool.length < slateExcludedBefore && !slateWarned) {
      slateWarned = true;
      console.warn(
        `[swe-rebench-v2-gen] held-out slate ${SLATE_VERSION}: excluded ${slateExcludedBefore - eligiblePool.length} reserved instance(s) from the train stream.`,
      );
    }
    if (poolMode === 'admission-required-no-data' && !floorWarned) {
      floorWarned = true;
      console.warn(
        `[swe-rebench-v2-gen] no pool-validation data — admissionMode='required' is fail-closed.\n` +
        `  Run:  jinn solver-nets validate-pool swe-rebench-v2 --seed-positive --known-bad\n` +
        `  Expected duration: ~1-2h (one gold-patch eval per seed instance).\n` +
        `  For local development, set solverNets.<name>.taskGenerator.admissionMode = "python-floor".`,
      );
    }
    if (poolMode === 'python-floor' && !floorWarned) {
      floorWarned = true;
      console.warn(
        `[swe-rebench-v2-gen] admissionMode='python-floor' (local/dev): restricting to ${eligiblePool.length} Python instance(s) of ${pool.length}; run \`jinn solver-nets validate-pool swe-rebench-v2 --seed-positive\` to advance to required mode.`,
      );
    }
    if (eligiblePool.length === 0) {
      lastPollSummary = {
        poolSize: 0,
        posted: 0,
        unposted: 0,
        live: 0,
        repostable: 0,
        saturated: 0,
      };
      lastError = undefined;
      return null;
    }

    // Load all counters for eligible tasks
    const counters = new Map<string, TaskCounters>();
    for (const task of eligiblePool) {
      counters.set(task.instance_id, await stateStore.getCounters(task.instance_id));
    }

    // Reconcile each instance's `successful` against network truth (#669):
    // take max(local, network). On indexer outage the tick aborts — silently
    // falling through to local-only counters is exactly the bug being fixed.
    // The discoveryApi/manifestCid pair is optional so test paths can skip.
    if (config.discoveryApi && config.solverNetManifestCid) {
      try {
        const networkSuccesses = await config.discoveryApi.getInstanceSuccessCounts({
          manifestCid: config.solverNetManifestCid,
        });
        for (const task of eligiblePool) {
          const local = counters.get(task.instance_id);
          if (!local) continue;
          const networkSuccess = networkSuccesses.get(task.instance_id) ?? 0;
          if (networkSuccess > local.successful) {
            counters.set(task.instance_id, { ...local, successful: networkSuccess });
          }
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        lastError = {
          message: `network-truth reconciliation failed: ${message}`,
          at: new Date().toISOString(),
        };
        console.warn(`[swe-rebench-v2-gen] ${lastError.message} — skipping this tick`);
        lastPollSummary = {
          poolSize: eligiblePool.length,
          posted: 0,
          unposted: 0,
          live: 0,
          repostable: 0,
          saturated: 0,
        };
        return null;
      }
    }

    // Reconcile claim-budget exhaustion against network truth (#802): a posting
    // is exhausted when its on-chain consumed slots reach maxClaims. Keyed by
    // taskId; the classifier joins via each instance's last_task_id. On a
    // genuine indexer outage (throw) the tick aborts — silently continuing with
    // no claim snapshot would mask real exhaustion (exhausted postings classify
    // `live`), suppress legitimate reposts, and under-serve N. A *successful*
    // empty map (e.g. onchain-floor mode) is NOT an outage and is allowed
    // through: it makes every posting inert (post-once), which is the safe
    // degradation, not a storm.
    let claimCounts: Map<string, InstanceClaimSnapshot> | undefined;
    if (config.discoveryApi && config.solverNetManifestCid) {
      try {
        // getInstanceClaimCounts is keyed by taskId; its values are a structural
        // superset of InstanceClaimSnapshot, so the map is used directly.
        claimCounts = await config.discoveryApi.getInstanceClaimCounts({
          manifestCid: config.solverNetManifestCid,
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        lastError = {
          message: `claim-budget reconciliation failed: ${message}`,
          at: new Date().toISOString(),
        };
        console.warn(`[swe-rebench-v2-gen] ${lastError.message} — skipping this tick`);
        lastPollSummary = {
          poolSize: eligiblePool.length,
          posted: 0,
          unposted: 0,
          live: 0,
          repostable: 0,
          saturated: 0,
        };
        return null;
      }
    }

    const candidates = selectNextPostingCandidates({
      pool: eligiblePool,
      counters,
      config: genConfig,
      now,
      claimCounts,
      lastPostedLanguage,
    });
    if (candidates.length === 0) {
      lastPollSummary = summarizePoolState({
        pool: eligiblePool,
        counters,
        config: genConfig,
        now,
        claimCounts,
        lastPostedLanguage,
      });
      lastError = undefined;
      return null;
    }

    const tasks: Task[] = [];
    for (const candidate of candidates) {
      await stateStore.recordPosted(candidate.instance_id, now);
      const afterRecord = await stateStore.getCounters(candidate.instance_id);
      counters.set(candidate.instance_id, afterRecord);
      lastPostedLanguage = candidate.language;
      totalPosted += 1;
      lastPostedInstanceId = candidate.instance_id;

      const remainingTargetSuccesses = genConfig.N_target_successes - afterRecord.successful;
      const deadlineUnix = Math.floor((now + genConfig.posting_window_ms) / 1000);
      const roundMonth = candidate.hf_split.replace('_', '-');
      const windowEndTs = deadlineUnix * 1000;

      const spec = SweRebenchV2TaskSchema.parse({
        schemaVersion: 'swe-rebench-v2.v1',
        instance_id: candidate.instance_id,
        repo: candidate.repo ?? repoFromInstanceId(candidate.instance_id),
        base_commit: candidate.base_commit ?? '0000000000000000000000000000000000000000',
        language: normalizeLanguage(candidate),
        problem_statement:
          candidate.problem_statement ?? `SWE-rebench v2 instance: ${candidate.instance_id}`,
        interface: candidate.interface ?? '',
        hf_dataset: candidate.hf_dataset,
        hf_split: candidate.hf_split,
        deadline_unix: deadlineUnix,
        round_month: roundMonth,
      });

      tasks.push({
        id: randomUUID(),
        description: `SWE-rebench v2: ${candidate.instance_id}`,
        solverType: SOLVER_TYPE,
        contractId: CONTRACT_ID,
        contractVersion: CONTRACT_VERSION,
        ...(config.solverNetManifestCid
          ? { solverNetManifestCid: config.solverNetManifestCid }
          : {}),
        role: 'restoration',
        window: {
          startTs: now,
          endTs: windowEndTs,
        },
        claimPolicy: claimPolicyForPosting(genConfig, remainingTargetSuccesses),
        spec,
        eligibility: {
          hf_dataset: candidate.hf_dataset,
          hf_split: candidate.hf_split,
          instance_id: candidate.instance_id,
          posted_count_after_record: afterRecord.posted,
          generatorConfig: genConfig,
          ...(publishedPool.artifactRef
            ? { [VETTED_POOL_REF_ELIGIBILITY_KEY]: publishedPool.artifactRef }
            : {}),
        },
      });
    }

    console.log(
      `[swe-rebench-v2-gen] posting ${candidates.length} instance(s): ` +
      candidates.map((candidate) => candidate.instance_id).join(', '),
    );
    lastPollSummary = {
      ...summarizePoolState({
        pool: eligiblePool,
        counters,
        config: genConfig,
        now,
        claimCounts,
        lastPostedLanguage,
      }),
      posted: tasks.length,
    };
    lastError = undefined;
    const signed: Task[] = [];
    for (const task of tasks) {
      signed.push(await maybeSignTask(task, { creator: config.creator, createdAt: now }));
    }
    return signed.length > 0 ? signed : null;
  };

  return Object.assign(tick, {
    getState(): SweRebenchV2GeneratorStateSnapshot {
      const liveConfig = normalizeGeneratorConfig(
        config.getGeneratorConfig ? config.getGeneratorConfig() : config.generatorConfig,
      );
      return {
        kind: 'swe-rebench-v2',
        lastPollAt,
        lastPollSummary,
        lastError,
        totalPosted,
        lastPostedInstanceId,
        config: liveConfig,
        ...(lastRepublication
          ? {
              poolPublicationUpdatedAt: lastRepublication.publishedAt,
              poolPublicationPriorSize: lastRepublication.priorSize,
              poolPublicationCurrentSize: lastRepublication.currentSize,
            }
          : {}),
      };
    },
  });
}

export const sweRebenchV2: SolverTypeDefinition<SweRebenchV2AutoConfig> = {
  solverType: 'swe-rebench-v2.v1',
  async parseSpec(raw) {
    const task = SweRebenchV2TaskSchema.parse(raw);
    return {
      window: undefined,
      spec: task,
      eligibility: {},
    };
  },
  buildGenerator: (config) => makeSweRebenchV2Generator(config),
  loadHeldOutSlate: (version) => loadHeldOutSlate(SOLVER_TYPE, version),
  getTestnetAutoConfig: (ctx) => {
    if (ctx.network !== 'testnet') return undefined;
    // Only activate when explicitly opted in via env flag
    if (process.env['JINN_SWE_REBENCH_V2_LAUNCHER_ENABLED'] !== '1') return undefined;
    const stateDir =
      process.env['JINN_SWE_REBENCH_V2_STATE_DIR'] ??
      defaultStateDir();
    return { stateDir };
  },
  ui: {
    description: 'SWE-rebench v2 coding benchmark (HuggingFace dataset)',
    category: 'code',
  },
};

export function makeSweRebenchV2GeneratorForLaunchedRecord(
  opts: MakeSweRebenchV2GeneratorForLaunchedRecordOpts,
): SweRebenchV2GeneratorTick {
  const { recordRef, configRef, staticConfig = {} } = opts;
  const stateDir =
    staticConfig.stateDir ??
    process.env['JINN_SWE_REBENCH_V2_STATE_DIR'] ??
    defaultStateDir();

  const generator = makeSweRebenchV2Generator({
    stateDir,
    getGeneratorConfig: () => configRef.current,
    solverNetManifestCid: recordRef.current.manifestCid,
    ipfsRegistryUrl: staticConfig.ipfsRegistryUrl,
    discoveryApi: staticConfig.discoveryApi,
    creator: {
      agentEoa: staticConfig.agentEoa,
      safeAddress: staticConfig.safeAddress,
      agentPrivateKey: staticConfig.agentPrivateKey,
    },
  });

  const gatedTick = async (): Promise<Task | Task[] | null> => {
    const record = recordRef.current;
    if (record.status !== 'launched') return null;
    if (!record.generatorEnabled) return null;
    return generator();
  };

  return Object.assign(gatedTick, {
    getState(): SweRebenchV2GeneratorStateSnapshot {
      return generator.getState();
    },
  });
}

/**
 * Accessor for the GeneratorStateStore used by the delivery-watcher verdict hook.
 * Returns a store rooted at the same default stateDir as the generator.
 */
export function getSweRebenchV2StateStore(stateDir?: string): GeneratorStateStore {
  const dir =
    stateDir ??
    process.env['JINN_SWE_REBENCH_V2_STATE_DIR'] ??
    defaultStateDir();
  return new GeneratorStateStore({ stateDir: dir });
}
