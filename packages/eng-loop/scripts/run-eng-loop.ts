/**
 * eng:loop entry point.
 *
 * Usage:
 *   yarn eng:loop                     # run the dispatcher on a 10min interval (normal mode)
 *   yarn eng:loop --dry-run           # one cycle, no mutations, prints the CycleReport
 *   yarn eng:loop --once              # one cycle live (dispatch up to cap), then exit
 *   yarn eng:loop --cap <N>           # override concurrencyCap
 *   yarn eng:loop --backpressure <N>  # override openPrBackpressure
 *   yarn eng:loop --interval <ms>     # override poll interval (default 600000 = 10min)
 *
 * --once + --cap <N> compose: bound a first live run to at most N dispatches.
 * Defaults live in src/dispatcher/types.ts DEFAULT_CONFIG.
 */

import { GhIssueSource, defaultRunner as realRunner } from '../src/dispatcher/issue-source.js';
import type { CommandRunner } from '../src/dispatcher/issue-source.js';
import { deriveInFlight } from '../src/dispatcher/state.js';
import { dispatchIssue } from '../src/dispatcher/dispatch.js';
import { GhPrSource } from '../src/dispatcher/pr-source.js';
import { deriveReviewInFlight } from '../src/dispatcher/review-state.js';
import { dispatchReview } from '../src/dispatcher/review-dispatch.js';
import { runReviewCycle } from '../src/dispatcher/review-loop.js';
import type { SpawnFn } from '../src/dispatcher/dispatch.js';
import type { ReviewablePr } from '../src/dispatcher/types.js';
import {
  fetchFieldIds,
  getFieldCache,
  resetFieldCache,
} from '../src/dispatcher/field-cache.js';
import { makePauseSession } from '../src/dispatcher/pause-session.js';
import { runCycle } from '../src/dispatcher/loop.js';
import type { CycleReport } from '../src/dispatcher/loop.js';
import { fetchProjectSnapshot } from '../src/dispatcher/project-snapshot.js';
import { gateOrRun, isSkipped } from '../src/dispatcher/rate-limit-guard.js';
import { DEFAULT_CONFIG } from '../src/dispatcher/types.js';
import type { DispatcherConfig, ReadyIssue } from '../src/dispatcher/types.js';
import { WallClock } from '../src/dispatcher/wall-clock.js';
import { shouldRouteToSessions } from '../src/cli/routing.js';
import { spawn } from 'node:child_process';
import type { SpawnOptions } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { argv } from 'node:process';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * Default poll interval between cycles. 10 minutes is well-matched to the
 * 30min–multi-hour timescale of an implement-issue session — slot-fill
 * latency is bounded by interval, not by session length, so the throughput
 * cost of a slower poll is ~1–5% (one session-completion lingers up to
 * interval before the next slot fills). Override with `--interval <ms>`.
 *
 * Trade-off vs. faster polling: at 60s the dispatcher alone consumed ~180
 * GraphQL pts/hr; at 10min it consumes ~18 pts/hr, freeing the rest of the
 * 5000/hr budget for the spawned children's `gh` calls and reducing the
 * rate-limit guard's trip rate to near zero. (#585 budget visibility,
 * #593 guard.)
 */
const DEFAULT_INTERVAL_MS = 10 * 60_000;
const REPO = 'Jinn-Network/mono';

/**
 * Env var carrying the comma-separated GitHub-login allowlist (#497).
 * Empty / unset means dispatch nothing — fail-safe per design.
 */
const AUTHOR_ALLOWLIST_ENV = 'JINN_DISPATCHER_AUTHOR_ALLOWLIST';
const REVIEW_BOT_LOGIN_ENV = 'JINN_REVIEW_BOT_LOGIN';

