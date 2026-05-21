import type { IssueSource } from './issue-source.js';
import type { DispatcherConfig, InFlightSession, ReadyIssue } from './types.js';
import { selectReady } from './ready-filter.js';
import { concurrencyOk, backpressureOk } from './throttles.js';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/** What one cycle of the dispatcher did (or didn't do). */
export interface CycleReport {
  /** Issue numbers dispatched this cycle (in dispatch order). */
  dispatched: number[];
  /** Issues that were ready but skipped because the budget was exhausted. */
  skippedForThrottle: number;
  /** Drift strings from `deriveInFlight` — for operator visibility. */
  drift: string[];
  /** True when the open-PR count exceeded `cfg.openPrBackpressure`. */
  backpressureTripped: boolean;
}

// ---------------------------------------------------------------------------
// Injected dependencies (seam discipline — no gh/git calls in this file)
// ---------------------------------------------------------------------------

export interface CycleDeps {
  /** Where ready issues come from. */
  source: IssueSource;
  /** Dispatcher configuration (caps, thresholds). */
  cfg: DispatcherConfig;
  /**
   * Re-derive in-flight state from external sources (board + worktrees).
   * Injected so loop.ts stays free of gh/git calls.
   */
  deriveInFlight(): Promise<{ inFlight: InFlightSession[]; drift: string[] }>;
  /**
   * Dispatch one ready issue — create worktree, set status, spawn session.
   * Injected so loop.ts stays free of gh/git calls.
   */
  dispatchIssue(issue: ReadyIssue): Promise<InFlightSession>;
  /**
   * Count open PRs in the ready-for-merge queue.
   * Injected so loop.ts stays free of gh/git calls.
   */
  countOpenReadyPrs(): Promise<number>;
}

// ---------------------------------------------------------------------------
// Core cycle
// ---------------------------------------------------------------------------

/**
 * Run one tick of the dispatcher loop:
 *
 * 1. Poll the issue source.
 * 2. Derive in-flight state (crash-safe: authoritative external state).
 * 3. Apply the ready filter (triage-complete, unblocked, Todo, not in-flight).
 * 4. Check backpressure — if open ready PRs exceed the threshold, dispatch nothing.
 * 5. Check concurrency — dispatch the top `cap − inFlight` ready issues.
 * 6. Return a `CycleReport` for the operator log.
 *
 * `loop.ts` contains NO `gh` or `git` calls — all external I/O is behind the
 * injected `deps` (§9 seam discipline).
 */
export async function runCycle(deps: CycleDeps): Promise<CycleReport> {
  const { source, cfg, deriveInFlight, dispatchIssue, countOpenReadyPrs } = deps;

  // 1. Poll + derive in-flight in parallel for efficiency
  const [polled, { inFlight, drift }, openPrCount] = await Promise.all([
    source.poll(),
    deriveInFlight(),
    countOpenReadyPrs(),
  ]);

  // 2. Build the in-flight set for the ready filter
  const inFlightSet: ReadonlySet<number> = new Set<number>(inFlight.map((s) => s.issueNumber));

  // 3. Apply ready filter (ordered by priority then issue number)
  const ready = selectReady(polled, inFlightSet);

  // 4. Check backpressure
  if (!backpressureOk(openPrCount, cfg.openPrBackpressure)) {
    return {
      dispatched: [],
      skippedForThrottle: ready.length,
      drift,
      backpressureTripped: true,
    };
  }

  // 5. Concurrency budget
  const budget = concurrencyOk(inFlight.length, cfg.concurrencyCap)
    ? cfg.concurrencyCap - inFlight.length
    : 0;

  const toDispatch = ready.slice(0, budget);
  const skippedForThrottle = ready.length - toDispatch.length;

  // 6. Dispatch
  const dispatched: number[] = [];
  for (const issue of toDispatch) {
    await dispatchIssue(issue);
    dispatched.push(issue.number);
  }

  return {
    dispatched,
    skippedForThrottle,
    drift,
    backpressureTripped: false,
  };
}
