import type { CommandRunner } from './issue-source.js';
import type { PrLink } from './pr-links.js';
import { REPO } from './constants.js';

/**
 * A session PR that should carry the review label but doesn't.
 * `issueNumber` is the issue the PR closes (the dispatch linkage).
 */
export interface UnlabeledSessionPr {
  issueNumber: number;
  prNumber: number;
}

/**
 * Dispatch branch fingerprint: `<shape>/<N>-<slug>` where `<N>` is the issue
 * the PR closes. This is exactly the branch shape `dispatch.ts` sessions
 * create (`feat/1664-stage-1-…`, `fix/814-fix-…`), so it identifies a
 * session-opened PR without relying on author identity (the allowlist logins
 * are also used by humans, whose manual PRs must NOT be force-enrolled).
 */
function isSessionBranch(headRefName: string, issueNumber: number): boolean {
  return new RegExp(`^[a-z]+/${issueNumber}-`).test(headRefName);
}

/**
 * Pure selector for the review-label enforcement sweep (#1733).
 *
 * The review loop is label-driven: `GhPrSource.poll()` lists PRs BY the
 * `engine:review` label, so a session PR opened without it (skill drift,
 * transient `gh` failure) is invisible to review — observed live 2026-07-15
 * when #1730/#1731 opened unlabeled and unreviewed wrong-model code nearly
 * merged. The label is applied by prose (implement-issue Stage 8); this sweep
 * is the belt to that suspender.
 *
 * A PR qualifies iff:
 *  - it is OPEN,
 *  - its author is on the dispatch allowlist (trust boundary — a review
 *    session checks out and RUNS the branch, mirroring `selectReviewable`),
 *  - its head branch carries the dispatch fingerprint for the issue it
 *    closes (`<shape>/<N>-…`), and
 *  - it does not already carry the review label.
 */
export function selectUnlabeled(
  prByIssue: ReadonlyMap<number, PrLink[]>,
  authorAllowlist: ReadonlySet<string>,
  reviewLabel: string,
): UnlabeledSessionPr[] {
  const out: UnlabeledSessionPr[] = [];
  const seen = new Set<number>();
  for (const [issueNumber, links] of prByIssue) {
    for (const link of links) {
      if (link.state !== 'OPEN') continue;
      if (seen.has(link.prNumber)) continue;
      if (!authorAllowlist.has(link.author.toLowerCase())) continue;
      if (!isSessionBranch(link.headRefName, issueNumber)) continue;
      if (link.labels.includes(reviewLabel)) continue;
      seen.add(link.prNumber);
      out.push({ issueNumber, prNumber: link.prNumber });
    }
  }
  return out.sort((a, b) => a.prNumber - b.prNumber);
}

/**
 * Apply the review label to every qualifying unlabeled session PR.
 * Idempotent (`--add-label` on an already-labeled PR is a no-op) and
 * best-effort per PR — a failure is logged, never fatal (mirrors
 * `syncStackBases`).
 */
export async function syncReviewLabels(
  prByIssue: ReadonlyMap<number, PrLink[]>,
  authorAllowlist: ReadonlySet<string>,
  runner: CommandRunner,
  reviewLabel = 'engine:review',
): Promise<{ labeled: number[] }> {
  const labeled: number[] = [];
  for (const pr of selectUnlabeled(prByIssue, authorAllowlist, reviewLabel)) {
    try {
      await runner('gh', [
        'pr', 'edit', String(pr.prNumber),
        '--repo', REPO,
        '--add-label', reviewLabel,
      ]);
      labeled.push(pr.prNumber);
    } catch (err) {
      console.error(`[label-sweep] failed to label PR #${pr.prNumber} (continuing):`, err);
    }
  }
  return { labeled };
}
