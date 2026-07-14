import type { SessionResult } from './types.js';
import { type CommandRunner, defaultRunner } from './issue-source.js';

// Pin the repo so `gh` never infers it from cwd (mirrors pr-source.ts).
const REPO = 'Jinn-Network/mono';

/**
 * SEAM: what happens to finished work.
 * Local implementation records the GitHub PR / escalation; the future
 * SolverNet implementation submits an on-chain delivery for evaluation.
 */
export interface DeliverySink {
  /** Record a finished session's outcome, verifying external state. */
  collect(result: SessionResult): Promise<void>;
}

/**
 * GitHub PR-based delivery sink.
 *
 * For `pr-opened` outcomes: verifies the PR exists via `gh pr view` and logs it.
 * For `escalated` outcomes: logs the escalation status.
 *
 * Minimal v1 — external verification + a log line.
 */
export class GhPrSink implements DeliverySink {
  private readonly run: CommandRunner;

  constructor(runner: CommandRunner = defaultRunner) {
    this.run = runner;
  }

  async collect(result: SessionResult): Promise<void> {
    if (result.outcome === 'pr-opened') {
      if (result.prNumber == null) {
        console.log(
          `[GhPrSink] issue #${result.issueNumber}: pr-opened but prNumber is missing — cannot verify`,
        );
        return;
      }
      try {
        const raw = await this.run('gh', [
          'pr', 'view', String(result.prNumber),
          '--repo', REPO,
          '--json', 'number,state,title',
        ]);
        const pr = JSON.parse(raw) as { number: number; state: string; title: string };
        console.log(
          `[GhPrSink] issue #${result.issueNumber}: PR #${pr.number} verified — state=${pr.state} title="${pr.title}"`,
        );
      } catch (err) {
        console.log(
          `[GhPrSink] issue #${result.issueNumber}: PR #${result.prNumber} could not be verified — ${String(err)}`,
        );
      }
    } else {
      // escalated
      const status = result.escalationStatus ?? 'unknown';
      console.log(
        `[GhPrSink] issue #${result.issueNumber}: escalated — status=${status}`,
      );
    }
  }
}
