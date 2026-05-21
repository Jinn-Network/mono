/**
 * eng:loop entry point.
 *
 * Usage:
 *   yarn eng:loop             # run the dispatcher on an interval (normal mode)
 *   yarn eng:loop --dry-run   # one cycle, no mutations, prints the CycleReport
 */

import { GhIssueSource, defaultRunner as realRunner } from '../src/dispatcher/issue-source.js';
import { GhPrSink } from '../src/dispatcher/delivery-sink.js';
import { deriveInFlight } from '../src/dispatcher/state.js';
import { dispatchIssue } from '../src/dispatcher/dispatch.js';
import { runCycle } from '../src/dispatcher/loop.js';
import type { CycleReport } from '../src/dispatcher/loop.js';
import { DEFAULT_CONFIG } from '../src/dispatcher/types.js';
import type { ReadyIssue } from '../src/dispatcher/types.js';
import { spawn } from 'node:child_process';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const INTERVAL_MS = 60_000; // 1 minute between cycles
const REPO = 'Jinn-Network/mono';

// ---------------------------------------------------------------------------
// countOpenReadyPrs — count open PRs awaiting merge ("In Review" on the board)
// ---------------------------------------------------------------------------

interface GhPr {
  number: number;
  state: string;
  isDraft: boolean;
}

async function countOpenReadyPrs(): Promise<number> {
  // Use gh pr list to count open, non-draft PRs (ready for review / merge)
  const raw = await realRunner('gh', [
    'pr', 'list',
    '--repo', REPO,
    '--state', 'open',
    '--json', 'number,state,isDraft',
    '--limit', '200',
  ]);
  const prs: GhPr[] = JSON.parse(raw) as GhPr[];
  // Count open, non-draft PRs — these are the ones waiting for human attention
  return prs.filter((pr) => !pr.isDraft).length;
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

  const cfg = DEFAULT_CONFIG;
  const source = new GhIssueSource(realRunner);
  const _sink = new GhPrSink(realRunner); // constructed; used for future wiring

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

    const report = await runCycle({
      source,
      cfg,
      deriveInFlight: () => deriveInFlight(realRunner),
      dispatchIssue: dryDispatch,
      countOpenReadyPrs,
    });

    printReport(report, 'Cycle report (DRY RUN — no mutations)');

    if (wouldDispatch.length > 0) {
      console.log(`\n[dry-run] Would have dispatched: ${wouldDispatch.map((n) => `#${n}`).join(', ')}`);
    } else {
      console.log('\n[dry-run] No issues would be dispatched this cycle.');
    }

    return;
  }

  // Normal mode: run on an interval
  console.log(`[eng:loop] Starting dispatcher loop (interval=${INTERVAL_MS}ms, cap=${cfg.concurrencyCap}, backpressure=${cfg.openPrBackpressure})`);

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
              const child = spawn(cmd, args, opts);
              if (child.pid != null) {
                child.unref();
              }
              return { pid: child.pid };
            },
          }),
        countOpenReadyPrs,
      });
      printReport(report, 'Cycle report');
    } catch (err) {
      console.error('[eng:loop] Cycle error:', err);
    }
  };

  // Run immediately, then on interval
  await runOneCycle();
  setInterval(() => { void runOneCycle(); }, INTERVAL_MS);
}

main().catch((err) => {
  console.error('[eng:loop] Fatal error:', err);
  process.exit(1);
});
