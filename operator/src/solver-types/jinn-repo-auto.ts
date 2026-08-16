/**
 * jinn-repo.v1 train-stream generator (G4).
 *
 * Posts the TRAIN split of the local jinn-repo pool: the admitted pool MINUS
 * the held-out slate. One restoration Task per not-yet-saturated train
 * instance, capped per tick, with posted-counts persisted across restarts.
 *
 * The pool is a small LOCAL JSON file (`_jinn-repo-pool.ts`), so this is
 * deliberately minimal — no HuggingFace fetch, no pool cache, no network
 * recovery. Contrast `swe-rebench-v2.ts`, whose generator carries that
 * machinery because its pool is remote.
 *
 * Leak control: the emitted Task `spec` is `solverView(item)` ONLY — never the
 * pool item's `gold_tests` / `solution_patch` / `test_files` / `test_cmd`.
 *
 * ── Local train-feed recipe (no on-chain launch) ──────────────────────────────
 * To feed Stage-1 training locally without launching a SolverNet on-chain:
 *   1. Build tasks with a LOCAL `solverNetManifestCid` (any stable string, e.g.
 *      `local-jinn-repo`): `makeJinnRepoGenerator({ stateDir, poolPath,
 *      solverNetManifestCid: 'local-jinn-repo' })`.
 *   2. Add a matching operator config entry so the daemon claims them:
 *      `joinedSolverNets['local-jinn-repo'] = { name: 'jinn-repo-local',
 *      manifestCid: 'local-jinn-repo', roles: ['solver', 'evaluator'],
 *      harness: ..., plugins: [], model: ... }`.
 *   3. Settle via the local/Anvil adapter (no mech, no real funds).
 * Point `poolPath` at any custom pool JSON to feed a bespoke instance set.
 */

import { randomUUID } from 'node:crypto';
import { readFile, writeFile, mkdir, rename } from 'node:fs/promises';
import { join } from 'node:path';
import { getSolverNetContract } from '@jinn-network/sdk/solvernets';
import type { TaskGenerator } from './solver-type.js';
import type { Task } from '../types/task.js';
import type { TaskClaimPolicy } from '../types/task-document.js';
import type { LaunchedSolverNetRecord } from '../solvernets/store.js';
import {
  loadJinnRepoPool,
  solverView,
  type JinnRepoPoolItem,
} from './_jinn-repo-pool.js';
import { resolvePostingWindowMs } from './_jinn-repo-posting-window.js';
import { loadHeldOutSlate } from './_swe-rebench-v2-held-out-slate.js';

const SOLVER_TYPE = 'jinn-repo.v1';
const CONTRACT_ID = 'jinn-repo';
const CONTRACT_VERSION = 'v1';

const DEFAULT_MAX_PER_TICK = 5;
const DEFAULT_TARGET_SUCCESSES_PER_INSTANCE = 1;

const STATE_SCHEMA_VERSION = 'jinn-repo-generator-state.v1' as const;

export interface JinnRepoGeneratorConfig {
  stateDir: string;
  solverNetManifestCid?: string;
  /** Override the local pool file location (defaults to the shipped pool). */
  poolPath?: string;
  /** Held-out slate version to exclude from the train split (default `v1`). */
  slateVersion?: string;
  /** Override the slate directory (tests inject a temp dir). */
  slateDir?: string;
  /** Max tasks emitted per tick (default 5). */
  maxPerTick?: number;
  /** Post each instance until it has this many recorded postings (default 1). */
  targetSuccessesPerInstance?: number;
  /** Inject the pool directly (tests); bypasses `poolPath`. */
  loadPool?: () => JinnRepoPoolItem[];
  /** Solve / posting window duration in ms (default: six hours). */
  postingWindowMs?: number;
}

interface PostedCounters {
  posted: number;
}

interface StateFile {
  schemaVersion: typeof STATE_SCHEMA_VERSION;
  instances: Record<string, PostedCounters>;
}

function stateFilePath(stateDir: string): string {
  return join(stateDir, 'jinn-repo-generator-state.json');
}

async function readState(stateDir: string): Promise<StateFile> {
  try {
    const raw = await readFile(stateFilePath(stateDir), 'utf8');
    const parsed = JSON.parse(raw) as StateFile;
    if (parsed && typeof parsed === 'object' && parsed.instances) return parsed;
  } catch {
    // absent or unreadable — start empty
  }
  return { schemaVersion: STATE_SCHEMA_VERSION, instances: {} };
}

