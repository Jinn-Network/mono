/**
 * Task generator for the swe-rebench-v2.v1 SolverNet. Implements the
 * full-historical-pool + post-until-target-successes policy from DR-i.
 *
 * Spec: docs/superpowers/specs/2026-05-06-agent-harness-solvernet-design.md §3.6
 * DR: log/decisions/2026-05-06-task-generator-success-cap.md (P5)
 */

import type { PoolTask } from './_swe-rebench-v2-pool.js';
import type { TaskCounters } from './_swe-rebench-v2-state.js';

export interface GeneratorConfig {
  N_target_successes: number;
  N_max_postings_per_task: number;
  cooldown_ms: number;
}

export const DEFAULT_GENERATOR_CONFIG: GeneratorConfig = {
  N_target_successes: 3,
  N_max_postings_per_task: 10,
  cooldown_ms: 24 * 60 * 60 * 1000,
};

export interface SelectArgs {
  pool: PoolTask[];
  counters: Map<string, TaskCounters>;
  config: GeneratorConfig;
  now: number;
  /** Language of the most-recently-posted task; used to bias toward a different
   *  language for round-robin balancing. */
  lastPostedLanguage?: string;
}

/**
 * Choose the next eligible task to post on JinnRouter, or undefined if no
 * task is currently eligible (all saturated, in cooldown, or capped).
 *
 * Eligibility filter:
 *   - successful_count[task] < N_target_successes
 *   - posted_count[task] < N_max_postings_per_task
 *   - now - last_posted_at[task] >= cooldown_ms
 *
 * Among eligible tasks, prefer a different language than the last-posted one
 * (simple round-robin balance). Tie-break by lower posted_count, then by
 * earliest last_posted_at, then by instance_id (deterministic).
 */
export function selectNextPostingCandidate(args: SelectArgs): PoolTask | undefined {
  const eligible = args.pool.filter((task) => {
    const c = args.counters.get(task.instance_id) ?? { posted: 0, successful: 0, last_posted_at: 0 };
    if (c.successful >= args.config.N_target_successes) return false;
    if (c.posted >= args.config.N_max_postings_per_task) return false;
    // Tasks with last_posted_at=0 have never been posted, so skip cooldown check
    if (c.last_posted_at > 0 && args.now - c.last_posted_at < args.config.cooldown_ms) return false;
    return true;
  });
  if (eligible.length === 0) return undefined;

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
  return candidates[0];
}