/** Parse the allowlist env var into a trimmed, non-empty string array. */
function parseAuthorAllowlist(raw: string | undefined): string[] {
  if (raw == null) return [];
  return raw
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

// ---------------------------------------------------------------------------
// countOpenReadyPrs — count open PRs awaiting merge ("In Review" on the board)
// ---------------------------------------------------------------------------

interface GhPr {
  isDraft: boolean;
}

async function countOpenReadyPrs(): Promise<number> {
  // Count ALL open PRs against `next` — both draft and non-draft — because the
  // implement-issue pipeline opens draft PRs. Excluding drafts would hide the
  // dispatcher's own output from the backpressure count, defeating the §2 throttle.
  const raw = await realRunner('gh', [
    'pr', 'list',
    '--repo', REPO,
    '--base', 'next',
    '--state', 'open',
    '--json', 'isDraft',
    '--limit', '200',
  ]);
  const prs: GhPr[] = JSON.parse(raw) as GhPr[];
  return prs.length;
}

// Wall-clock pauseSession is built per cycle via `makePauseSession(snapshot,
// fieldCache, realRunner)` inside `runOneCycle`. Pre-#599 it was an inline
// async function here that called `gh project item-list --limit 500` per
// pause; that lookup now reads from the cycle's ProjectSnapshot in memory.

// ---------------------------------------------------------------------------
// Print cycle report
// ---------------------------------------------------------------------------

function printReport(report: CycleReport, label: string): void {
  console.log(`\n[${ new Date().toISOString() }] ${label}`);
  console.log('─'.repeat(60));

  if (report.backpressureTripped) {
    console.log('⚠  BACKPRESSURE TRIPPED — too many open ready PRs; no new dispatches.');
  }

  if (report.dispatched.length === 0 && !report.backpressureTripped) {
    console.log('   dispatched: (none)');
  } else {
    console.log(`   dispatched: #${report.dispatched.join(', #') || '(none)'}`);
  }

  console.log(`   skipped (throttle): ${report.skippedForThrottle}`);

  if (report.skippedForAuthor.length > 0) {
    const rendered = report.skippedForAuthor
      .map((s) => `#${s.number} (@${s.author})`)
      .join(', ');
    console.log(`   skipped (author allowlist): ${rendered}`);
  }

  if (report.paused.length > 0) {
    console.log(`\n   WALL-CLOCK PAUSED: #${report.paused.join(', #')} (Blocked on: Human)`);
  }

  if (report.drift.length > 0) {
    console.log('\n   DRIFT:');
    for (const d of report.drift) {
      console.log(`     ${d}`);
    }
  } else {
    console.log('   drift: (none)');
  }

  console.log('─'.repeat(60));
}

// ---------------------------------------------------------------------------
// runDryRun — one-shot dry-run cycle (fix #598)
//
// Extracted from `main()` so the failure-path is unit-testable in-process
// with injected `runner` and `exit` spies. Dry-run is one-shot, so any
// rejection exits non-zero — operators rely on the exit code as the
// sanity-check signal.
// ---------------------------------------------------------------------------

export interface RunDryRunOpts {
  runner?: CommandRunner;
  exit?: (code: number) => void;
  cfg: DispatcherConfig;
  wallClock: WallClock;
}

export async function runDryRun(opts: RunDryRunOpts): Promise<void> {
  const { cfg, wallClock, runner = realRunner, exit = process.exit } = opts;

  try {
    console.log('[eng:loop] DRY RUN — polling live issue queue; will NOT dispatch, mutate board, or create worktrees.');

    const source = new GhIssueSource(runner);

    // Dry-run: use a stub dispatchIssue that records but does nothing
    const wouldDispatch: number[] = [];
    const dryDispatch = async (issue: ReadyIssue): Promise<import('../src/dispatcher/types.js').InFlightSession> => {
      wouldDispatch.push(issue.number);
      // Return a fake InFlightSession — nothing is created
      return {
        issueNumber: issue.number,
        branch: `(dry-run)`,
        worktreePath: `(dry-run)`,
        pid: null,
        startedAt: Date.now(),
      };
    };

    // Dry-run stub for pauseSession — logs the intent but makes NO gh mutation,
    // honouring the banner promise "will NOT dispatch, mutate board, or create worktrees".
    const dryPauseSession = async (issueNumber: number): Promise<void> => {
      console.log(`[dry-run] would pause #${issueNumber} (wall-clock ceiling) — no board mutation.`);
    };

    // Fetch the per-cycle Project snapshot once and share with deriveInFlight
    // (and, after step 5 of the #585 plan, source.poll). Costs ≤2 GraphQL pts
    // versus ~192 in the pre-#585 code.
    const snapshot = await fetchProjectSnapshot(runner);
    const report = await runCycle(snapshot, {
      source,
      cfg,
      deriveInFlight: () => deriveInFlight(snapshot, runner),
      dispatchIssue: dryDispatch,
      countOpenReadyPrs,
      wallClock,
      pauseSession: dryPauseSession,
    });

    printReport(report, 'Cycle report (DRY RUN — no mutations)');

    if (wouldDispatch.length > 0) {
      console.log(`\n[dry-run] Would have dispatched: ${wouldDispatch.map((n) => `#${n}`).join(', ')}`);
    } else {
      console.log('\n[dry-run] No issues would be dispatched this cycle.');
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[eng:loop] dry-run aborted: ${msg} — run \`gh api rate_limit\` to check budget`);
    exit(1);
  }
}

// ---------------------------------------------------------------------------
// runReviewPass — one pass of the review-pr loop
// ---------------------------------------------------------------------------

export async function runReviewPass(
  cfg: DispatcherConfig,
  runner: CommandRunner = realRunner,
  spawnFn?: SpawnFn,
): Promise<void> {
  if (cfg.reviewBotLogin.length === 0) return; // disabled — fail-safe
  const spawnImpl: SpawnFn =
    spawnFn ??
    ((cmd, args, opts) => {
      const child = spawn(cmd, args, opts as SpawnOptions);
      if (child.pid != null) child.unref();
      return { pid: child.pid };
    });
  const prSource = new GhPrSource(runner, cfg.engineReviewLabel, cfg.reviewBotLogin);
  const report = await runReviewCycle({
    prSource,
    cfg,
    deriveReviewInFlight: () => deriveReviewInFlight(runner),
    dispatchReview: (pr: ReviewablePr) => dispatchReview(pr, cfg, { runner, spawn: spawnImpl }),
  });
  if (report.dispatched.length > 0) {
    console.log(`[eng:loop] review-pr dispatched: PR #${report.dispatched.join(', #')}`);
  }
}

// ---------------------------------------------------------------------------
// Graceful shutdown (fix jinn-mono#490)
// ---------------------------------------------------------------------------

// runLoop — the recursive scheduler, extracted from main() so the shutdown
// behaviour is testable in-process (fix jinn-mono#490). The first cycle always
// runs to completion; thereafter `scheduleNext` gates on `isShuttingDown()` at
// the re-arm seam — once a signal has flipped the latch it logs and returns
// without arming another timer, so the in-flight cycle finishes and the event
// loop drains to a clean exit 0 (detached child sessions stay alive via
// child.unref()). The `schedule` seam is injectable purely for tests; in
// production it is the setTimeout default below.
export interface RunLoopOpts {
  runOnce: () => Promise<number>;
  isShuttingDown: () => boolean;
  schedule?: (cb: () => void, delayMs: number) => void;
}
export async function runLoop(opts: RunLoopOpts): Promise<void> {
  const { runOnce, isShuttingDown, schedule = (cb, ms) => void setTimeout(cb, ms) } = opts;
  const scheduleNext = (delay: number): void => {
    if (isShuttingDown()) {
      console.log('[eng:loop] shutdown requested — finishing current cycle, not scheduling new ones');
      return;
    }
    schedule(() => { void runOnce().then(scheduleNext); }, delay);
  };
  const firstDelay = await runOnce();
  scheduleNext(firstDelay);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  if (shouldRouteToSessions(process.argv)) {
    const { runSessionsCli } = await import('../src/cli/sessions.js');
    await runSessionsCli(process.argv.slice(3));
    return;
  }

  const isDryRun = process.argv.includes('--dry-run');
  const isOnce = process.argv.includes('--once');
  const capIdx = process.argv.indexOf('--cap');
  const capOverride = capIdx >= 0 ? parseInt(process.argv[capIdx + 1] ?? '', 10) : NaN;
  const bpIdx = process.argv.indexOf('--backpressure');
  const bpOverride = bpIdx >= 0 ? parseInt(process.argv[bpIdx + 1] ?? '', 10) : NaN;
  const intervalIdx = process.argv.indexOf('--interval');
  const intervalOverride = intervalIdx >= 0 ? parseInt(process.argv[intervalIdx + 1] ?? '', 10) : NaN;
  const intervalMs =
    Number.isInteger(intervalOverride) && intervalOverride > 0
      ? intervalOverride
      : DEFAULT_INTERVAL_MS;

  const authorAllowlist = parseAuthorAllowlist(process.env[AUTHOR_ALLOWLIST_ENV]);
  const capOk = Number.isInteger(capOverride) && capOverride > 0;
  const bpOk = Number.isInteger(bpOverride) && bpOverride > 0;
  const cfg: DispatcherConfig = {
    ...DEFAULT_CONFIG,
    ...(capOk ? { concurrencyCap: capOverride } : {}),
    ...(bpOk ? { openPrBackpressure: bpOverride } : {}),
    authorAllowlist,
    reviewBotLogin: process.env[REVIEW_BOT_LOGIN_ENV] ?? '',
  };

  if (cfg.authorAllowlist.length === 0) {
    // Fail-safe per spec 2026-05-23-author-allowlist-design.md: empty
    // allowlist means dispatch nothing. Warn loudly so a misconfigured
    // deploy is visible from the very first cycle log.
    console.warn(
      `[eng:loop] WARNING: authorAllowlist is empty — no issues will be dispatched. ` +
        `Set ${AUTHOR_ALLOWLIST_ENV}=login1,login2,... to enable dispatch.`,
    );
  } else {
    console.log(
      `[eng:loop] authorAllowlist (${cfg.authorAllowlist.length}): ${cfg.authorAllowlist.join(', ')}`,
    );
  }

  if (cfg.reviewBotLogin.length === 0) {
    console.warn(
      `[eng:loop] WARNING: ${REVIEW_BOT_LOGIN_ENV} unset — the review-pr loop is disabled ` +
        `(cannot detect a current review without the bot login). Set ${REVIEW_BOT_LOGIN_ENV}=<login> to enable.`,
    );
  } else {
    console.log(`[eng:loop] review-pr enabled (bot=${cfg.reviewBotLogin}, label=${cfg.engineReviewLabel}, cap=${cfg.reviewCap})`);
  }

  const source = new GhIssueSource(realRunner);
  const wallClock = new WallClock(cfg.wallClockMs);
  // TODO: wire GhPrSink.collect once session-completion detection exists

  if (isDryRun) {
    // Dry-run intentionally skips the field-id cache + makePauseSession + any
    // other live-gh boot work: no mutations happen here, so no field ids are
    // needed and the boot-time GraphQL spend is saved. (#599)
    await runDryRun({ cfg, wallClock });
    return;
  }

  // Populate the Project field-id cache once, at boot, BEFORE any cycle
  // runs. Eager-at-boot means a renamed Status/Blocked-on field surfaces as
  // a fatal ProjectFieldCacheError before the first dispatch (consistent
  // with ProjectFieldSchemaError in the snapshot path). The
  // ENG_LOOP_RESET_FIELD_CACHE=1 env knob is symbolic on first boot — the
  // cache starts null — but documents operator intent for future long-lived
  // dispatcher modes that may re-enter main(). Do not delete as dead code.
  // (jinn-mono#599)
  if (process.env.ENG_LOOP_RESET_FIELD_CACHE === '1') {
    // Make the symbolism honest in the boot log (Stage 5 Finding 3 on
    // jinn-mono#599) — on first boot the singleton is null, so this is a
    // no-op; the call is preserved as the documented invariant for future
    // long-running modes that re-enter main() without a fresh process.
    console.log(
      '[eng:loop] ENG_LOOP_RESET_FIELD_CACHE=1 — cache cleared (symbolic at boot; primary use is re-entry from a long-running mode).',
    );
    resetFieldCache();
  }
  const fieldCache = await fetchFieldIds(realRunner);
  console.log(`[eng:loop] field cache populated (projectId=${fieldCache.projectId})`);

  // Normal mode: run on an interval (or once + exit when --once)
  console.log(
    `[eng:loop] Starting dispatcher (cap=${cfg.concurrencyCap}, backpressure=${cfg.openPrBackpressure}, ` +
      (isOnce ? 'mode=once' : `interval=${intervalMs}ms`) +
      ')',
  );

  /**
   * Run one cycle, gated on GraphQL budget.
   *
   * Returns the next-attempt delay in ms:
   *   - On normal cycle (gate passed): `intervalMs` (default 10min; overridable via `--interval <ms>`).
   *   - On gate-skip (budget low): the gate's `sleepMs` (sleep until reset
   *     + 5s, clamped to [0, 1h]).
   *   - On thrown error: `intervalMs` (retry next tick).
   *
   * Per jinn-mono#585, the snapshot is fetched once at the top of the cycle
   * and threaded through every consumer; the gate reads `snapshot.rateLimit`
   * to decide whether to proceed.
   */
  const runOneCycle = async (): Promise<number> => {
    try {
      const snapshot = await fetchProjectSnapshot(realRunner);

      // Re-read the field-cache singleton at the top of each cycle so a
      // refresh inside the previous cycle's dispatch retry propagates here.
      // `main()`'s boot `fetchFieldIds` populated the singleton, and
      // `dispatchIssue`'s stale-id retry calls `fetchFieldIds` again — which
      // swaps the singleton in place. Closing over the outer
      // `const fieldCache` would pin the original (stale) reference forever
      // (Stage 5 Finding 1 on jinn-mono#599). If the singleton is somehow
      // null here, it means main() never ran or an exotic re-entry path
      // wiped it — fail loud rather than silently dispatch with a half-built
      // cache.
      const cycleFieldCache = getFieldCache();
      if (cycleFieldCache == null) {
        throw new Error(
          '[eng:loop] field cache is null at cycle entry — main() must populate it via fetchFieldIds before any cycle runs',
        );
      }

      // Build a per-cycle pause closure that resolves the project item id
      // from the snapshot already in scope (jinn-mono#599) — no extra
      // `gh project item-list` call per pause.
      const pauseSessionForCycle = makePauseSession(snapshot, cycleFieldCache, realRunner);

      // Allow operators to override the rate-limit floor via env (mainly for
      // testing the gate). ENG_LOOP_RATELIMIT_FLOOR=4999 forces the gate to
      // trip on the next cycle for verification.
      const floorEnv = process.env.ENG_LOOP_RATELIMIT_FLOOR;
      const floorOverride = floorEnv != null && /^\d+$/.test(floorEnv)
        ? parseInt(floorEnv, 10)
        : undefined;

      const result = await gateOrRun(snapshot, {
        source,
        cfg,
        deriveInFlight: () => deriveInFlight(snapshot, realRunner),
        dispatchIssue: (issue) =>
          dispatchIssue(issue, cfg, {
            runner: realRunner,
            spawn: (cmd, args, opts) => {
              const child = spawn(cmd, args, opts as SpawnOptions);
              if (child.pid != null) {
                child.unref();
              }
              return { pid: child.pid };
            },
            fieldCache: cycleFieldCache,
          }),
        countOpenReadyPrs,
        wallClock,
        pauseSession: pauseSessionForCycle,
      }, floorOverride != null ? { floor: floorOverride } : undefined);

      if (isSkipped(result)) {
        console.log(
          `[eng:loop] gh budget low (${result.remaining}); skipping until reset (+${result.sleepMs}ms)`,
        );
        return result.sleepMs;
      }

      printReport(result, 'Cycle report');
      try {
        await runReviewPass(cfg, realRunner);
      } catch (err) {
        console.error('[eng:loop] review pass error (issue cycle unaffected):', err);
      }
      return intervalMs;
    } catch (err) {
      console.error('[eng:loop] Cycle error:', err);
      return intervalMs;
    }
  };

  // --once: one cycle then exit. No signal handlers, no scheduling.
  if (isOnce) {
    await runOneCycle();
    console.log('[eng:loop] --once: first cycle complete, exiting (any spawned sessions continue detached).');
    return;
  }

  // NORMAL mode only: graceful-shutdown handlers (fix jinn-mono#490). On
  // SIGINT/SIGTERM we flip the flag; runLoop finishes the in-flight cycle and
  // declines to schedule the next, so the process exits 0 as the event loop
  // drains (detached child sessions stay alive via child.unref()). runLoop
  // recursively schedules via setTimeout with the next-attempt delay returned
  // by runOneCycle — setTimeout (rather than setInterval) lets the gate's
  // sleepMs drive the next tick when budget is low, and prevents cycle overlap
  // if a snapshot fetch hangs.
  // A one-way latch: the signal handler flips it; runLoop's re-arm seam reads
  // it via isShuttingDown before scheduling the next cycle.
  let shuttingDown = false;
  const onSignal = (): void => { shuttingDown = true; };
  process.once('SIGINT', onSignal);
  process.once('SIGTERM', onSignal);

  await runLoop({ runOnce: runOneCycle, isShuttingDown: () => shuttingDown });
}

// Gate `main()` to direct invocation only — importing this module (e.g. from
// the regression test) must not start the dispatcher loop. Resolve `argv[1]`
// so a relative invocation (e.g. `tsx ./scripts/run-eng-loop.ts`) matches the
// absolute path returned by `fileURLToPath`.
if (argv[1] != null && resolve(argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    console.error('[eng:loop] Fatal error:', err);
    process.exit(1);
  });
}
