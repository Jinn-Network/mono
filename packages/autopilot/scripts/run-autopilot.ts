/**
 * autopilot entry point.
 *
 * Usage:
 *   yarn autopilot                     # run the dispatcher on a 10min interval (normal mode)
 *   yarn autopilot --dry-run           # one cycle, no mutations, prints the CycleReport
 *   yarn autopilot --once              # one cycle live (dispatch up to cap), then exit
 *   yarn autopilot --cap <N>           # override concurrencyCap
 *   yarn autopilot --backpressure <N>  # override openPrBackpressure
 *   yarn autopilot --interval <ms>     # override poll interval (default 600000 = 10min)
 *
 * --once + --cap <N> compose: bound a first live run to at most N dispatches.
 * Defaults live in src/dispatcher/types.ts DEFAULT_CONFIG.
 */

import { GhIssueSource, defaultRunner as realRunner } from '../src/dispatcher/issue-source.js';
import type { CommandRunner } from '../src/dispatcher/issue-source.js';
import { deriveInFlight, listTaskWorktrees } from '../src/dispatcher/state.js';
import { syncReviewLabels } from '../src/dispatcher/label-sweep.js';
import { syncDrift } from '../src/dispatcher/drift-sweep.js';
import { syncMerges, touchesOwned } from '../src/dispatcher/merge-sweep.js';
import { escalateStuckPrs, escalateStuckPr } from '../src/dispatcher/stuck-escalation.js';
import { deriveMergePrepInFlight } from '../src/dispatcher/merge-prep-state.js';
import { dispatchMergePrep } from '../src/dispatcher/merge-prep-dispatch.js';
import { runMergePrepCycle, type PrepAttempt } from '../src/dispatcher/merge-prep-loop.js';
import { dispatchIssue, REPO_ROOT, WORKTREES_BASE } from '../src/dispatcher/dispatch.js';
import { runDeliveryBridge } from '../src/dispatcher/delivery-pr-bridge.js';
import { HttpDeliveryReader } from '../src/dispatcher/delivery-reader.js';
import { routeToMarketplace, retractStaleMarketplaceRoutes } from '../src/dispatcher/marketplace-route.js';
import { SESSIONS_LOG_DIR } from '../src/dispatcher/session-log.js';
import { GhPrSource } from '../src/dispatcher/pr-source.js';
import { fetchIssuePrMap } from '../src/dispatcher/pr-links.js';
import type { PrLink } from '../src/dispatcher/pr-links.js';
import { deriveReviewInFlight } from '../src/dispatcher/review-state.js';
import { dispatchReview } from '../src/dispatcher/review-dispatch.js';
import { runReviewCycle } from '../src/dispatcher/review-loop.js';
import {
  cleanupReviewWorktree,
  type ReviewCleanupOptions,
} from '../src/dispatcher/review-cleanup.js';
import {
  makeFileReviewLeaseStore,
  reviewWorktreePath,
  type ReviewLeaseStore,
} from '../src/dispatcher/review-lease.js';
import { assertReviewIdentities, assertMergePrepArming } from '../src/dispatcher/identity.js';
import type { SpawnFn } from '../src/dispatcher/dispatch.js';
import type { ReviewablePr } from '../src/dispatcher/types.js';
import {
  fetchFieldIds,
  getFieldCache,
  resetFieldCache,
} from '../src/dispatcher/field-cache.js';
import { makePauseSession } from '../src/dispatcher/pause-session.js';
import { syncHumanLane } from '../src/dispatcher/human-lane.js';
import { syncStackBases } from '../src/dispatcher/stack-sweep.js';
import { runCycle } from '../src/dispatcher/loop.js';
import type { CycleReport } from '../src/dispatcher/loop.js';
import { fetchProjectSnapshot } from '../src/dispatcher/project-snapshot.js';
import type { ProjectSnapshot } from '../src/dispatcher/project-snapshot.js';
import { gateOrRun, isSkipped } from '../src/dispatcher/rate-limit-guard.js';
import { classifyRateLimitError } from '../src/dispatcher/rate-limit-error.js';
import { GhPrSink } from '../src/dispatcher/delivery-sink.js';
import type { DeliverySink } from '../src/dispatcher/delivery-sink.js';
import { DEFAULT_CONFIG } from '../src/dispatcher/types.js';
import type { DispatcherConfig, ReadyIssue, InFlightSession, SessionResult } from '../src/dispatcher/types.js';
import {
  AUTOPILOT_RUNTIME_ENV,
  parseAutopilotRuntime,
} from '../src/autopilot-runtime.js';
import {
  assertHermesBillingRoute,
  assertHermesRuntimeReady,
} from '../src/dispatcher/hermes-runtime.js';
import { WallClock } from '../src/dispatcher/wall-clock.js';
import {
  shouldRouteToSession,
  shouldRouteToSessions,
} from '../src/cli/routing.js';
import { spawn } from 'node:child_process';
import type { ChildProcess, SpawnOptions } from 'node:child_process';
import { mkdirSync, openSync, closeSync, writeSync, writeFileSync } from 'node:fs';
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
const IMPL_GH_TOKEN_ENV = 'JINN_IMPL_GH_TOKEN';
const REVIEW_GH_TOKEN_ENV = 'JINN_REVIEW_GH_TOKEN';
/** Arm the merge-prep session loop (DR-2026-07-16). '1' = on. Default off. */
const MERGE_PREP_ENV = 'JINN_MERGE_PREP';
/** Arm the delivery→PR bridge (issue #1892). '1' = on. Default off. */
const MARKETPLACE_BRIDGE_ENV = 'JINN_MARKETPLACE_BRIDGE';
/** Indexer base URL the delivery→PR bridge queries. Empty disables it regardless of the flag above. */
const MARKETPLACE_INDEXER_URL_ENV = 'JINN_MARKETPLACE_INDEXER_URL';
/** IPFS gateway base URL for the delivery→PR bridge. */
const MARKETPLACE_IPFS_GATEWAY_ENV = 'JINN_MARKETPLACE_IPFS_GATEWAY_URL';
/**
 * Creation-automation execution-mode switch (issue #1893). `'marketplace'`
 * arms it; anything else (unset, typo, empty) is the fail-safe `'local'`
 * default — mirrors the `mergePrepEnabled` / `marketplaceBridgeEnabled`
 * fail-safe-off convention.
 */
