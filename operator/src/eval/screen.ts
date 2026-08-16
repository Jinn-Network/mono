import type { PoolTask } from '../solver-types/_swe-rebench-v2-pool.js';
import {
  HELD_OUT_SLATE_SCHEMA_VERSION,
  hashHeldOutSlateArtifact,
  type HeldOutSlateArtifact,
} from '../solver-types/_swe-rebench-v2-held-out-slate.js';

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
  /** When `passed === null`, the stage + error that made it unscorable
   *  (e.g. `resolve: …`, `harness: no patch`, `grade-error: …`) — surfaced so an
   *  exclusion is never an opaque black box. */
  unscorableReason?: string;
}

/**
 * The expensive, cacheable per-candidate outcome — gradeability + the base R-run
 * loop + (if base is 0/R) the prover. Decoupled from the selection decision so a
 * resumed run replays it from cache without re-spending inference. The decision
 * (held-out / no-headroom / caps) is always recomputed fresh from this.
 */
export interface ScreenMeasurement {
  gradeable: boolean;
  basePasses: number;
  baseRuns: number;
  baseUnscorable: boolean;
  baseUnscorableReason?: string;
  /** Whether the prover was reached (only when base is gradeable + 0/R). */
  proverRan: boolean;
  /** Meaningful only when `proverRan`; `null` = prover unscorable. */
  proverPassed: boolean | null;
  proverUnscorableReason?: string;
}

export interface ScreenDeps {
  /** Confirm gradeable at the current semantics version (idempotent; cheap/cached). */
  ensureGradeable(task: PoolTask): Promise<boolean>;
  /** Base Haiku, frozen, empty impl-state. `passed: null` = unscorable. */
  runBaseFrozen(task: PoolTask): Promise<ScreenCandidateRun>;
  /** Prover (Codex/GPT-5.5), frozen, empty impl-state. `passed: null` = unscorable. */
  runProverFrozen(task: PoolTask): Promise<ScreenCandidateRun>;
  /** Resumability (optional): return a cached measurement for this instance, or
   *  undefined to measure live. A cache hit replays for free (no inference) and
   *  does NOT consume the maxCandidates budget. */
  getCachedMeasurement?(instance_id: string): ScreenMeasurement | undefined;
  /** Resumability (optional): persist a freshly-measured candidate so a later
   *  re-run of the same command resumes instead of restarting. */
  recordMeasurement?(instance_id: string, m: ScreenMeasurement): void;
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
  /** For `base-unscorable` / `no-headroom`-via-unscorable: the stage + error
   *  the run reported, so the exclusion is diagnosable without transcript digs. */
  unscorableReason?: string;
}

export interface ScreenResult {
  heldOut: { instance_id: string; repo: string; baseRuns: number }[];
  screened: ScreenedCandidate[];
}

/**
 * The expensive part: gradeable → base R-runs (early-stop on first pass) →
 * prover (only if base is 0/R). Pure measurement; no selection/caps. This is what
 * gets cached for resumability.
 */
async function measureCandidate(task: PoolTask, deps: ScreenDeps, R: number): Promise<ScreenMeasurement> {
  const none: ScreenMeasurement = { gradeable: false, basePasses: 0, baseRuns: 0, baseUnscorable: false, proverRan: false, proverPassed: null };
  if (!(await deps.ensureGradeable(task))) return none;

  let basePasses = 0;
  let baseUnscorable = false;
  let baseUnscorableReason: string | undefined;
  let r = 0;
  for (; r < R; r++) {
    const run = await deps.runBaseFrozen(task);
    if (run.passed === null) { baseUnscorable = true; baseUnscorableReason = run.unscorableReason; break; }
    if (run.passed) { basePasses++; break; }
  }
  const baseRuns = r + (baseUnscorable || basePasses > 0 ? 1 : 0);
  if (baseUnscorable) {
    return { gradeable: true, basePasses: 0, baseRuns, baseUnscorable: true, ...(baseUnscorableReason ? { baseUnscorableReason } : {}), proverRan: false, proverPassed: null };
  }
  if (basePasses > 0) {
    return { gradeable: true, basePasses, baseRuns, baseUnscorable: false, proverRan: false, proverPassed: null };
  }
  // Base reliably fails (0/R) → layer 3: prover (existence proof of headroom).
  const prover = await deps.runProverFrozen(task);
  return {
    gradeable: true, basePasses: 0, baseRuns, baseUnscorable: false, proverRan: true, proverPassed: prover.passed,
    ...(prover.passed === null && prover.unscorableReason ? { proverUnscorableReason: prover.unscorableReason } : {}),
  };
}

