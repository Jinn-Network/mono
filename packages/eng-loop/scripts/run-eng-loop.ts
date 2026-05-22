/**
 * eng:loop entry point.
 *
 * Usage:
 *   yarn eng:loop                     # run the dispatcher on a 60s interval (normal mode)
 *   yarn eng:loop --dry-run           # one cycle, no mutations, prints the CycleReport
 *   yarn eng:loop --once              # one cycle live (dispatch up to cap), then exit
 *   yarn eng:loop --cap <N>           # override concurrencyCap
 *   yarn eng:loop --backpressure <N>  # override openPrBackpressure
 *
 * --once + --cap <N> compose: bound a first live run to at most N dispatches.
 * Defaults live in src/dispatcher/types.ts DEFAULT_CONFIG.
 */

import { GhIssueSource, defaultRunner as realRunner } from '../src/dispatcher/issue-source.js';
import { deriveInFlight } from '../src/dispatcher/state.js';
import { dispatchIssue } from '../src/dispatcher/dispatch.js';
import { runCycle } from '../src/dispatcher/loop.js';
import type { CycleReport } from '../src/dispatcher/loop.js';
import { DEFAULT_CONFIG } from '../src/dispatcher/types.js';
import type { ReadyIssue } from '../src/dispatcher/types.js';
import { WallClock } from '../src/dispatcher/wall-clock.js';
import { spawn } from 'node:child_process';
import type { SpawnOptions } from 'node:child_process';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const INTERVAL_MS = 60_000; // 1 minute between cycles
const REPO = 'Jinn-Network/mono';

/**
 * Env var carrying the comma-separated GitHub-login allowlist (#497).
 * Empty / unset means dispatch nothing — fail-safe per design.
 */
const AUTHOR_ALLOWLIST_ENV = 'JINN_DISPATCHER_AUTHOR_ALLOWLIST';

/** Parse the allowlist env var into a trimmed, non-empty string array. */
function parseAuthorAllowlist(raw: string | undefined): string[] {
  if (raw == null || raw.trim() === '') return [];
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
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const isDryRun = process.argv.includes('--dry-run');
  const isOnce = process.argv.includes('--once');
  const capIdx = process.argv.indexOf('--cap');
  const capOverride = capIdx >= 0 ? parseInt(process.argv[capIdx + 1] ?? '', 10) : NaN;
  const bpIdx = process.argv.indexOf('--backpressure');
  const bpOverride = bpIdx >= 0 ? parseInt(process.argv[bpIdx + 1] ?? '', 10) : NaN;

  let cfg = DEFAULT_CONFIG;
  if (Number.isInteger(capOverride) && capOverride > 0) {
    cfg = { ...cfg, concurrencyCap: capOverride };
  }
  if (Number.isInteger(bpOverride) && bpOverride > 0) {
    cfg = { ...cfg, openPrBackpressure: bpOverride };
  }

  const authorAllowlist = parseAuthorAllowlist(process.env[AUTHOR_ALLOWLIST_ENV]);
  cfg = { ...cfg, authorAllowlist };

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
    console.log('[eng:loop] DRY RUN — polling live issue queue; will NOT dispatch, mutate board, or create worktrees.');

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

    const report = await runCycle({
      source,
      cfg,
      deriveInFlight: () => deriveInFlight(realRunner),
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

    return;
  }

  // Normal mode: run on an interval (or once + exit when --once)
  console.log(
    `[eng:loop] Starting dispatcher (cap=${cfg.concurrencyCap}, backpressure=${cfg.openPrBackpressure}, ` +
      (isOnce ? 'mode=once' : `interval=${INTERVAL_MS}ms`) +
      ')',
  );

  const runOneCycle = async (): Promise<void> => {
    try {
      const report = await runCycle({
        source,
        cfg,
        deriveInFlight: () => deriveInFlight(realRunner),
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
      });
      printReport(report, 'Cycle report');
    } catch (err) {
      console.error('[eng:loop] Cycle error:', err);
    }
  };

  // Run immediately, then either exit (--once) or schedule on interval.
  await runOneCycle();
  if (isOnce) {
    console.log('[eng:loop] --once: first cycle complete, exiting (any spawned sessions continue detached).');
    return;
  }
  setInterval(() => { void runOneCycle(); }, INTERVAL_MS);
}

main().catch((err) => {
  console.error('[eng:loop] Fatal error:', err);
  process.exit(1);
});