const EXECUTION_MODE_ENV = 'JINN_EXECUTION_MODE';

/**
 * Model / provider / Python interpreter for Hermes coordinator sessions.
 * Hermes is active only when JINN_AUTOPILOT_RUNTIME=hermes. Defaults mirror
 * the operator's own Codex setup (bare `gpt-5.6-sol` + `openai-codex`), which
 * runs on the ChatGPT/Codex subscription — NOT OpenRouter.
 */
const HERMES_MODEL_ENV = 'JINN_DISPATCHER_HERMES_MODEL';
const HERMES_PROVIDER_ENV = 'JINN_DISPATCHER_HERMES_PROVIDER';
const HERMES_PYTHON_ENV = 'JINN_DISPATCHER_HERMES_PYTHON';

function attachTerminalCleanup(
  child: ChildProcess,
  onExit: Parameters<SpawnFn>[2]['onExit'],
): void {
  if (onExit == null) return;
  let handled = false;
  const finish = (
    code: number | null,
    signal: NodeJS.Signals | null,
  ): void => {
    if (handled) return;
    handled = true;
    try {
      onExit(code, signal);
    } catch (err) {
      console.error('[autopilot] detached child terminal cleanup failed:', err);
    }
  };
  child.once('error', () => finish(null, null));
  child.once('exit', finish);
}

/**
 * Build the production logging `SpawnFn` (#533): open the per-session log in
 * append mode wired to stdout+stderr, write the dispatch delimiter and (when
 * supplied) the started-at marker, then spawn detached + unref. Shared by the
 * implement-dispatch and merge-prep-dispatch call sites so both get identical
 * per-session log capture. Extracted verbatim from the former inline lambda.
 */
function makeLoggingSpawn(): SpawnFn {
  return (cmd, args, opts) => {
    const logPath = opts.logPath;
    let fd: number | undefined;
    let stdio = opts.stdio;
    if (typeof logPath === 'string') {
      mkdirSync(SESSIONS_LOG_DIR, { recursive: true });
      // Owner-only (0o600) on create: session logs may contain secrets surfaced
      // by the spawned session (tokens in gh/git error output, env echoes).
      fd = openSync(logPath, 'a', 0o600);
      const delimiter =
        `\n===== dispatch ${new Date().toISOString()} ` +
        `pid=pending cwd=${opts.cwd} =====\n`;
      writeSync(fd, delimiter);
      stdio = ['ignore', fd, fd];
    }
    // #1296/#1393: rewrite (truncate) the started-at marker so its mtime records
    // the LATEST dispatch (only implement sessions supply this path).
    if (typeof opts.startedAtMarkerPath === 'string') {
      writeFileSync(opts.startedAtMarkerPath, `${new Date().toISOString()}\n`, { mode: 0o600 });
    }
    const { onExit, ...spawnOpts } = opts;
    const child = spawn(cmd, args, { ...spawnOpts, stdio } as SpawnOptions);
    attachTerminalCleanup(child, onExit);
    if (child.pid != null) child.unref();
    // Close the parent's dup of the fd; the detached child kept its own.
    if (fd != null) closeSync(fd);
    return { pid: child.pid };
  };
}

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

