import type { PoolTask } from '../solver-types/_swe-rebench-v2-pool.js';

/** Stratification / diversity key: the org prefix of an instance_id
 *  (`tobymao__sqlglot-4661` → `tobymao`). Derivable without an HF fetch. */
export function repoOf(task: PoolTask): string {
  const idx = task.instance_id.indexOf('__');
  return idx === -1 ? task.instance_id : task.instance_id.slice(0, idx);
}

/**
 * Order candidates round-robin across repos so the first N base-fails span
 * repos rather than clumping in alphabetically-early ones. Deterministic:
 * instances sort by instance_id within each repo group; repo groups iterate in
 * sorted repo order.
 */
export function stratifyByRepo(pool: PoolTask[]): PoolTask[] {
  const groups = new Map<string, PoolTask[]>();
  for (const task of pool) {
    const repo = repoOf(task);
    (groups.get(repo) ?? groups.set(repo, []).get(repo)!).push(task);
  }
  const repos = [...groups.keys()].sort((a, b) => a.localeCompare(b));
  for (const repo of repos) {
    groups.get(repo)!.sort((a, b) => a.instance_id.localeCompare(b.instance_id));
  }
  const out: PoolTask[] = [];
  let added = true;
  for (let i = 0; added; i++) {
    added = false;
    for (const repo of repos) {
      const g = groups.get(repo)!;
      if (i < g.length) {
        out.push(g[i]!);
        added = true;
      }
    }
  }
  return out;
}

/** One frozen run's grade outcome. `null` = unscorable (Docker/grader/infra failure). */
export interface ScreenCandidateRun {
  passed: boolean | null;
}

export interface ScreenDeps {
  /** Confirm gradeable at the current semantics version (idempotent; cheap/cached). */
  ensureGradeable(task: PoolTask): Promise<boolean>;
  /** Base Haiku, frozen, empty impl-state. `passed: null` = unscorable. */
  runBaseFrozen(task: PoolTask): Promise<ScreenCandidateRun>;
  /** Prover (Codex/GPT-5.5), frozen, empty impl-state. `passed: null` = unscorable. */
  runProverFrozen(task: PoolTask): Promise<ScreenCandidateRun>;
  log?: (msg: string) => void;
}

export interface ScreenOpts {
  /** Base runs per candidate (≥3). A candidate is a reliable fail iff 0/R passed. */
  R: number;
  /** Exam cap N. */
  heldOutCount: number;
  /** Budget: stop after this many candidates reach the base-run stage. */
  maxCandidates: number;
  /** Max held-out instances per repo (diversity). */
  perRepoCap: number;
}

export type ScreenReason =
  | 'held-out' | 'not-gradeable' | 'base-passes' | 'base-unscorable' | 'no-headroom' | 'per-repo-cap';

export interface ScreenedCandidate {
  instance_id: string;
  repo: string;
  gradeable: boolean;
  baseRuns: number;
  basePasses: number;
  proverPassed: boolean | null; // null = not reached or unscorable
  heldOut: boolean;
  reason: ScreenReason;
}

export interface ScreenResult {
  heldOut: { instance_id: string; repo: string; baseRuns: number }[];
  screened: ScreenedCandidate[];
}

/**
 * Partition a candidate stream into the held-out exam vs the rest, applying the
 * three filter layers cheapest-first. `candidates` MUST already be ordered (use
 * {@link stratifyByRepo}); selection order is the iteration order and is frozen.
 */
export async function screenBaseFailures(
  candidates: PoolTask[],
  deps: ScreenDeps,
  opts: ScreenOpts,
): Promise<ScreenResult> {
  const log = deps.log ?? (() => {});
  const heldOut: ScreenResult['heldOut'] = [];
  const screened: ScreenedCandidate[] = [];
  const perRepo = new Map<string, number>();
  let baseScreened = 0;

  for (const task of candidates) {
    if (heldOut.length >= opts.heldOutCount) break;
    const repo = repoOf(task);
    const base = { instance_id: task.instance_id, repo, baseRuns: 0, basePasses: 0, proverPassed: null as boolean | null };

    if (!(await deps.ensureGradeable(task))) {
      screened.push({ ...base, gradeable: false, heldOut: false, reason: 'not-gradeable' });
      continue;
    }
    if (baseScreened >= opts.maxCandidates) break; // budget bounds expensive runs
    baseScreened++;

    // Layer 2: base Haiku × R, early-stop on the first pass.
    let basePasses = 0;
    let baseUnscorable = false;
    let r = 0;
    for (; r < opts.R; r++) {
      const run = await deps.runBaseFrozen(task);
      if (run.passed === null) { baseUnscorable = true; break; }
      if (run.passed) { basePasses++; break; }
    }
    const baseRuns = r + (baseUnscorable || basePasses > 0 ? 1 : 0);
    if (baseUnscorable) {
      screened.push({ ...base, baseRuns, gradeable: true, heldOut: false, reason: 'base-unscorable' });
      continue;
    }
    if (basePasses > 0) {
      screened.push({ ...base, baseRuns, basePasses, gradeable: true, heldOut: false, reason: 'base-passes' });
      continue;
    }

    // Layer 3: prover ≥1 pass (existence proof of headroom).
    const prover = await deps.runProverFrozen(task);
    if (prover.passed !== true) {
      screened.push({ ...base, baseRuns: opts.R, gradeable: true, proverPassed: prover.passed, heldOut: false, reason: 'no-headroom' });
      continue;
    }
    if ((perRepo.get(repo) ?? 0) >= opts.perRepoCap) {
      screened.push({ ...base, baseRuns: opts.R, gradeable: true, proverPassed: true, heldOut: false, reason: 'per-repo-cap' });
      continue;
    }

    perRepo.set(repo, (perRepo.get(repo) ?? 0) + 1);
    heldOut.push({ instance_id: task.instance_id, repo, baseRuns: opts.R });
    screened.push({ ...base, baseRuns: opts.R, gradeable: true, proverPassed: true, heldOut: true, reason: 'held-out' });
    log(`[screen] held out ${task.instance_id} (${heldOut.length}/${opts.heldOutCount})`);
  }

  return { heldOut, screened };
}
