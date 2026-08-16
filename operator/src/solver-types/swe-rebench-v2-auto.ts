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
import { contestedBandDistance, solveRate } from './_swe-rebench-v2-guards.js';

export interface GeneratorConfig {
  N_target_successes: number;
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
  // #802: the repost trigger is claim-budget exhaustion (indexer-observed), not
  // a posting count. The former N_max_postings_per_task abandon cap is removed —
  // hard instances retry indefinitely until they reach N successes.
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
  /** Instance ids failing discrimination (weak-suite) — excluded from targeting. */
  discriminationFails?: Set<string>;
  /** Per-instance solve stats for contested-band ordering (attempts = posted count proxy). */
  instanceSolveStats?: Map<string, { passed: number; attempts: number }>;
  /** Tag synthetic (minted) pool rows for quota enforcement. */
  syntheticInstanceIds?: Set<string>;
  /** Mint families halted by informative-band stop (§7). */
  haltedMintFamilies?: Set<string>;
  /** instance_id → mintFamily for synthetic rows. */
  mintFamilyByInstance?: Map<string, string>;
}

export function classifyPoolTask(
  counters: TaskCounters,
  config: GeneratorConfig,
  claim: InstanceClaimSnapshot | undefined,
  now: number,
): SweRebenchV2PoolCountKind {
  // saturated is the first branch and is unchanged (AC#2).
  if (counters.successful >= config.N_target_successes) return 'saturated';
  // Never posted ⇒ unposted.
  if (counters.posted === 0 || !counters.last_task_id) return 'unposted';
  // #826/#850 deadlock fix: the on-chain claim window (last_posted_at +
  // posting_window_ms) closes independently of budget consumption. Once it
  // passes, TaskCoordinator.claimTask reverts TCClaimWindowClosed
  // (contracts/src/tasks/TaskCoordinator.sol:328) — the remaining slots are
  // permanently unclaimable, so the exhaustion trigger below can never fire and
  // the posting would strand `live` forever. Window expiry is NOT an on-chain
  // event or state change (no event, no flag), so it must be computed locally.
  // Repost on EITHER exhaustion OR expiry.
  const windowExpired = now - counters.last_posted_at >= config.posting_window_ms;
  // Posted, but the claim snapshot has no entry for this last_task_id. The
  // indexer never deletes task rows (finalized/refunded are flags, and the
  // leg-1 query carries no lifecycle filter, so a finalized/refunded task is
  // still present with consumed >= maxClaims ⇒ classified repostable below).
  // The usual cause of a missing entry for a known last_task_id is indexing lag
  // (or a reorg): the task was posted on-chain but the indexer has not reflected
  // it yet. Treat it as `live` (assume not-yet-indexed) — returning `repostable`
  // here would re-post a just-posted task before the indexer sees it
  // (double-post, #802 #3), and in onchain mode — where getInstanceClaimCounts
  // is an empty-success floor — would storm every posting every tick (#802 #2).
  // BUT if the posting window has already elapsed, the post is definitively dead
  // (claims can no longer land) and must be reposted regardless of the snapshot.
  if (!claim) return windowExpired ? 'repostable' : 'live';
  // Live while the on-chain claim budget has slots left AND the window is open;
  // exhausted OR window-expired ⇒ repostable.
  return claim.consumed >= claim.maxClaims || windowExpired ? 'repostable' : 'live';
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
    counts[classifyPoolTask(counters, args.config, claim, args.now)] += 1;
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
    if (args.discriminationFails?.has(task.instance_id)) return false;
    const family = args.mintFamilyByInstance?.get(task.instance_id);
    if (family && args.haltedMintFamilies?.has(family)) return false;
    const c =
      args.counters.get(task.instance_id) ??
      { posted: 0, successful: 0, last_posted_at: 0 };
    const kind = classifyPoolTask(c, args.config, claimFor(task.instance_id), args.now);
    return kind === 'unposted' || kind === 'repostable';
  });
  if (eligible.length === 0) return [];

  const differentLanguage = args.lastPostedLanguage
    ? eligible.filter((t) => t.language !== args.lastPostedLanguage)
    : eligible;
  const candidates = differentLanguage.length > 0 ? differentLanguage : eligible;

  candidates.sort((a, b) => {
    const statsA = args.instanceSolveStats?.get(a.instance_id);
    const statsB = args.instanceSolveStats?.get(b.instance_id);
    if (statsA && statsB && statsA.attempts > 0 && statsB.attempts > 0) {
      const distA = contestedBandDistance(solveRate(statsA.passed, statsA.attempts));
      const distB = contestedBandDistance(solveRate(statsB.passed, statsB.attempts));
      if (distA !== distB) return distA - distB;
    }
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

  const withSynthetic = selected.map((t) => ({
    task: t,
    synthetic: args.syntheticInstanceIds?.has(t.instance_id) ?? false,
  }));
  const quotaApplied = applySyntheticQuotaFromTagged(withSynthetic, args.config.post_batch_size);
  return quotaApplied.map((x) => x.task);
}

function applySyntheticQuotaFromTagged<T extends { synthetic?: boolean }>(
  selected: T[],
  batchSize: number,
): T[] {
  const maxSynthetic = Math.floor(batchSize * 0.25);
  let syntheticCount = 0;
  const out: T[] = [];
  for (const item of selected) {
    if (item.synthetic) {
      if (syntheticCount >= maxSynthetic) continue;
      syntheticCount += 1;
    }
    out.push(item);
    if (out.length >= batchSize) break;
  }
  return out;
}

export function selectNextPostingCandidate(args: SelectArgs): PoolTask | undefined {
  return selectNextPostingCandidates({ ...args, config: { ...args.config, post_batch_size: 1 } })[0];
}
