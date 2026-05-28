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
  // #802: abandon cap is opt-in; default unbounded so hard instances retry
  // indefinitely. A launcher may still set a finite ceiling in the manifest.
  N_max_postings_per_task: Infinity,
  posting_window_ms: 24 * 60 * 60 * 1000, // on-chain claim-window deadline only (AC#5)
  post_batch_size: 25,
  claimLeaseTtlSeconds: 60 * 60,
};

export type SweRebenchV2PoolCountKind =
  | 'unposted'
  | 'live'
  | 'repostable'
  | 'saturated';

export interface SweRebenchV2PoolCounts {
  poolSize: number;
  posted: number;
  unposted: number;
  live: number;
  repostable: number;
  saturated: number;
}

/** Per-instance on-chain claim-budget snapshot, keyed by instance_id, derived
 *  by the generator from DiscoveryAPI.getInstanceClaimCounts joined on the
 *  instance's last_task_id (#802). */
export interface InstanceClaimSnapshot {
  consumed: number;
  maxClaims: number;
}

export interface SelectArgs {
  pool: PoolTask[];
  counters: Map<string, TaskCounters>;
  config: GeneratorConfig;
  now: number;
  /** Per-instance claim-budget snapshot (#802). Absent entry ⇒ no live posting
   *  observed on-chain for that instance. */
  claimCounts?: Map<string, InstanceClaimSnapshot>;
  /** Language of the most-recently-posted task; used to bias toward a different
   *  language for round-robin balancing. */
  lastPostedLanguage?: string;
}

export function classifyPoolTask(
  counters: TaskCounters,
  config: GeneratorConfig,
  claim: InstanceClaimSnapshot | undefined,
): SweRebenchV2PoolCountKind {
  // saturated is the first branch and is unchanged (AC#2).
  if (counters.successful >= config.N_target_successes) return 'saturated';
  // Never posted ⇒ unposted.
  if (counters.posted === 0 || !counters.last_task_id) return 'unposted';
  // Posted, but the indexer shows no live posting for its last_task_id (the
  // task left the claimable set — finalized/refunded/exhausted). Repost.
  if (!claim) return 'repostable';
  // Live while the on-chain claim budget has slots left; exhausted ⇒ repostable.
  return claim.consumed >= claim.maxClaims ? 'repostable' : 'live';
}

export function summarizePoolState(args: SelectArgs): SweRebenchV2PoolCounts {
  const counts: SweRebenchV2PoolCounts = {
    poolSize: args.pool.length,
    posted: 0,
    unposted: 0,
    live: 0,
    repostable: 0,
    saturated: 0,
  };
  for (const task of args.pool) {
    const counters =
      args.counters.get(task.instance_id) ??
      { posted: 0, successful: 0, last_posted_at: 0 };
    const claim = counters.last_task_id
      ? args.claimCounts?.get(counters.last_task_id)
      : undefined;
    counts[classifyPoolTask(counters, args.config, claim)] += 1;
  }
  return counts;
}

/**
 * Choose up to post_batch_size eligible tasks to post on JinnRouter.
 *
 * Eligibility (#802):
 *   - successful_count[task] < N_target_successes (else saturated)
 *   - the instance has no live on-chain posting: either unposted, or its
 *     last posting's claim budget is exhausted (consumed >= maxClaims) or has
 *     left the claimable set.
 *
 * Among eligible tasks, prefer a different language than the last-posted one.
 * Tie-break by lower posted_count, then earliest last_posted_at, then
 * instance_id (deterministic).
 */
export function selectNextPostingCandidates(args: SelectArgs): PoolTask[] {
  const claimFor = (instanceId: string): InstanceClaimSnapshot | undefined => {
    const tid = args.counters.get(instanceId)?.last_task_id;
    return tid ? args.claimCounts?.get(tid) : undefined;
  };
  const eligible = args.pool.filter((task) => {
    const c =
      args.counters.get(task.instance_id) ??
      { posted: 0, successful: 0, last_posted_at: 0 };
    const kind = classifyPoolTask(c, args.config, claimFor(task.instance_id));
    return kind === 'unposted' || kind === 'repostable';
  });
  if (eligible.length === 0) return [];

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

  // De-dupe instance_ids within the batch (a pool may list an instance twice);
  // each instance gets at most one posting per tick. No abandon cap (#802).
  const seenInstance = new Set<string>();
  const selected: PoolTask[] = [];
  for (const candidate of candidates) {
    if (selected.length >= args.config.post_batch_size) break;
    if (seenInstance.has(candidate.instance_id)) continue;
    seenInstance.add(candidate.instance_id);
    selected.push(candidate);
  }
  return selected;
}

export function selectNextPostingCandidate(args: SelectArgs): PoolTask | undefined {
  return selectNextPostingCandidates({ ...args, config: { ...args.config, post_batch_size: 1 } })[0];
}
