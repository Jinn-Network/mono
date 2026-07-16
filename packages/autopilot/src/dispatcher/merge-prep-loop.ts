import type { DispatcherConfig, InFlightMergePrep } from './types.js';
import type { StuckPr } from './merge-sweep.js';

/** Max prep dispatches per PR across DIFFERENT heads before escalating — bounds
 *  the pathological case where each resolution re-conflicts as `next` advances. */
export const MAX_PREP_ATTEMPTS = 2;

/** A merge-<N> worktree older than this is reaped (freeing the cap). Doubles as
 *  the effective session wall-clock. Detached ⇒ reaping loses no branch ref;
 *  pushed work is already on origin. */
export const MERGE_PREP_REAP_MS = 2 * 60 * 60 * 1000;

/** Per-process record of a prep dispatch, keyed by PR number. */
export interface PrepAttempt {
  /** The PR head oid we last dispatched a prep session for. */
  headOid: string;
  /** How many prep sessions we've dispatched for this PR (across heads). */
  attempts: number;
}

export interface MergePrepCycleReport {
  dispatched: number[];
  escalated: number[];
  waiting: number[];
  reaped: number[];
  skippedForCap: number;
  /** PRs whose handling threw this cycle (isolated — the others still ran). */
  failed: number[];
}

export interface MergePrepCycleDeps {
  /** The sweep's stuck report this cycle. */
  stuck: StuckPr[];
  cfg: DispatcherConfig;
  /** Per-process attempt tracking (mirrors `attemptedUpdateBranch` — owned by
   *  the orchestrator across cycles, lost on restart). */
  attemptedPrep: Map<number, PrepAttempt>;
  /** PR numbers with a live review session — never prep under an active
   *  reviewer (they push to the same branch). */
  reviewInFlight: ReadonlySet<number>;
  /** Live merge-prep worktrees (for cap accounting + reaping). */
  deriveInFlight(): Promise<{ inFlight: InFlightMergePrep[] }>;
  /** Spawn a prep session for one stuck PR. */
  dispatch(s: StuckPr): Promise<InFlightMergePrep>;
  /** Escalate a PR to a human (label + Blocked-on:Human + comment). `why` is logged. */
  escalate(s: StuckPr, why: string): Promise<void>;
  /** True if the PR touches a code-owned path (fail-safe true). */
  isCodeOwned(prNumber: number): Promise<boolean>;
  /** Remove a stale merge-prep worktree. */
  removeWorktree(w: InFlightMergePrep): Promise<void>;
  /** Injectable clock (defaults to Date.now). */
  now?(): number;
}

/**
 * One tick of the merge-prep loop. Pure policy over injected I/O (mirrors
 * `runReviewCycle`). Order:
 *   1. Reap stale `merge-<N>` worktrees → free the cap.
 *   2. Per stuck PR (FIFO by number):
 *      - already escalated (review:needs-human) → skip (a human owns it),
 *      - in-flight prep OR live review on the PR → wait (no double-dispatch,
 *        no racing an active reviewer),
 *      - code-owned → escalate (the sweep can never merge it anyway; never
 *        force-push under active human work),
 *      - same head already attempted → escalate (the session died or pushed
 *        nothing — a rerun repeats the failure),
 *      - ≥MAX attempts across advancing heads → escalate,
 *      - else dispatch within the `mergePrepCap − inFlight` budget.
 */
export async function runMergePrepCycle(deps: MergePrepCycleDeps): Promise<MergePrepCycleReport> {
  const { stuck, cfg, attemptedPrep, reviewInFlight, deriveInFlight, dispatch, escalate, isCodeOwned, removeWorktree } = deps;
  const now = deps.now ?? (() => Date.now());
  const report: MergePrepCycleReport = { dispatched: [], escalated: [], waiting: [], reaped: [], skippedForCap: 0, failed: [] };

  // 1. Reap stale worktrees before computing the budget. A failed removal is
  //    isolated — the worktree stays counted against the cap, never aborts.
  const { inFlight } = await deriveInFlight();
  const live: InFlightMergePrep[] = [];
  for (const w of inFlight) {
    if (w.startedAt > 0 && now() - w.startedAt > MERGE_PREP_REAP_MS) {
      try {
        await removeWorktree(w);
        report.reaped.push(w.prNumber);
      } catch (err) {
        console.error(`[merge-prep] reap failed for #${w.prNumber} (keeping it live):`, err);
        live.push(w);
      }
    } else {
      live.push(w);
    }
  }

  const inFlightSet = new Set<number>(live.map((w) => w.prNumber));
  let budget = Math.max(0, cfg.mergePrepCap - live.length);

  // 2. FIFO by PR number for determinism. Each PR is isolated: a throw from
  //    isCodeOwned/escalate/dispatch drops that PR to `failed` and the rest of
  //    the stuck set still runs (mirrors Stage A's escalateStuckPrs).
  const ordered = [...stuck].sort((a, b) => a.number - b.number);
  for (const s of ordered) {
    if (s.escalated) continue; // a human owns it
    if (inFlightSet.has(s.number) || reviewInFlight.has(s.number)) {
      report.waiting.push(s.number);
      continue;
    }
    try {
      if (await isCodeOwned(s.number)) {
        await escalate(s, 'touches a code-owned path — a human resolves and merges it');
        report.escalated.push(s.number);
        continue;
      }
      const prev = attemptedPrep.get(s.number);
      if (prev != null && prev.headOid === s.headRefOid) {
        await escalate(s, 'merge-prep already ran on this exact head and it is still stuck');
        report.escalated.push(s.number);
        continue;
      }
      if (prev != null && prev.attempts >= MAX_PREP_ATTEMPTS) {
        await escalate(s, `merge-prep hit the attempt ceiling (${MAX_PREP_ATTEMPTS}) across advancing heads`);
        report.escalated.push(s.number);
        continue;
      }
      if (budget <= 0) {
        report.skippedForCap += 1;
        continue;
      }
      await dispatch(s);
      attemptedPrep.set(s.number, { headOid: s.headRefOid, attempts: (prev?.attempts ?? 0) + 1 });
      report.dispatched.push(s.number);
      budget -= 1;
    } catch (err) {
      console.error(`[merge-prep] handling PR #${s.number} threw (continuing):`, err);
      report.failed.push(s.number);
    }
  }

  return report;
}