export function printReport(report: CycleReport, label: string): void {
  console.log(`\n[${ new Date().toISOString() }] ${label}`);
  console.log('─'.repeat(60));

  if (report.backpressureTripped) {
    console.log('⚠  BACKPRESSURE TRIPPED — too many open ready PRs; no new dispatches.');
  }

  if (report.dispatched.length === 0) {
    if (!report.backpressureTripped) console.log('   dispatched: (none)');
  } else {
    // One line per dispatched session, carrying pid + log path (#533 AC#2).
    console.log('   dispatched:');
    for (const s of report.dispatched) {
      const pid = s.pid === null ? 'unknown' : String(s.pid);
      console.log(`     #${s.issueNumber} pid=${pid} log=${s.logPath}`);
    }
  }

  if (report.routedToMarketplace.length > 0) {
    console.log('   routed to marketplace:');
    for (const r of report.routedToMarketplace) {
      console.log(`     #${r.issueNumber} (${r.action})`);
    }
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

  if (report.dispatchErrors.length > 0) {
    console.log('\n   DISPATCH ERRORS (issue stays In Progress; drift sweep reconciles):');
    for (const e of report.dispatchErrors) {
      console.log(`     #${e.issueNumber}: ${e.message}`);
    }
  }

  if (report.drift.length > 0) {
    console.log('\n   DRIFT:');
    for (const d of report.drift) {
      console.log(`     ${d}`);
    }
  } else {
    console.log('   drift: (none)');
  }

  if (report.collected.length > 0) {
    const rendered = report.collected
      .map((c) =>
        c.outcome === 'pr-opened'
          ? `#${c.issueNumber}→PR#${c.prNumber ?? '?'}`
          : `#${c.issueNumber}→escalated`,
      )
      .join(', ');
    console.log(`   collected: ${rendered}`);
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
    console.log('[autopilot] DRY RUN — polling live issue queue; will NOT dispatch, mutate board, or create worktrees.');

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
        logPath: `(dry-run)`,
      };
    };

    // Dry-run stub for pauseSession — logs the intent but makes NO gh mutation,
    // honouring the banner promise "will NOT dispatch, mutate board, or create worktrees".
    const dryPauseSession = async (issueNumber: number): Promise<void> => {
      console.log(`[dry-run] would pause #${issueNumber} (wall-clock ceiling) — no board mutation.`);
    };

    // Dry-run stub for routeToMarketplace (issue #1893) — logs the intent but
    // makes NO gh mutation (no label, no comment), same promise as dryDispatch.
    const wouldRouteToMarketplace: number[] = [];
    const dryRouteToMarketplace = async (
      issue: ReadyIssue,
    ): Promise<import('../src/dispatcher/loop.js').MarketplaceRoutedIssue> => {
      wouldRouteToMarketplace.push(issue.number);
      console.log(`[dry-run] would route #${issue.number} to the marketplace — no label/comment mutation.`);
      return { issueNumber: issue.number, action: 'created' };
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
      routeToMarketplace: dryRouteToMarketplace,
      countOpenReadyPrs,
      // Dry-run still polls the live PR map so the "would dispatch" list
      // includes dependency-stacked issues (read-only, no mutation).
      fetchIssuePrMap: () => fetchIssuePrMap(runner),
      wallClock,
      pauseSession: dryPauseSession,
      // Dry-run: no cross-cycle memory and no sink calls (mutation-free,
      // consistent with dryDispatch / dryPauseSession). (#489)
      prevInFlight: [],
      collectCompletions: async () => [],
    });

    printReport(report, 'Cycle report (DRY RUN — no mutations)');

    if (wouldDispatch.length > 0) {
      console.log(`\n[dry-run] Would have dispatched: ${wouldDispatch.map((n) => `#${n}`).join(', ')}`);
    } else if (wouldRouteToMarketplace.length === 0) {
      console.log('\n[dry-run] No issues would be dispatched this cycle.');
    }
    if (wouldRouteToMarketplace.length > 0) {
      console.log(`\n[dry-run] Would have routed to the marketplace: ${wouldRouteToMarketplace.map((n) => `#${n}`).join(', ')}`);
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[autopilot] dry-run aborted: ${msg} — run \`gh api rate_limit\` to check budget`);
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
  reviewLeaseStore?: ReviewLeaseStore,
  cleanupOptions?: ReviewCleanupOptions,
): Promise<void> {
  if (cfg.reviewBotLogin.length === 0) return; // disabled — fail-safe
  const spawnImpl: SpawnFn =
    spawnFn ??
    ((cmd, args, opts) => {
      const { onExit, ...spawnOpts } = opts;
      const child = spawn(cmd, args, spawnOpts as SpawnOptions);
      attachTerminalCleanup(child, onExit);
      if (child.pid != null) child.unref();
      return { pid: child.pid };
    });
  const prSource = new GhPrSource(runner, cfg.engineReviewLabel, cfg.reviewBotLogin);
  const leaseStore = reviewLeaseStore ?? makeFileReviewLeaseStore();
  // Exclude PRs with a live merge-prep session from review dispatch (symmetric
  // to the prep loop's reviewInFlight guard) so the two never push to the same
  // branch at once. Only relevant when merge-prep is armed.
  const busyPrNumbers = cfg.mergePrepEnabled
    ? new Set<number>((await deriveMergePrepInFlight(runner)).inFlight.map((w) => w.prNumber))
    : undefined;
  const report = await runReviewCycle({
    prSource,
    cfg,
    deriveReviewInFlight: () => deriveReviewInFlight(runner, leaseStore),
    isProcessAlive: (pid) => {
      try {
        process.kill(pid, 0);
        return true;
      } catch (err) {
        return !(
          typeof err === 'object' &&
          err != null &&
          'code' in err &&
          err.code === 'ESRCH'
        );
      }
    },
    removeWorktree: async (review) => {
      const canonicalPath = reviewWorktreePath(review.prNumber);
      if (review.worktreePath !== canonicalPath) {
        throw new Error(
          `Refusing non-canonical review worktree cleanup: ${review.worktreePath}`,
        );
      }
      if (review.leaseId == null || review.pid == null) {
        throw new Error(
          `Refusing review cleanup without persisted ownership generation: PR #${review.prNumber}`,
        );
      }
      await cleanupReviewWorktree({
        version: 2,
        leaseId: review.leaseId,
        prNumber: review.prNumber,
        worktreePath: canonicalPath,
        pid: review.pid,
        startedAt: review.startedAt,
      }, runner, leaseStore, cleanupOptions);
    },
    dispatchReview: (pr: ReviewablePr) => dispatchReview(
      pr,
      cfg,
      { runner, spawn: spawnImpl, leaseStore, cleanupOptions },
    ),
    busyPrNumbers,
  });
  if (report.dispatched.length > 0) {
    console.log(`[autopilot] review-pr dispatched: PR #${report.dispatched.join(', #')}`);
  }
  if (report.reaped.length > 0) {
    console.log(
      `[autopilot] review reaped stale worktree → PR #${report.reaped.join(', #')}`,
    );
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
      console.log('[autopilot] shutdown requested — finishing current cycle, not scheduling new ones');
      return;
    }
    schedule(() => { void runOnce().then(scheduleNext); }, delay);
  };
  const firstDelay = await runOnce();
  scheduleNext(firstDelay);
}

