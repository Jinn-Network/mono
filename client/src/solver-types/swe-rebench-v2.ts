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
import { SweRebenchV2TaskSchema } from '@jinn-network/sdk/solvernets/swe-rebench-v2';
import type { Task } from '../types/task.js';
import type { SolverTypeDefinition } from './solver-type.js';
import {
  selectNextPostingCandidate,
  DEFAULT_GENERATOR_CONFIG,
  type GeneratorConfig,
} from './swe-rebench-v2-auto.js';
import { GeneratorStateStore } from './_swe-rebench-v2-state.js';
import {
  buildHistoricalPool,
  fetchHfSplit,
  listMonthlyPartitions,
  type PoolTask,
} from './_swe-rebench-v2-pool.js';

/** Config passed to buildGenerator — sourced from env or TestnetAutoContext. */
export interface SweRebenchV2AutoConfig {
  stateDir: string;
  generatorConfig?: GeneratorConfig;
}

const HF_DATASET = 'nebius/SWE-rebench-leaderboard';

/** How long the pool is cached before a full refresh (24 h). */
const POOL_REFRESH_MS = 24 * 60 * 60 * 1000;

/**
 * Build a TaskGenerator that wraps the full-historical-pool +
 * post-until-target-successes policy.
 */
function makeSweRebenchV2Generator(config: SweRebenchV2AutoConfig): () => Promise<Task | null> {
  const stateStore = new GeneratorStateStore({ stateDir: config.stateDir });
  const genConfig = config.generatorConfig ?? DEFAULT_GENERATOR_CONFIG;

  let pool: PoolTask[] = [];
  let poolLoadedAt = 0;
  let lastPostedLanguage: string | undefined;

  async function refreshPool(): Promise<void> {
    try {
      // Fetch available splits from the HF datasets-server
      const splitsUrl = `https://datasets-server.huggingface.co/splits?dataset=${encodeURIComponent(HF_DATASET)}`;
      const response = await fetch(splitsUrl);
      if (!response.ok) throw new Error(`HF splits fetch failed: ${response.status}`);
      const json = (await response.json()) as { splits?: Array<{ split: string }> };
      const splitNames = (json.splits ?? []).map((s) => s.split);
      const months = listMonthlyPartitions(splitNames);
      if (months.length === 0) return;

      pool = await buildHistoricalPool({
        months,
        fetchSplit: (split) =>
          fetchHfSplit({ dataset: HF_DATASET, split, limit: 100 }),
      });
      poolLoadedAt = Date.now();
    } catch (err) {
      // Non-fatal: keep the existing pool if already loaded
      console.warn(
        `[swe-rebench-v2-gen] pool refresh failed (using ${pool.length} cached tasks):`,
        err instanceof Error ? err.message : String(err),
      );
    }
  }

  return async (): Promise<Task | null> => {
    const now = Date.now();

    // Refresh pool if stale or empty
    if (pool.length === 0 || now - poolLoadedAt > POOL_REFRESH_MS) {
      await refreshPool();
    }
    if (pool.length === 0) return null;

    // Load all counters for eligible tasks
    const counters = new Map<string, { posted: number; successful: number; last_posted_at: number }>();
    for (const task of pool) {
      counters.set(task.instance_id, await stateStore.getCounters(task.instance_id));
    }

    const candidate = selectNextPostingCandidate({
      pool,
      counters,
      config: genConfig,
      now,
      lastPostedLanguage,
    });
    if (!candidate) return null;

    // Record the posting
    await stateStore.recordPosted(candidate.instance_id, now);
    lastPostedLanguage = candidate.language;

    // Build the Task
    const deadlineUnix = Math.floor((now + 7 * 24 * 60 * 60 * 1000) / 1000); // 7-day window
    const roundMonth = new Date(now).toISOString().slice(0, 7); // YYYY-MM
    const windowEndTs = deadlineUnix * 1000;

    const spec: Record<string, unknown> = {
      schemaVersion: 'swe-rebench-v2.v1',
      instance_id: candidate.instance_id,
      repo: `${candidate.instance_id.split('__')[0]}/${candidate.instance_id.split('__')[1]?.split('-')[0] ?? candidate.instance_id}`,
      base_commit: '0000000000000000000000000000000000000000',
      language: candidate.language ?? 'python',
      problem_statement: `SWE-rebench v2 instance: ${candidate.instance_id}`,
      interface: '',
      hf_dataset: candidate.hf_dataset,
      hf_split: candidate.hf_split,
      deadline_unix: deadlineUnix,
      round_month: roundMonth,
    };

    const task: Task = {
      id: randomUUID(),
      description: `SWE-rebench v2: ${candidate.instance_id}`,
      solverType: 'swe-rebench-v2.v1',
      role: 'restoration',
      window: {
        startTs: now,
        endTs: windowEndTs,
      },
      spec,
    };

    return task;
  };
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
      join(process.env['HOME'] ?? homedir(), '.jinn-client', 'swe-rebench-v2');
    return { stateDir };
  },
  ui: {
    description: 'SWE-rebench v2 coding benchmark (HuggingFace dataset)',
    category: 'code',
  },
};

/**
 * Accessor for the GeneratorStateStore used by the delivery-watcher verdict hook.
 * Returns a store rooted at the same default stateDir as the generator.
 */
export function getSweRebenchV2StateStore(stateDir?: string): GeneratorStateStore {
  const dir =
    stateDir ??
    process.env['JINN_SWE_REBENCH_V2_STATE_DIR'] ??
    join(process.env['HOME'] ?? homedir(), '.jinn-client', 'swe-rebench-v2');
  return new GeneratorStateStore({ stateDir: dir });
}