async function writeStateAtomic(stateDir: string, state: StateFile): Promise<void> {
  await mkdir(stateDir, { recursive: true });
  const target = stateFilePath(stateDir);
  const tmp = `${target}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(tmp, JSON.stringify(state, null, 2));
  await rename(tmp, target);
}

/**
 * Train-split exclusion. If no slate has been shipped, `loadHeldOutSlate`
 * throws — treat the held-out set as EMPTY (train split = whole pool) and warn
 * once. Never crash the generator on a missing slate.
 */
function trainSplit(
  pool: JinnRepoPoolItem[],
  opts: { slateVersion: string; slateDir?: string },
  warnedRef: { slate: boolean },
): JinnRepoPoolItem[] {
  let excluded: Set<string>;
  try {
    excluded = loadHeldOutSlate(SOLVER_TYPE, opts.slateVersion, { dir: opts.slateDir }).instanceIds;
  } catch (err) {
    if (!warnedRef.slate) {
      warnedRef.slate = true;
      console.warn(
        `[jinn-repo-gen] no held-out slate (${SOLVER_TYPE} ${opts.slateVersion}) — ` +
          `train split = whole pool: ${(err as Error).message}`,
      );
    }
    return pool;
  }
  if (excluded.size === 0) return pool;
  return pool.filter((item) => !excluded.has(item.instance_id));
}

function jinnRepoClaimPolicy(): TaskClaimPolicy {
  const contract = getSolverNetContract({ id: CONTRACT_ID, version: CONTRACT_VERSION });
  const defaults = contract?.claimPolicyDefaults;
  return {
    mode: defaults?.mode === 'serial' ? 'exclusive' : 'parallel',
    maxClaims: defaults?.maxClaims ?? 5,
    maxClaimsPerOperator: defaults?.maxClaimsPerOperator ?? 5,
    claimLeaseTtlSeconds: defaults?.claimLeaseTtlSeconds ?? 60 * 60,
  };
}

export function makeJinnRepoGenerator(config: JinnRepoGeneratorConfig): TaskGenerator {
  const maxPerTick = config.maxPerTick ?? DEFAULT_MAX_PER_TICK;
  const target = config.targetSuccessesPerInstance ?? DEFAULT_TARGET_SUCCESSES_PER_INSTANCE;
  const slateVersion = config.slateVersion ?? 'v1';
  const postingWindowMs = resolvePostingWindowMs(config.postingWindowMs);
  const warnedRef = { slate: false };
  const claimPolicy = jinnRepoClaimPolicy();

  return async (): Promise<Task[] | null> => {
    const pool = config.loadPool
      ? config.loadPool()
      : loadJinnRepoPool({ path: config.poolPath });

    const train = trainSplit(pool, { slateVersion, slateDir: config.slateDir }, warnedRef);

    const state = await readState(config.stateDir);
    const candidates = train.filter(
      (item) => (state.instances[item.instance_id]?.posted ?? 0) < target,
    );
    if (candidates.length === 0) return null;

    const selected = candidates.slice(0, maxPerTick);
    const now = Date.now();
    const windowEndTs = now + postingWindowMs;

    const tasks: Task[] = selected.map((item) => ({
      id: randomUUID(),
      description: `Jinn repo task ${item.instance_id} (PR #${item.merged_pr})`,
      solverType: SOLVER_TYPE,
      contractId: CONTRACT_ID,
      contractVersion: CONTRACT_VERSION,
      ...(config.solverNetManifestCid
        ? { solverNetManifestCid: config.solverNetManifestCid }
        : {}),
      role: 'restoration',
      window: { startTs: now, endTs: windowEndTs },
      claimPolicy,
      spec: solverView(item) as unknown as Record<string, unknown>,
      eligibility: { instance_id: item.instance_id },
    }));

    for (const item of selected) {
      const prev = state.instances[item.instance_id]?.posted ?? 0;
      state.instances[item.instance_id] = { posted: prev + 1 };
    }
    await writeStateAtomic(config.stateDir, state);

    return tasks.length > 0 ? tasks : null;
  };
}

export interface MakeJinnRepoGeneratorForLaunchedRecordOpts {
  recordRef: { current: LaunchedSolverNetRecord };
  staticConfig?: {
    stateDir?: string;
    poolPath?: string;
    slateVersion?: string;
    maxPerTick?: number;
    targetSuccessesPerInstance?: number;
    postingWindowMs?: number;
  };
}

function defaultStateDir(): string {
  const stateRoot = process.env['JINN_STATE_DIR'];
  if (stateRoot) return join(stateRoot, 'jinn-repo');
  return join(process.env['HOME'] ?? '', '.jinn-client', 'jinn-repo');
}

export function makeJinnRepoGeneratorForLaunchedRecord(
  opts: MakeJinnRepoGeneratorForLaunchedRecordOpts,
): TaskGenerator {
  const { recordRef, staticConfig = {} } = opts;
  const stateDir =
    staticConfig.stateDir ?? process.env['JINN_JINN_REPO_STATE_DIR'] ?? defaultStateDir();

  const postingWindowMs = resolvePostingWindowMs(
    staticConfig.postingWindowMs ??
      recordRef.current.generatorConfig?.['posting_window_ms'],
  );

  const generator = makeJinnRepoGenerator({
    stateDir,
    solverNetManifestCid: recordRef.current.manifestCid,
    poolPath: staticConfig.poolPath,
    slateVersion: staticConfig.slateVersion,
    maxPerTick: staticConfig.maxPerTick,
    targetSuccessesPerInstance: staticConfig.targetSuccessesPerInstance,
    postingWindowMs,
  });

  return async (): Promise<Task | Task[] | null> => {
    const record = recordRef.current;
    if (record.status !== 'launched') return null;
    if (!record.generatorEnabled) return null;
    return generator();
  };
}
