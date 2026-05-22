/**
 * SolverTypeDefinition for swe-rebench-v2.v1.
 *
 * Wires the pool builder, state store, and selectNextPostingCandidate
 * policy from the supporting modules (_swe-rebench-v2-pool, _swe-rebench-v2-state,
 * swe-rebench-v2-auto) into the SolverTypeDefinition interface consumed by
 * collectTestnetAutoTaskGenerators.
 *
 * Spec: docs/superpowers/specs/2026-05-06-agent-harness-solvernet-design.md §3.6
 */

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
  selectNextPostingCandidate,
  DEFAULT_GENERATOR_CONFIG,
  type GeneratorConfig,
} from './swe-rebench-v2-auto.js';
import { GeneratorStateStore } from './_swe-rebench-v2-state.js';
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
  buildHistoricalPool,
  fetchHfSplit,
  listMonthlyPartitions,
  type PoolTask,
} from './_swe-rebench-v2-pool.js';
import { PoolCacheStore, loadPoolWithCacheFallback } from './_swe-rebench-v2-pool-cache.js';

export const HF_DATASET = 'nebius/SWE-rebench-leaderboard';
const SOLVER_TYPE = 'swe-rebench-v2.v1';
const CONTRACT_ID = 'swe-rebench-v2';
const CONTRACT_VERSION = 'v1';
const DEFAULT_IPFS_REGISTRY_URL = 'https://registry.autonolas.tech';

/** How long the pool is cached before a full refresh (24 h). */
const POOL_REFRESH_MS = 24 * 60 * 60 * 1000;

export interface SweRebenchV2ClaimPolicyRuntimeConfig {
  maxClaims?: number;
  maxClaimsPerOperator?: number;
  claimLeaseTtlSeconds?: number;
}

export type SweRebenchV2GeneratorRuntimeConfig = Partial<GeneratorConfig> & {
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
}

export interface MakeSweRebenchV2GeneratorForLaunchedRecordOpts {
  recordRef: { current: LaunchedSolverNetRecord };
  configRef: { current: SweRebenchV2GeneratorRuntimeConfig };
  staticConfig?: SweRebenchV2GeneratorStaticConfig;
}

export interface SweRebenchV2GeneratorStateSnapshot {
  kind: 'swe-rebench-v2';
  lastPollAt?: string;
  lastPollSummary?: { poolSize: number; posted: number; skipped: number };
  lastError?: { message: string; at: string };
  totalPosted: number;
  lastPostedInstanceId?: string;
  config: GeneratorConfig;
}

export type SweRebenchV2GeneratorTick = TaskGenerator & {
  getState: () => SweRebenchV2GeneratorStateSnapshot;
};

