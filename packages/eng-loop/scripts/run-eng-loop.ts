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
import { runCycle } from '../src/dispatcher/loop.js';
import type { CycleReport } from '../src/dispatcher/loop.js';
import { fetchProjectSnapshot } from '../src/dispatcher/project-snapshot.js';
import { gateOrRun, isSkipped } from '../src/dispatcher/rate-limit-guard.js';
import { DEFAULT_CONFIG } from '../src/dispatcher/types.js';
import type { DispatcherConfig, ReadyIssue } from '../src/dispatcher/types.js';
import { WallClock } from '../src/dispatcher/wall-clock.js';
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

// ---------------------------------------------------------------------------
// pauseSession — wall-clock circuit-breaker (spec §4)
//
// Sets the issue's "Blocked on" Project field to "Human" so the merge-batch
// and eng-day skills skip it. Field/option ids from gh-taxonomy.md (provisioned
// 2026-05-21; re-discover via `gh project field-list 1 --owner Jinn-Network`
// if a field is rebuilt).
// ---------------------------------------------------------------------------

const PROJECT_ID = 'PVT_kwDODh3-Ac4BXYaI';
const BLOCKED_ON_FIELD_ID = 'PVTSSF_lADODh3-Ac4BXYaIzhTdqRo';
const BLOCKED_ON_HUMAN_OPTION_ID = 'a20d20ac';

interface GhProjectItemsForPause {
  items: Array<{
    id: string;
    content?: { number: number; type: string };
  }>;
}

async function pauseSession(issueNumber: number): Promise<void> {
  console.log(`[eng:loop] WALL-CLOCK EXPIRED — pausing session for issue #${issueNumber} (Blocked on: Human)`);

  // Resolve the project item id for this issue
  const itemListRaw = await realRunner('gh', [
    'project', 'item-list', '1',
    '--owner', 'Jinn-Network',
    '--format', 'json',
    '--limit', '500',
  ]);
  const itemsData = JSON.parse(itemListRaw) as GhProjectItemsForPause;
  const item = itemsData.items.find(
    (it) => it.content?.type === 'Issue' && it.content.number === issueNumber,
  );
  if (item == null) {
    console.error(`[eng:loop] pauseSession: issue #${issueNumber} not found in project board — cannot set Blocked on: Human`);
    return;
  }

  // Set Blocked on → Human
  await realRunner('gh', [
    'project', 'item-edit',
    '--id', item.id,
    '--project-id', PROJECT_ID,
    '--field-id', BLOCKED_ON_FIELD_ID,
    '--single-select-option-id', BLOCKED_ON_HUMAN_OPTION_ID,
  ]);

  console.log(`[eng:loop] issue #${issueNumber} set to Blocked on: Human (wall-clock ceiling exceeded).`);
}

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
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
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

  const source = new GhIssueSource(realRunner);
  const wallClock = new WallClock(cfg.wallClockMs);
  // TODO: wire GhPrSink.collect once session-completion detection exists

  if (isDryRun) {
    await runDryRun({ cfg, wallClock });
    return;
  }

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
          }),
        countOpenReadyPrs,
        wallClock,
        pauseSession,
      }, floorOverride != null ? { floor: floorOverride } : undefined);

      if (isSkipped(result)) {
        console.log(
          `[eng:loop] gh budget low (${result.remaining}); skipping until reset (+${result.sleepMs}ms)`,
        );
        return result.sleepMs;
      }

      printReport(result, 'Cycle report');
      return intervalMs;
    } catch (err) {
      console.error('[eng:loop] Cycle error:', err);
      return intervalMs;
    }
  };

  // Run immediately; then either exit (--once) or recursively schedule via
  // setTimeout with the next-attempt delay returned by runOneCycle. Using
  // setTimeout (rather than setInterval) lets the gate's sleepMs drive the
  // next tick when budget is low — and as a side-benefit prevents cycle
  // overlap if a snapshot fetch hangs.
  const firstDelay = await runOneCycle();
  if (isOnce) {
    console.log('[eng:loop] --once: first cycle complete, exiting (any spawned sessions continue detached).');
    return;
  }
  const scheduleNext = (delay: number): void => {
    setTimeout(() => {
      void runOneCycle().then(scheduleNext);
    }, delay);
  };
  scheduleNext(firstDelay);
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