/**
 * Partition a candidate stream into the held-out exam vs the rest, applying the
 * three filter layers cheapest-first. `candidates` MUST already be ordered (use
 * {@link stratifyByRepo}); selection order is the iteration order and is frozen.
 *
 * Resumable: if `deps.getCachedMeasurement` is provided, an already-measured
 * candidate replays from cache (no inference, no budget cost), so re-running the
 * same command resumes — the `maxCandidates` budget bounds only NEW measurements
 * per invocation, letting a long screen proceed in budget-sized chunks. The
 * selection decision (caps, held-out) is always recomputed fresh, so the cached
 * measurements stay valid even if `heldOutCount`/`perRepoCap` change.
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
  let liveMeasured = 0;

  for (const task of candidates) {
    if (heldOut.length >= opts.heldOutCount) break;
    const repo = repoOf(task);
    const base = { instance_id: task.instance_id, repo, basePasses: 0, proverPassed: null as boolean | null };

    // Measure (from cache, or live — bounded by the per-invocation budget).
    let m = deps.getCachedMeasurement?.(task.instance_id);
    if (!m) {
      if (liveMeasured >= opts.maxCandidates) break; // budget bounds NEW (inference-spending) measurements
      m = await measureCandidate(task, deps, opts.R);
      liveMeasured += 1;
      deps.recordMeasurement?.(task.instance_id, m);
    }

    // Decide from the measurement (always fresh; cap/diversity not cached).
    if (!m.gradeable) {
      screened.push({ ...base, baseRuns: 0, gradeable: false, heldOut: false, reason: 'not-gradeable' });
      continue;
    }
    if (m.baseUnscorable) {
      if (m.baseUnscorableReason) log(`[screen] ${task.instance_id} base-unscorable: ${m.baseUnscorableReason}`);
      screened.push({ ...base, baseRuns: m.baseRuns, gradeable: true, heldOut: false, reason: 'base-unscorable', ...(m.baseUnscorableReason ? { unscorableReason: m.baseUnscorableReason } : {}) });
      continue;
    }
    if (m.basePasses > 0) {
      screened.push({ ...base, baseRuns: m.baseRuns, basePasses: m.basePasses, gradeable: true, heldOut: false, reason: 'base-passes' });
      continue;
    }
    // Base 0/R → prover outcome (layer 3).
    if (m.proverPassed !== true) {
      if (m.proverPassed === null && m.proverUnscorableReason) log(`[screen] ${task.instance_id} prover-unscorable: ${m.proverUnscorableReason}`);
      screened.push({
        ...base, baseRuns: m.baseRuns, gradeable: true, proverPassed: m.proverPassed, heldOut: false, reason: 'no-headroom',
        ...(m.proverPassed === null && m.proverUnscorableReason ? { unscorableReason: m.proverUnscorableReason } : {}),
      });
      continue;
    }
    if ((perRepo.get(repo) ?? 0) >= opts.perRepoCap) {
      screened.push({ ...base, baseRuns: m.baseRuns, gradeable: true, proverPassed: true, heldOut: false, reason: 'per-repo-cap' });
      continue;
    }

    perRepo.set(repo, (perRepo.get(repo) ?? 0) + 1);
    heldOut.push({ instance_id: task.instance_id, repo, baseRuns: m.baseRuns });
    screened.push({ ...base, baseRuns: m.baseRuns, gradeable: true, proverPassed: true, heldOut: true, reason: 'held-out' });
    log(`[screen] held out ${task.instance_id} (${heldOut.length}/${opts.heldOutCount})`);
  }

  return { heldOut, screened };
}

/** The on-disk v2 slate file = the hashed artifact + a provenance `comment`
 *  (the comment is outside the canonical hash). solverType matches the
 *  `${solverType}.v1` key `jinn eval` loads with. */
export interface V2SlateFile extends HeldOutSlateArtifact {
  comment: string;
  hash: `sha256:${string}`;
}

const V2_SLATE_COMMENT =
  'BASELINE-FAILURE REGRESSION BENCHMARK (issue #986). Screened: gradeable at the current ' +
  'evalSemanticsVersion AND base claude-code/Haiku frozen fails 0/R (R≥3) AND a stronger Codex/GPT-5.5 ' +
  'prover passes ≥1 (proven headroom). Baseline 0% by construction. Held out from the generator train ' +
  'stream via the active-slate-version union. Content-addressed; scores comparable WITHIN this version only.';

export function buildV2SlateFile(instanceIds: string[], generatedAt: string): V2SlateFile {
  const artifact: HeldOutSlateArtifact = {
    schemaVersion: HELD_OUT_SLATE_SCHEMA_VERSION,
    solverType: 'swe-rebench-v2.v1',
    version: 'v2',
    generatedAt,
    instanceIds: [...instanceIds].sort((a, b) => a.localeCompare(b)),
  };
  return { comment: V2_SLATE_COMMENT, ...artifact, hash: hashHeldOutSlateArtifact(artifact) };
}