// ---------------------------------------------------------------------------
// makeCollectCompletions — the concrete finished-session classifier (#489)
//
// `loop.ts` stays gh/git-free: it hands the previous + current in-flight sets
// to this dep, which diffs them, classifies each finished session from
// authoritative external state (the per-cycle ProjectSnapshot), recovers the
// PR number for In-Review issues via `gh pr list --head <branch>`, and hands
// each SessionResult to the DeliverySink. Exported for unit testing (mirrors
// `runDryRun` / `runReviewPass`).
//
// A session "finished" iff it was in `prev` but not in `current`. It leaves
// the in-flight set either by transitioning to "In Review" (⇒ pr-opened) or by
// any other off-"In Progress" move, e.g. "Blocked on: Human" (⇒ escalated).
// Each session's body is wrapped so one classifier failure cannot stop the
// rest from being collected (mirrors the review-pass error isolation).
// ---------------------------------------------------------------------------

export function makeCollectCompletions(
  snapshot: ProjectSnapshot,
  runner: CommandRunner,
  sink: DeliverySink,
): (prev: InFlightSession[], current: InFlightSession[]) => Promise<SessionResult[]> {
  return async (prev, current) => {
    const currentNumbers = new Set(current.map((s) => s.issueNumber));
    const finished = prev.filter((s) => !currentNumbers.has(s.issueNumber));

    const results: SessionResult[] = [];
    for (const session of finished) {
      try {
        const item = snapshot.items.find(
          (i) => i.contentType === 'Issue' && i.number === session.issueNumber,
        );

        let result: SessionResult;
        if (item?.status === 'In Review') {
          // PR-opened: recover the PR number from the head branch. `gh pr list`
          // is REST — it does not consume the GraphQL budget the gate guards.
          let prNumber: number | undefined;
          try {
            const raw = await runner('gh', [
              'pr', 'list',
              '--repo', REPO,
              '--head', session.branch,
              '--state', 'open',
              '--json', 'number',
            ]);
            const prs = JSON.parse(raw) as Array<{ number: number }>;
            prNumber = prs[0]?.number;
          } catch (err) {
            console.error(
              `[autopilot] could not look up PR for #${session.issueNumber} (${session.branch}):`,
              err,
            );
          }
          result = { issueNumber: session.issueNumber, outcome: 'pr-opened', prNumber };
        } else {
          // Left "In Progress" without reaching "In Review" — treat as escalated.
          result = { issueNumber: session.issueNumber, outcome: 'escalated' };
        }

        await sink.collect(result);
        results.push(result);
      } catch (err) {
        console.error(
          `[autopilot] collectCompletions error for #${session.issueNumber} (continuing):`,
          err,
        );
      }
    }
    return results;
  };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  if (shouldRouteToSession(process.argv)) {
    const { runSessionCli } = await import('../src/cli/session.js');
    await runSessionCli(process.argv.slice(3));
    return;
  }
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
    runtime: parseAutopilotRuntime(process.env[AUTOPILOT_RUNTIME_ENV]),
    ...(capOk ? { concurrencyCap: capOverride } : {}),
    ...(bpOk ? { openPrBackpressure: bpOverride } : {}),
    authorAllowlist,
    reviewBotLogin: process.env[REVIEW_BOT_LOGIN_ENV] ?? '',
    implGhToken: process.env[IMPL_GH_TOKEN_ENV] ?? '',
    reviewGhToken: process.env[REVIEW_GH_TOKEN_ENV] ?? '',
    mergePrepEnabled: (process.env[MERGE_PREP_ENV] ?? '') === '1',
    executionMode: process.env[EXECUTION_MODE_ENV] === 'marketplace' ? 'marketplace' : 'local',
    marketplaceBridgeEnabled: (process.env[MARKETPLACE_BRIDGE_ENV] ?? '') === '1',
    marketplaceIndexerUrl: process.env[MARKETPLACE_INDEXER_URL_ENV] ?? '',
    ...(process.env[MARKETPLACE_IPFS_GATEWAY_ENV]
      ? { marketplaceIpfsGatewayUrl: process.env[MARKETPLACE_IPFS_GATEWAY_ENV] }
      : {}),
    ...(process.env[HERMES_MODEL_ENV] ? { hermesModel: process.env[HERMES_MODEL_ENV] } : {}),
    ...(process.env[HERMES_PROVIDER_ENV] ? { hermesProvider: process.env[HERMES_PROVIDER_ENV] } : {}),
    ...(process.env[HERMES_PYTHON_ENV]
      ? { hermesPythonPath: process.env[HERMES_PYTHON_ENV] }
      : {}),
  };

  console.log(`[autopilot] runtime=${cfg.runtime}`);

  if (cfg.authorAllowlist.length === 0) {
    // Fail-safe per spec 2026-05-23-author-allowlist-design.md: empty
    // allowlist means dispatch nothing. Warn loudly so a misconfigured
    // deploy is visible from the very first cycle log.
    console.warn(
      `[autopilot] WARNING: authorAllowlist is empty — no issues will be dispatched. ` +
        `Set ${AUTHOR_ALLOWLIST_ENV}=login1,login2,... to enable dispatch.`,
    );
  } else {
    console.log(
      `[autopilot] authorAllowlist (${cfg.authorAllowlist.length}): ${cfg.authorAllowlist.join(', ')}`,
    );
  }

  if (cfg.reviewBotLogin.length === 0) {
    console.warn(
      `[autopilot] WARNING: ${REVIEW_BOT_LOGIN_ENV} unset — the review-pr loop is disabled ` +
        `(cannot detect a current review without the bot login). Set ${REVIEW_BOT_LOGIN_ENV}=<login> to enable.`,
    );
  } else {
    console.log(`[autopilot] review-pr enabled (bot=${cfg.reviewBotLogin}, label=${cfg.engineReviewLabel}, cap=${cfg.reviewCap})`);
  }

  // Fail-loud dual-identity check (DR-2026-06-15 gate 5): refuse to start a
  // misconfigured review loop — reviewer == author, a token whose account does
  // not match reviewBotLogin, or missing tokens — rather than spinning silently
  // or posting self-approvals that GitHub rejects. No-op when review is off.
  await assertReviewIdentities(cfg, realRunner);

  // Fail-loud merge-prep arming (DR-2026-07-16): a prepped PR is re-drafted and
  // relies on the review loop to re-approve/un-draft it — refuse to arm
  // merge-prep without the review loop, or every prep wedges its PR in draft.
  assertMergePrepArming(cfg);
  if (cfg.mergePrepEnabled) {
    console.log(`[autopilot] merge-prep enabled (cap=${cfg.mergePrepCap}) — stuck PRs are prepped, not just escalated`);
  }

  // Creation automation (issue #1893): 'marketplace' routes ready issues to
  // the marketplace (label + snapshot marker) instead of a local session.
  // Default 'local' — every existing local-mode behavior is unchanged.
  if (cfg.executionMode === 'marketplace') {
    console.log(
      '[autopilot] executionMode=marketplace — ready issues are routed to the marketplace, ' +
        'not dispatched to local sessions',
    );
  }

  // Hermes is a process-wide runtime. Refuse to boot unless its interpreter,
  // imports, bare model, and subscription provider are all valid.
  if (cfg.runtime === 'hermes') {
    assertHermesBillingRoute(cfg.hermesModel, cfg.hermesProvider);
    assertHermesRuntimeReady(cfg.hermesPythonPath);
    console.log(
      `[autopilot] hermes runtime ready (model=${cfg.hermesModel}, provider=${cfg.hermesProvider}, ` +
        `python=${cfg.hermesPythonPath})`,
    );
  }

  // Delivery→PR bridge (issue #1892): both the flag AND the indexer URL must
  // be set — an empty URL disables the bridge even if the flag is on
  // (fail-safe, mirrors the reviewBotLogin/authorAllowlist convention).
  const deliveryReader = cfg.marketplaceBridgeEnabled && cfg.marketplaceIndexerUrl !== ''
    ? new HttpDeliveryReader({
        indexerUrl: cfg.marketplaceIndexerUrl,
        ipfsGatewayUrl: cfg.marketplaceIpfsGatewayUrl,
      })
    : null;
  if (cfg.marketplaceBridgeEnabled && deliveryReader == null) {
    console.warn(
      `[autopilot] WARNING: ${MARKETPLACE_BRIDGE_ENV}=1 but ${MARKETPLACE_INDEXER_URL_ENV} is unset — ` +
        'the delivery→PR bridge is disabled this run.',
    );
  } else if (deliveryReader != null) {
    console.log(`[autopilot] delivery-pr-bridge enabled (indexer=${cfg.marketplaceIndexerUrl})`);
  }

  const source = new GhIssueSource(realRunner);
  const wallClock = new WallClock(cfg.wallClockMs);

  // Cross-cycle memory of the in-flight set (#489). The orchestrator owns this
  // so `loop.ts` stays pure. Empty on the first cycle; losing it on restart
  // costs at most one un-collected log line, not a correctness bug.
  let previousInFlight: InFlightSession[] = [];
  // One `gh pr update-branch` per BEHIND PR per process run (merge sweep,
  // #1735) — still-behind-after-update is surfaced, never retried forever.
  const attemptedUpdateBranch = new Set<number>();
  // Per-process merge-prep attempt tracking (DR-2026-07-16): a same-head second
  // sighting escalates; ≤MAX_PREP_ATTEMPTS across advancing heads. Lost on
  // restart (same tradeoff as attemptedUpdateBranch).
  const attemptedPrep = new Map<number, PrepAttempt>();

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
  // AUTOPILOT_RESET_FIELD_CACHE=1 env knob is symbolic on first boot — the
  // cache starts null — but documents operator intent for future long-lived
  // dispatcher modes that may re-enter main(). Do not delete as dead code.
  // (jinn-mono#599)
  if (process.env.AUTOPILOT_RESET_FIELD_CACHE === '1') {
    // Make the symbolism honest in the boot log (Stage 5 Finding 3 on
    // jinn-mono#599) — on first boot the singleton is null, so this is a
    // no-op; the call is preserved as the documented invariant for future
    // long-running modes that re-enter main() without a fresh process.
    console.log(
      '[autopilot] AUTOPILOT_RESET_FIELD_CACHE=1 — cache cleared (symbolic at boot; primary use is re-entry from a long-running mode).',
    );
    resetFieldCache();
  }
  const fieldCache = await fetchFieldIds(realRunner);
  console.log(`[autopilot] field cache populated (projectId=${fieldCache.projectId})`);

  // Normal mode: run on an interval (or once + exit when --once)
  console.log(
    `[autopilot] Starting dispatcher (cap=${cfg.concurrencyCap}, backpressure=${cfg.openPrBackpressure}, ` +
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
          '[autopilot] field cache is null at cycle entry — main() must populate it via fetchFieldIds before any cycle runs',
        );
      }

      // Keep the `Human` Status lane mirroring "blocked on a human": promote
      // Todo/In-Progress + `Blocked on: Human` issues into it (the operator's
      // single "needs my eyes" view), and demote unblocked items back to Todo so
      // clearing the block re-readies them. Infra-side — covers wall-clock and
      // in-session escalations uniformly; idempotent. Best-effort: failures are
      // logged, not fatal (the leak fix already frees slots via the `Blocked on`
      // marker, so a missed move only delays the visual sync, never wedges).
      try {
        const { promoted, demoted } = await syncHumanLane(snapshot, cycleFieldCache, realRunner);
        if (promoted.length > 0) {
          console.log(`[autopilot] → Status: Human (blocked on human) → #${promoted.join(', #')}`);
        }
        if (demoted.length > 0) {
          console.log(`[autopilot] Status: Human → Todo (unblocked) → #${demoted.join(', #')}`);
        }
      } catch (err) {
        console.error('[autopilot] Human-lane sync error (cycle unaffected):', err);
      }

      // Fetch the issue→PR map ONCE per cycle and share it: the stacked-base
      // sweep (below) and the dependency resolver inside runCycle (via the
      // injected `fetchIssuePrMap` closure) both consume it, so one `gh pr list`
      // serves both and they reason about the same PR snapshot. Best-effort — a
      // failure degrades both to "no dependency awareness this cycle", never
      // fatal. (REST, not GraphQL budget.) (review 2026-07-13)
      let cyclePrByIssue: Map<number, PrLink[]> = new Map();
      try {
        cyclePrByIssue = await fetchIssuePrMap(realRunner);
      } catch (err) {
        console.error('[eng:loop] PR-map fetch error (dependency features degraded this cycle):', err);
      }

      // Abandoned-base re-block sweep (spec 2026-07-13 §4): a child dispatched
      // stacked on its blocker's open PR is left on a dead branch if that PR is
      // closed without merging (GitHub only auto-retargets on merge). Park such
      // a child to `Blocked on: Human` + comment so a human resolves it.
      try {
        const { reblocked } = await syncStackBases(snapshot, cyclePrByIssue, cycleFieldCache, realRunner);
        if (reblocked.length > 0) {
          console.log(`[eng:loop] stacked base abandoned → re-blocked (Human): #${reblocked.join(', #')}`);
        }
      } catch (err) {
        console.error('[eng:loop] stack-base sweep error (cycle unaffected):', err);
      }

      // Review-label enforcement (#1733): a session PR opened without the
      // review label is invisible to the review loop (GhPrSource polls BY the
      // label), so skill drift silently opts a PR out of review — observed
      // live 2026-07-15 (#1730/#1731). Re-apply it from the shared PR map.
      const cycleAllowlist: ReadonlySet<string> = new Set(
        cfg.authorAllowlist.map((s) => s.toLowerCase()),
      );
      try {
        const { labeled } = await syncReviewLabels(
          cyclePrByIssue, cycleAllowlist, realRunner, cfg.engineReviewLabel,
        );
        if (labeled.length > 0) {
          console.log(`[autopilot] review label re-applied → PR #${labeled.join(', PR #')}`);
        }
      } catch (err) {
        console.error('[autopilot] label sweep error (cycle unaffected):', err);
      }

      // Self-healing drift sweep (#1734): reconcile board↔worktree drift
      // instead of only logging it — phantoms re-queue or move to In Review,
      // stale worktrees are removed (branch refs preserve commits), dead
      // sessions' stranded branches are reaped into draft PRs.
      try {
        const taskWorktrees = await listTaskWorktrees(realRunner);
        const dr = await syncDrift(
          snapshot, cyclePrByIssue, taskWorktrees, cycleFieldCache, realRunner,
        );
        if (dr.toInReview.length > 0) {
          console.log(`[autopilot] drift: phantom → In Review (open PR) → #${dr.toInReview.join(', #')}`);
        }
        if (dr.toTodo.length > 0) {
          console.log(`[autopilot] drift: phantom → Todo (no PR, re-dispatchable) → #${dr.toTodo.join(', #')}`);
        }
        if (dr.removed.length > 0) {
          console.log(`[autopilot] drift: stale worktrees removed → #${dr.removed.join(', #')}`);
        }
        for (const r of dr.reaped) {
          console.log(`[autopilot] drift: strand reaped → #${r.issueNumber} → draft PR #${r.prNumber ?? '?'}`);
        }
        for (const s of dr.skipped) {
          console.log(`[autopilot] drift (needs a human): ${s}`);
        }
      } catch (err) {
        console.error('[autopilot] drift sweep error (cycle unaffected):', err);
      }

      // Auto-merge sweep (#1735, handbook rule-4 carve-out): merge PRs that
      // are engine-approved + un-drafted + CI-green + non-code-owned. Runs
      // only while the review loop is armed — the approvals it trusts come
      // from that loop's independent reviewer identity.
      if (cfg.reviewBotLogin !== '') {
        try {
          const mr = await syncMerges(
            realRunner, cycleAllowlist, attemptedUpdateBranch, cfg.engineReviewLabel,
          );
          if (mr.merged.length > 0) {
            console.log(`[autopilot] auto-merged → PR #${mr.merged.join(', PR #')}`);
          }
          if (mr.updatedBranch.length > 0) {
            console.log(`[autopilot] merge: update-branch (BEHIND) → PR #${mr.updatedBranch.join(', PR #')}`);
          }
          for (const s of mr.skipped) {
            console.log(`[autopilot] merge (waiting/needs a human): ${s}`);
          }
          // Stuck PRs (conflict / still-behind). Armed → the merge-prep session
          // resolves mechanical conflicts and escalates the rest (DR-2026-07-16).
          // Disarmed → Stage A deterministic escalation only (label
          // review:needs-human + linked-issue Blocked on: Human + one comment).
          // Both are idempotent via StuckPr.escalated.
          if (mr.stuck.length > 0 && cfg.mergePrepEnabled) {
            const reviewInFlight = new Set<number>(
              (await deriveReviewInFlight(realRunner)).inFlight.map((r) => r.prNumber),
            );
            const mp = await runMergePrepCycle({
              stuck: mr.stuck,
              cfg,
              attemptedPrep,
              reviewInFlight,
              deriveInFlight: () => deriveMergePrepInFlight(realRunner),
              dispatch: (s) => dispatchMergePrep(s, cfg, { runner: realRunner, spawn: makeLoggingSpawn() }),
              escalate: async (s, why) => {
                console.log(`[autopilot] merge-prep: escalating PR #${s.number} — ${why}`);
                await escalateStuckPr(s, snapshot, cyclePrByIssue, cycleFieldCache, realRunner);
              },
              isCodeOwned: (n) => touchesOwned(n, realRunner),
              removeWorktree: async (w) => {
                await realRunner('git', ['worktree', 'remove', '--force', w.worktreePath]);
              },
            });
            if (mp.dispatched.length > 0) console.log(`[autopilot] merge-prep dispatched → PR #${mp.dispatched.join(', PR #')}`);
            if (mp.escalated.length > 0) console.log(`[autopilot] merge-prep escalated (needs-human) → PR #${mp.escalated.join(', PR #')}`);
            if (mp.reaped.length > 0) console.log(`[autopilot] merge-prep reaped stale worktree → PR #${mp.reaped.join(', PR #')}`);
            if (mp.waiting.length > 0) console.log(`[autopilot] merge-prep waiting (in-flight) → PR #${mp.waiting.join(', PR #')}`);
          } else if (mr.stuck.length > 0) {
            const esc = await escalateStuckPrs(
              mr.stuck, snapshot, cyclePrByIssue, cycleFieldCache, realRunner,
            );
            if (esc.escalated.length > 0) {
              console.log(
                `[autopilot] merge: stuck → escalated (needs-human) → PR #${esc.escalated.join(', PR #')}`,
              );
            }
            for (const sk of esc.skipped) {
              console.log(`[autopilot] merge: stuck escalation skipped: ${sk}`);
            }
          }
        } catch (err) {
          console.error('[autopilot] merge sweep error (cycle unaffected):', err);
        }
      }

      // Delivery→PR bridge (issue #1892): marketplace-delivered jinn-repo.v1
      // solution envelopes become draft PRs. Best-effort — a failure here
      // never affects the rest of the cycle. No-op when disabled or
      // unconfigured (deliveryReader is null).
      if (deliveryReader != null) {
        try {
          const br = await runDeliveryBridge(deliveryReader, realRunner, {
            enabled: cfg.marketplaceBridgeEnabled,
            repoRoot: REPO_ROOT,
            worktreesBase: WORKTREES_BASE,
            ipfsGatewayUrl: cfg.marketplaceIpfsGatewayUrl,
            reviewLabel: cfg.engineReviewLabel,
          });
          for (const o of br.opened) {
            console.log(`[autopilot] delivery-bridge: opened PR #${o.prNumber ?? '?'} for #${o.issueNumber} (${o.branch})`);
          }
          for (const s of br.stalled) {
            console.log(`[autopilot] delivery-bridge: stalled #${s.issueNumber} — ${s.reason}`);
          }
          for (const sk of br.skipped) {
            console.log(`[autopilot] delivery-bridge: ${sk}`);
          }
        } catch (err) {
          console.error('[autopilot] delivery-bridge error (cycle unaffected):', err);
        }
      }

      // Build a per-cycle pause closure that resolves the project item id
      // from the snapshot already in scope (jinn-mono#599) — no extra
      // `gh project item-list` call per pause.
      const pauseSessionForCycle = makePauseSession(snapshot, cycleFieldCache, realRunner);

      // Derive the in-flight set once and reuse it (a) inside the cycle via the
      // injected closure and (b) as next cycle's `previousInFlight` for the
      // finished-session diff (#489). Computing it here avoids a second
      // board+worktree walk.
      const { inFlight, drift } = await deriveInFlight(snapshot, realRunner);

      // Allow operators to override the rate-limit floor via env (mainly for
      // testing the gate). AUTOPILOT_RATELIMIT_FLOOR=4999 forces the gate to
      // trip on the next cycle for verification.
      const floorEnv = process.env.AUTOPILOT_RATELIMIT_FLOOR;
      const floorOverride = floorEnv != null && /^\d+$/.test(floorEnv)
        ? parseInt(floorEnv, 10)
        : undefined;

      const result = await gateOrRun(snapshot, {
        source,
        cfg,
        deriveInFlight: () => Promise.resolve({ inFlight, drift }),
        dispatchIssue: (issue) =>
          dispatchIssue(issue, cfg, {
            runner: realRunner,
            spawn: makeLoggingSpawn(),
            fieldCache: cycleFieldCache,
          }),
        routeToMarketplace: (issue) => routeToMarketplace(issue, realRunner),
        countOpenReadyPrs,
        // Reuse the map fetched once above (shared with the stacked-base sweep).
        fetchIssuePrMap: () => Promise.resolve(cyclePrByIssue),
        wallClock,
        pauseSession: pauseSessionForCycle,
        prevInFlight: previousInFlight,
        collectCompletions: makeCollectCompletions(
          snapshot,
          realRunner,
          new GhPrSink(realRunner),
        ),
      }, floorOverride != null ? { floor: floorOverride } : undefined);

      if (isSkipped(result)) {
        console.log(
          `[autopilot] gh budget low (${result.remaining}); skipping until reset (+${result.sleepMs}ms)`,
        );
        // Gate skipped — no cycle ran, so the in-flight set was not acted on.
        // Leave `previousInFlight` unchanged so the next live cycle still sees
        // the correct baseline for its finished-session diff. (#489)
        return result.sleepMs;
      }

      printReport(result, 'Cycle report');

      // Marketplace retract sweep (issue #1893): runs over ALL currently
      // labeled OPEN issues (its own targeted `gh issue list --label` scan —
      // not the board snapshot), independent of this cycle's
      // concurrency/backpressure budget. `result.readyIssueNumbers` is the
      // FULL (unsliced) ready set, so an issue merely excluded by budget is
      // never mistaken for "no longer ready". No-op (and no `gh` calls) when
      // executionMode is `local` (the default).
      if (cfg.executionMode === 'marketplace') {
        try {
          const rr = await retractStaleMarketplaceRoutes(
            new Set(result.readyIssueNumbers),
            realRunner,
          );
          if (rr.retracted.length > 0) {
            console.log(`[autopilot] marketplace: retracted → #${rr.retracted.join(', #')}`);
          }
          for (const sk of rr.skipped) {
            console.log(`[autopilot] marketplace retract-sweep: ${sk}`);
          }
        } catch (err) {
          console.error('[autopilot] marketplace retract-sweep error (cycle unaffected):', err);
        }
      }

      // Live cycle ran: this cycle's in-flight set becomes next cycle's
      // baseline for the finished-session diff. (#489)
      previousInFlight = inFlight;
      try {
        await runReviewPass(cfg, realRunner);
      } catch (err) {
        console.error('[autopilot] review pass error (issue cycle unaffected):', err);
      }
      return intervalMs;
    } catch (err) {
      // #539: a cycle that tripped the GitHub API rate limit (despite the #585
      // proactive guard) backs off to just past the limit's reset instead of
      // re-polling at normal cadence and re-throwing the same error each tick.
      const rl = classifyRateLimitError(err);
      if (rl.isRateLimit) {
        console.warn(
          `[autopilot] rate-limited; resuming at ${rl.resetAt ?? new Date(Date.now() + rl.sleepMs).toISOString()}`,
        );
        return rl.sleepMs;
      }
      console.error('[autopilot] Cycle error:', err);
      return intervalMs;
    }
  };

  // --once: one cycle then exit. No signal handlers, no scheduling.
  if (isOnce) {
    await runOneCycle();
    console.log('[autopilot] --once: first cycle complete, exiting (any spawned sessions continue detached).');
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
// so a relative invocation (e.g. `tsx ./scripts/run-autopilot.ts`) matches the
// absolute path returned by `fileURLToPath`.
if (argv[1] != null && resolve(argv[1]) === fileURLToPath(import.meta.url)) {
  // Capture async faults that escape the awaited chain — notably a rejection
  // from a setTimeout-scheduled cycle, whose promise is voided and never caught
  // by `main().catch` below. Without these handlers Node terminates with a bare
  // "Node.js v<ver>" footer and no stack, leaving the respawn supervisor nothing
  // to diagnose. Log the full reason, then exit non-zero so the supervisor
  // restarts a clean process. Registered only on direct invocation so importing
  // this module (regression test) does not install process-global handlers.
  process.on('unhandledRejection', (reason) => {
    console.error('[autopilot] FATAL unhandledRejection — exiting for supervisor respawn:', reason);
    process.exit(1);
  });
  process.on('uncaughtException', (err) => {
    console.error('[autopilot] FATAL uncaughtException — exiting for supervisor respawn:', err);
    process.exit(1);
  });
  main().catch((err) => {
    console.error('[autopilot] Fatal error:', err);
    process.exit(1);
  });
}
