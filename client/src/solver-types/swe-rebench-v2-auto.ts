/**
 * Task generator policy for the swe-rebench-v2.v1 SolverNet. Implements the
 * fill-the-pool + target-success claim cap policy from DR-2026-05-22-a.
 *
 * Spec: docs/superpowers/specs/2026-05-06-agent-harness-solvernet-design.md §3.6
 * DR: log/decisions/2026-05-22-swe-rebench-v2-generation-claiming-semantics.md
 */

import type { PoolTask } from './_swe-rebench-v2-pool.js';
import type { TaskCounters } from './_swe-rebench-v2-state.js';
import type { AdmissionMode } from './_swe-rebench-v2-validated-pool.js';

export interface GeneratorConfig {
  N_target_successes: number;
  N_max_postings_per_task: number;
  posting_window_ms: number;
  post_batch_size: number;
  maxClaimsPerOperator?: number;
  claimLeaseTtlSeconds: number;
  /** Controls pool filtering before posting. 'required' (default) blocks if no
   *  validation data exists; 'python-floor' falls back to Python-only subset.
   *  Set to 'python-floor' for local dev before running `jinn solver-nets
   *  validate-pool swe-rebench-v2 --seed-positive`. */
  admissionMode?: AdmissionMode;
}

export const DEFAULT_GENERATOR_CONFIG: GeneratorConfig = {
  N_target_successes: 5,
  N_max_postings_per_task: 10,
  posting_window_ms: 24 * 60 * 60 * 1000,
  post_batch_size: 25,
  claimLeaseTtlSeconds: 60 * 60,
};

export type SweRebenchV2PoolCountKind =
  | 'unposted'
  | 'live'
  | 'repostable'
  | 'saturated'
  | 'abandoned';

export interface SweRebenchV2PoolCounts {
  poolSize: number;
  posted: number;
  unposted: number;
  live: number;
  repostable: number;
  saturated: number;
  abandoned: number;
}

export interface SelectArgs {
  pool: PoolTask[];
  counters: Map<string, TaskCounters>;
  config: GeneratorConfig;
  now: number;
  /** Language of the most-recently-posted task; used to bias toward a different
   *  language for round-robin balancing. */
  lastPostedLanguage?: string;
}

export function classifyPoolTask(
  counters: TaskCounters,
  config: GeneratorConfig,
  now: number,
): SweRebenchV2PoolCountKind {
  if (counters.successful >= config.N_target_successes) return 'saturated';
  if (counters.posted >= config.N_max_postings_per_task) return 'abandoned';
  if (counters.posted === 0 || counters.last_posted_at === 0) return 'unposted';
  return now - counters.last_posted_at >= config.posting_window_ms ? 'repostable' : 'live';
}

export function summarizePoolState(args: SelectArgs): SweRebenchV2PoolCounts {
  const counts: SweRebenchV2PoolCounts = {
    poolSize: args.pool.length,
    posted: 0,
    unposted: 0,
    live: 0,
    repostable: 0,
    saturated: 0,
    abandoned: 0,
  };
  for (const task of args.pool) {
    const counters =
      args.counters.get(task.instance_id) ??
      { posted: 0, successful: 0, last_posted_at: 0 };
    counts[classifyPoolTask(counters, args.config, args.now)] += 1;
  }
  return counts;
}

/**
 * Choose up to post_batch_size eligible tasks to post on JinnRouter.
 *
 * Eligibility filter:
 *   - successful_count[task] < N_target_successes
 *   - posted_count[task] < N_max_postings_per_task
 *   - no live posting within posting_window_ms
 *
 * Among eligible tasks, prefer a different language than the last-posted one
 * (simple round-robin balance). Tie-break by lower posted_count, then by
 * earliest last_posted_at, then by instance_id (deterministic).
 */
export function selectNextPostingCandidates(args: SelectArgs): PoolTask[] {
  const eligible = args.pool.filter((task) => {
    const c =
      args.counters.get(task.instance_id) ??
      { posted: 0, successful: 0, last_posted_at: 0 };
    const kind = classifyPoolTask(c, args.config, args.now);
    return kind === 'unposted' || kind === 'repostable';
  });
  if (eligible.length === 0) return [];

  // Round-robin language preference
  const differentLanguage = args.lastPostedLanguage
    ? eligible.filter((t) => t.language !== args.lastPostedLanguage)
    : eligible;
  const candidates = differentLanguage.length > 0 ? differentLanguage : eligible;

  candidates.sort((a, b) => {
    const cA = args.counters.get(a.instance_id) ?? { posted: 0, successful: 0, last_posted_at: 0 };
    const cB = args.counters.get(b.instance_id) ?? { posted: 0, successful: 0, last_posted_at: 0 };
    if (cA.posted !== cB.posted) return cA.posted - cB.posted;
    if (cA.last_posted_at !== cB.last_posted_at) return cA.last_posted_at - cB.last_posted_at;
    return a.instance_id.localeCompare(b.instance_id);
  });
  const inBatchCounters = new Map<string, number>();
  const selected: PoolTask[] = [];
  for (const candidate of candidates) {
    if (selected.length >= args.config.post_batch_size) break;
    const persisted = args.counters.get(candidate.instance_id)?.posted ?? 0;
    const inBatch = inBatchCounters.get(candidate.instance_id) ?? 0;
    if (persisted + inBatch >= args.config.N_max_postings_per_task) continue;
    inBatchCounters.set(candidate.instance_id, inBatch + 1);
    selected.push(candidate);
  }
  return selected;
}

export function selectNextPostingCandidate(args: SelectArgs): PoolTask | undefined {
  return selectNextPostingCandidates({ ...args, config: { ...args.config, post_batch_size: 1 } })[0];
}
