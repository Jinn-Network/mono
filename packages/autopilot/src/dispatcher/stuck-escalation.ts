/**
 * Deterministic stuck-PR escalation (Stage A of the merge-prep design).
 *
 * The auto-merge sweep (`merge-sweep.ts`) surfaces PRs it cannot merge and
 * cannot self-heal — a real conflict against `next`, or still-behind after its
 * one `update-branch` — as structured `StuckPr` entries. Before Stage A these
 * were log-only: an engine-approved, un-drafted, green PR could sit unmergeable
 * indefinitely with nothing on the board to draw a human's eye.
 *
 * This module makes a stuck PR *visible*, with no AI in the loop:
 *   1. label the PR `review:needs-human` (also the idempotency marker — the
 *      sweep reports `escalated:true` next cycle so we never double-escalate),
 *   2. set the linked issue's `Blocked on` field to `Human` (so `syncHumanLane`
 *      promotes it into the Human status lane on the next cycle), and
 *   3. leave one explanatory PR comment.
 *
 * Best-effort per PR; a per-item failure is recorded and never aborts the rest
 * (sweep convention). The `review:needs-human` label makes the merge-prep
 * session (Stage B) skip the PR too — a human owns it once escalated.
 */

import { REPO } from './constants.js';
import type { CommandRunner } from './issue-source.js';
import type { ProjectSnapshot } from './project-snapshot.js';
import type { FieldCache } from './field-cache.js';
import type { PrLink } from './pr-links.js';
import { NEEDS_HUMAN_LABEL, type StuckPr } from './merge-sweep.js';

export interface StuckEscalationReport {
  /** PR numbers freshly escalated this cycle. */
  escalated: number[];
  /** Operator-visible skip/failure lines (already-escalated PRs are silent). */
  skipped: string[];
}

/** Human-readable cause line for the PR comment, per stuck reason. */
function reasonPhrase(s: StuckPr): string {
  switch (s.reason) {
    case 'conflicting':
      return 'it has a merge conflict against `next`';
    case 'still-behind':
      return 'it is still behind `next` after an automatic update-branch attempt';
    case 'update-branch-failed':
      return 'the automatic update-branch attempt failed (typically a conflict)';
  }
}

/**
 * Resolve the linked issue number for a PR by inverting the per-cycle
 * issue→closing-PRs map (`fetchIssuePrMap`). Returns the first issue the PR
 * closes, or null if the PR has no `Closes #N` link.
 */
function linkedIssueFor(prNumber: number, prByIssue: Map<number, PrLink[]>): number | null {
  for (const [issueNumber, links] of prByIssue) {
    if (links.some((l) => l.prNumber === prNumber)) return issueNumber;
  }
  return null;
}

/**
 * Escalate a single fresh stuck PR: label + Blocked-on:Human (best-effort if a
 * linked issue exists on the board) + one comment. Throws only if the label add
 * fails (the caller records it as skipped); the board edit is isolated so a PR
 * with no linked issue still gets labeled and commented.
 */
export async function escalateStuckPr(
  s: StuckPr,
  snapshot: ProjectSnapshot,
  prByIssue: Map<number, PrLink[]>,
  fieldCache: FieldCache,
  runner: CommandRunner,
): Promise<void> {
  // 1. Label — the idempotency marker. Do this first: if it fails, we abort
  //    (thrown to caller) rather than comment/blocked-on without the marker,
  //    which would re-escalate every cycle.
  await runner('gh', ['pr', 'edit', String(s.number), '--repo', REPO, '--add-label', NEEDS_HUMAN_LABEL]);

  // 2. Blocked on: Human on the linked issue (so it enters the Human lane).
  //    Isolated — a PR with no linked issue, or one not on the board, still
  //    gets labeled + commented above/below.
  const issueNumber = linkedIssueFor(s.number, prByIssue);
  if (issueNumber != null) {
    const item = snapshot.items.find((i) => i.contentType === 'Issue' && i.number === issueNumber);
    if (item != null) {
      try {
        await runner('gh', [
          'project', 'item-edit',
          '--id', item.id,
          '--project-id', fieldCache.projectId,
          '--field-id', fieldCache.blockedOn.fieldId,
          '--single-select-option-id', fieldCache.blockedOn.options.Human,
        ]);
      } catch (err) {
        console.error(
          `[stuck-escalation] PR #${s.number}: could not set issue #${issueNumber} Blocked on: Human (continuing):`,
          err,
        );
      }
    }
  }

  // 3. One explanatory comment.
  const headShort = s.headRefOid.slice(0, 9) || '(unknown)';
  const body =
    `The autopilot merge sweep cannot merge this PR: ${reasonPhrase(s)} ` +
    `(head \`${headShort}\`). The engine review passed, but the merge is blocked and cannot ` +
    `self-heal, so it needs a human — rebase onto \`next\` and resolve the conflict, then let the ` +
    `review loop re-approve. The linked issue (if any) is set to \`Blocked on: Human\`.`;
  await runner('gh', ['pr', 'comment', String(s.number), '--repo', REPO, '--body', body]);
}

/**
 * Escalate every FRESH stuck PR (`escalated === false`). Already-escalated PRs
 * are silently skipped (a human owns them). Per-PR failures are isolated.
 */
export async function escalateStuckPrs(
  stuck: StuckPr[],
  snapshot: ProjectSnapshot,
  prByIssue: Map<number, PrLink[]>,
  fieldCache: FieldCache,
  runner: CommandRunner,
): Promise<StuckEscalationReport> {
  const report: StuckEscalationReport = { escalated: [], skipped: [] };
  for (const s of stuck) {
    if (s.escalated) continue; // already labeled needs-human — a human owns it
    try {
      await escalateStuckPr(s, snapshot, prByIssue, fieldCache, runner);
      report.escalated.push(s.number);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      report.skipped.push(`PR #${s.number}: escalation failed — ${msg}`);
    }
  }
  return report;
}