interface InternalSweRebenchV2GeneratorConfig extends SweRebenchV2AutoConfig {
  getGeneratorConfig?: () => SweRebenchV2GeneratorRuntimeConfig | unknown;
  solverNetManifestCid?: string;
  ipfsRegistryUrl?: string;
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
  const response = await fetch(splitsUrl);
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

function nonNegativeInt(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : fallback;
}

const DEFAULT_ADMISSION_MODE: AdmissionMode = 'required';

function normalizeGeneratorConfig(raw: unknown): GeneratorConfig {
  const cfg = typeof raw === 'object' && raw !== null
    ? raw as Record<string, unknown>
    : {};
  const N_target_successes = positiveInt(
    cfg['N_target_successes'],
    DEFAULT_GENERATOR_CONFIG.N_target_successes,
  );
  const N_max_postings_per_task = Math.max(
    N_target_successes,
    positiveInt(
      cfg['N_max_postings_per_task'],
      DEFAULT_GENERATOR_CONFIG.N_max_postings_per_task,
    ),
  );
  const rawMode = cfg['admissionMode'];
  const admissionMode: AdmissionMode =
    rawMode === 'python-floor' ? 'python-floor' : DEFAULT_ADMISSION_MODE;
  return {
    N_target_successes,
    N_max_postings_per_task,
    cooldown_ms: nonNegativeInt(cfg['cooldown_ms'], DEFAULT_GENERATOR_CONFIG.cooldown_ms),
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
    maxClaims: defaults?.maxClaims ?? 50,
    maxClaimsPerOperator: defaults?.maxClaimsPerOperator ?? 5,
    claimLeaseTtlSeconds: defaults?.claimLeaseTtlSeconds ?? 60 * 60,
  };
}

function normalizeClaimPolicy(raw: unknown): TaskClaimPolicy {
  const defaults = sweRebenchDefaultClaimPolicy();
  const cfg = typeof raw === 'object' && raw !== null
    ? raw as { claimPolicy?: unknown }
    : {};
  const policy = typeof cfg.claimPolicy === 'object' && cfg.claimPolicy !== null
    ? cfg.claimPolicy as Record<string, unknown>
    : {};
  const maxClaims = positiveInt(policy.maxClaims, defaults.maxClaims);
  const maxClaimsPerOperator = Math.min(
    maxClaims,
    positiveInt(policy.maxClaimsPerOperator, defaults.maxClaimsPerOperator),
  );
  return {
    ...defaults,
    maxClaims,
    maxClaimsPerOperator,
    claimLeaseTtlSeconds: positiveInt(
      policy.claimLeaseTtlSeconds,
      defaults.claimLeaseTtlSeconds,
    ),
  };
}

async function resolvePublishedVettedPool(args: {
  stateDir: string;
  manifestCid: string | undefined;
  store: ValidatedPoolStore;
  nowIso: string;
  ipfsRegistryUrl: string;
  upload: typeof uploadToIpfs;
}): Promise<{
  scorableIds: Set<string> | null;
  artifactRef: SolverNetArtifactRef | null;
  mode: 'published' | 'published-from-local' | 'no-publication' | 'no-manifest';
}> {
  if (!args.manifestCid) {
    return { scorableIds: null, artifactRef: null, mode: 'no-manifest' };
  }

  const existing = await readVettedPoolArtifactPublication({
    stateDir: args.stateDir,
    manifestCid: args.manifestCid,
    evalSemanticsVersion: EVAL_SEMANTICS_VERSION,
  });
  if (existing) {
    return {
      scorableIds: loadVettedPoolArtifactScorableEntries(existing.artifact).ids,
      artifactRef: existing.ref,
      mode: 'published',
    };
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
    claimPolicy: task.claimPolicy ?? normalizeClaimPolicy(undefined),
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
  let lastPostedLanguage: string | undefined;
  let lastPollAt: string | undefined;
  let lastPollSummary: SweRebenchV2GeneratorStateSnapshot['lastPollSummary'];
  let lastError: SweRebenchV2GeneratorStateSnapshot['lastError'];
  let totalPosted = 0;
  let lastPostedInstanceId: string | undefined;

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

  const tick = async (): Promise<Task | null> => {
    const now = Date.now();
    const runtimeConfig = config.getGeneratorConfig
      ? config.getGeneratorConfig()
      : config.generatorConfig;
    const genConfig = normalizeGeneratorConfig(runtimeConfig);
    const claimPolicy = normalizeClaimPolicy(runtimeConfig);

    // Refresh pool if stale, empty, or currently served from the disk cache
    // (a cache-served pool retries HF every poll so the generator self-heals
    // as soon as HF recovers — #466).
    if (pool.length === 0 || poolFromCache || now - poolLoadedAt > POOL_REFRESH_MS) {
      await refreshPool();
    }
    if (pool.length === 0) {
      lastPollSummary = { poolSize: 0, posted: 0, skipped: 0 };
      return null;
    }
    lastPollAt = new Date(now).toISOString();

    const publishedPool = await resolvePublishedVettedPool({
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
    if (publishedPool === null) {
      lastPollSummary = { poolSize: 0, posted: 0, skipped: pool.length };
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
    const { pool: eligiblePool, mode: poolMode } = filterToScorablePool(
      pool,
      scorableIds,
      genConfig.admissionMode,
    );
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
      lastPollSummary = { poolSize: 0, posted: 0, skipped: 0 };
      lastError = undefined;
      return null;
    }

    // Load all counters for eligible tasks
    const counters = new Map<string, { posted: number; successful: number; last_posted_at: number }>();
    for (const task of eligiblePool) {
      counters.set(task.instance_id, await stateStore.getCounters(task.instance_id));
    }

    const mostRecentPostedAt = Math.max(
      0,
      ...Array.from(counters.values(), (c) => c.last_posted_at),
    );
    if (mostRecentPostedAt > 0 && now - mostRecentPostedAt < genConfig.cooldown_ms) {
      lastPollSummary = { poolSize: eligiblePool.length, posted: 0, skipped: eligiblePool.length };
      lastError = undefined;
      return null;
    }

    const candidate = selectNextPostingCandidate({
      pool: eligiblePool,
      counters,
      config: genConfig,
      now,
      lastPostedLanguage,
    });
    if (!candidate) {
      lastPollSummary = { poolSize: eligiblePool.length, posted: 0, skipped: eligiblePool.length };
      lastError = undefined;
      return null;
    }

    // Record the posting
    await stateStore.recordPosted(candidate.instance_id, now);
    lastPostedLanguage = candidate.language;
    totalPosted += 1;
    lastPostedInstanceId = candidate.instance_id;

    // Build the Task
    const deadlineUnix = Math.floor((now + 7 * 24 * 60 * 60 * 1000) / 1000); // 7-day window
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

    const task: Task = {
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
      claimPolicy,
      spec,
      ...(publishedPool.artifactRef
        ? { context: { [VETTED_POOL_REF_ELIGIBILITY_KEY]: publishedPool.artifactRef } }
        : {}),
      eligibility: {
        hf_dataset: candidate.hf_dataset,
        hf_split: candidate.hf_split,
        instance_id: candidate.instance_id,
        generatorConfig: genConfig,
        ...(publishedPool.artifactRef
          ? { [VETTED_POOL_REF_ELIGIBILITY_KEY]: publishedPool.artifactRef }
          : {}),
      },
    };

    console.log(`[swe-rebench-v2-gen] posting ${candidate.instance_id}`);
    lastPollSummary = { poolSize: eligiblePool.length, posted: 1, skipped: 0 };
    lastError = undefined;
    return maybeSignTask(task, { creator: config.creator, createdAt: now });
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
