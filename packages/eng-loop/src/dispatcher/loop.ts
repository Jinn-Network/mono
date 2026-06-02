import type { IssueSource } from './issue-source.js';
import type { ProjectSnapshot } from './project-snapshot.js';
import { toIssueBoardState } from './project-snapshot.js';
import type { DispatcherConfig, InFlightSession, ReadyIssue, SessionResult } from './types.js';
import type { WallClock } from './wall-clock.js';
import { selectReady, type SkippedForAuthor } from './ready-filter.js';
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
  /**
   * Issue numbers of in-flight sessions paused this cycle because the
   * wall-clock ceiling was exceeded (spec §4 circuit-breaker).
   * A paused session keeps its concurrency slot — a human resolves it.
   */
  paused: number[];
  /**
   * Otherwise-ready issues whose author is not on `cfg.authorAllowlist`
   * (#497 trust boundary). Carries `{number, author}` so operators can
   * diagnose misconfigurations from the log alone.
   */
  skippedForAuthor: SkippedForAuthor[];
  /**
   * Sessions that finished this cycle (left the in-flight set), classified
   * into `pr-opened` / `escalated` and already handed to the DeliverySink by
   * the injected `collectCompletions` dep (#489). Surfaced here for the
   * operator log only — the sink has already recorded each result.
   */
  collected: SessionResult[];
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
  /**
   * Wall-clock circuit-breaker — checks whether an in-flight session has
   * exceeded its ceiling (spec §4). Injected so loop.ts stays gh-free.
   */
  wallClock: WallClock;
  /**
   * Pause one in-flight session that exceeded its wall-clock ceiling.
   * Sets the issue's "Blocked on" Project field to "Human".
   * Injected so loop.ts stays gh-free.
   */
  pauseSession(issueNumber: number): Promise<void>;
  /**
   * The in-flight set as derived on the *previous* cycle. The orchestrator
   * (`scripts/run-eng-loop.ts`) owns this cross-cycle memory so `loop.ts`
   * stays pure (no gh/git, no mutable module state). Empty on the first
   * cycle. Losing it on restart costs at most one un-collected log line, not
   * a correctness bug — dispatch stays crash-safe. (#489)
   */
  prevInFlight: InFlightSession[];
  /**
   * Classify the sessions that finished this cycle and hand each to the
   * DeliverySink. Receives the FULL previous and current in-flight sets;
   * the concrete dep computes the difference itself (it needs each finished
   * session's retained `branch` to recover the PR). Injected so loop.ts
   * stays gh/git-free. (#489)
   */
  collectCompletions(
    prev: InFlightSession[],
    current: InFlightSession[],
  ): Promise<SessionResult[]>;
}

// ---------------------------------------------------------------------------
// Core cycle
// ---------------------------------------------------------------------------

/**
 * Run one tick of the dispatcher loop:
 *
 * 1. Poll the issue source (using the supplied snapshot for board state).
 * 2. Derive in-flight state (crash-safe: authoritative external state).
 * 3. Wall-clock circuit-breaker — pause any in-flight session past its ceiling.
 * 4. Apply the ready filter (triage-complete, unblocked, Todo, not in-flight).
 * 5. Check backpressure — if open ready PRs exceed the threshold, dispatch nothing.
 * 6. Check concurrency — dispatch the top `cap − inFlight` ready issues.
 * 7. Return a `CycleReport` for the operator log.
 *
 * `loop.ts` contains NO `gh` or `git` calls — all external I/O is behind the
 * injected `deps` (§9 seam discipline). The Project board snapshot is
 * passed in as data; per jinn-mono#585 the orchestrator fetches it once per
 * cycle and threads it through here.
 */
export async function runCycle(
  snapshot: ProjectSnapshot,
  deps: CycleDeps,
): Promise<CycleReport> {
  const {
    source,
    cfg,
    deriveInFlight,
    dispatchIssue,
    countOpenReadyPrs,
    wallClock,
    pauseSession,
    prevInFlight,
    collectCompletions,
  } = deps;

  // 1. Poll + derive in-flight in parallel. The IssueSource sees only the
  //    abstract IssueBoardState (#600); the full snapshot stays here for
  //    the rate-limit gate and `deriveInFlight`.
  const [polled, { inFlight, drift }, openPrCount] = await Promise.all([
    source.poll(toIssueBoardState(snapshot)),
    deriveInFlight(),
    countOpenReadyPrs(),
  ]);

  // 1b. Detect finished sessions (#489): hand the previous + current in-flight
  //     sets to the injected classifier, which diffs them, classifies each
  //     finished session, and hands the result to the DeliverySink. We pass
  //     both full sets — the concrete dep needs each finished session's
  //     retained `branch` to recover the PR, so the diff lives there, not here.
  const collected = await collectCompletions(prevInFlight, inFlight);

  // 2. Wall-clock circuit-breaker (spec §4): pause any in-flight session that
  //    has exceeded its ceiling. Paused sessions keep their concurrency slot —
  //    a human resolves them.
  const paused: number[] = [];
  for (const session of inFlight) {
    if (wallClock.expired(session)) {
      await pauseSession(session.issueNumber);
      paused.push(session.issueNumber);
    }
  }

  // 3. Build the in-flight set for the ready filter
  const inFlightSet: ReadonlySet<number> = new Set<number>(inFlight.map((s) => s.issueNumber));

  // 3b. Build the lowercased allowlist set (#497) — `selectReady` lowercases
  //     each issue author at compare time, so the allowlist side must match.
  const allowlistSet: ReadonlySet<string> = new Set<string>(
    cfg.authorAllowlist.map((s) => s.toLowerCase()),
  );

  // 4. Apply ready filter (ordered by priority then issue number)
  const { ready, skippedForAuthor } = selectReady(polled, inFlightSet, allowlistSet);

  // 5. Check backpressure
  if (!backpressureOk(openPrCount, cfg.openPrBackpressure)) {
    return {
      dispatched: [],
      skippedForThrottle: ready.length,
      drift,
      backpressureTripped: true,
      paused,
      // Author-skips happen regardless of backpressure; surface them either way.
      skippedForAuthor,
      // Completions are detected before the backpressure gate — surface them
      // even when no new work is dispatched this cycle. (#489)
      collected,
    };
  }

  // 6. Concurrency budget
  const budget = concurrencyOk(inFlight.length, cfg.concurrencyCap)
    ? cfg.concurrencyCap - inFlight.length
    : 0;

  const toDispatch = ready.slice(0, budget);
  const skippedForThrottle = ready.length - toDispatch.length;

  // 7. Dispatch
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
    paused,
    skippedForAuthor,
    collected,
  };
}
