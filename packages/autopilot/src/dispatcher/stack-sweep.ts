import type { CommandRunner, ProjectSnapshot } from './project-snapshot.js';
import type { FieldCache } from './field-cache.js';
import type { PrLink } from './pr-links.js';
import { REPO } from './constants.js';

const BASE_BRANCH = 'next';

async function setBlockedHuman(
  itemId: string,
  fieldCache: FieldCache,
  runner: CommandRunner,
): Promise<void> {
  await runner('gh', [
    'project', 'item-edit',
    '--id', itemId,
    '--project-id', fieldCache.projectId,
    '--field-id', fieldCache.blockedOn.fieldId,
    '--single-select-option-id', fieldCache.blockedOn.options.Human,
  ]);
}

/**
 * Abandoned-base re-block sweep (spec 2026-07-13 §4).
 *
 * A dependent issue B dispatched *stacked* on its blocker A's open PR
 * (`ready-filter` stamped `stackBase`, `dispatch` branched B off A's head and
 * opened B's PR with `base = A-head`) is left building on a dead branch if A's
 * PR is closed **without merging**. GitHub only auto-retargets a stacked PR to
 * `next` on *merge*, not on close — so on close, B's PR base still points at
 * A's abandoned branch.
 *
 * Each cycle, for every open child PR whose base is not `next`, this looks up
 * the PR whose head *is* that base (the blocker A). If A's PR is `CLOSED`
 * (closed, not merged), the child is orphaned: it re-blocks the child issue by
 * setting its `Blocked on` field to `Human` (parking it out of the dispatch
 * loop — the existing `deriveInFlight` `blockedOn === 'Human'` carve-out frees
 * its concurrency slot and retains its worktree) and posts an explanatory
 * comment. A human decides whether to rebase onto `next`, re-scope, or discard.
 *
 * Detection uses PR data only (no marker file). It fires once the child has
 * opened its PR — the brief window before that (child dispatched, no PR yet,
 * blocker closes) is caught on the child's next cycle once its PR exists.
 *
 * Idempotent: a child already `Blocked on: Human`, or not in a live stacked
 * state (`In Progress` or `In Review`), is skipped. Best-effort per child (a
 * failure is logged, never fatal) — mirrors `syncHumanLane`.
 *
 * `prByIssue` is the per-cycle issue → closing-PRs map (`fetchIssuePrMap`); it
 * already contains both the child's PR (keyed by the child issue) and the
 * blocker's PR (keyed by the blocker issue), so no extra `gh` call is needed.
 */
export async function syncStackBases(
  snapshot: ProjectSnapshot,
  prByIssue: ReadonlyMap<number, PrLink[]>,
  fieldCache: FieldCache,
  runner: CommandRunner,
): Promise<{ reblocked: number[] }> {
  // Index every known PR by its head branch, so a child's base branch resolves
  // to the blocker PR that owns it.
  const byHead = new Map<string, PrLink>();
  for (const links of prByIssue.values()) {
    for (const l of links) byHead.set(l.headRefName, l);
  }

  const boardByIssue = new Map<
    number,
    { status: string | null; blockedOn: string | null; itemId: string }
  >();
  for (const item of snapshot.items) {
    if (item.contentType !== 'Issue') continue;
    boardByIssue.set(item.number, {
      status: item.status,
      blockedOn: item.blockedOn,
      itemId: item.id,
    });
  }

  const reblocked: number[] = [];
  for (const [childIssue, links] of prByIssue) {
    const board = boardByIssue.get(childIssue);
    if (board == null) continue;
    // Act on a live stacked child in EITHER `In Progress` (still working) or
    // `In Review` (its PR is open). The In-Review case is the common one: a
    // session flips its board status to In Review seconds after opening its PR
    // (implement-issue Stage 8), so by the time the child's PR is visible here
    // its status has almost always already left In Progress. Gating on In
    // Progress alone made this sweep miss its own mainline scenario. (review
    // 2026-07-13). Any other status (Todo/Done/Human) is not a live stacked run.
    if (board.status !== 'In Progress' && board.status !== 'In Review') continue;
    if (board.blockedOn === 'Human') continue; // already parked — idempotent

    for (const child of links) {
      if (child.state !== 'OPEN' || child.baseRefName === BASE_BRANCH) continue;
      const base = byHead.get(child.baseRefName);
      if (base == null || base.state !== 'CLOSED') continue; // base still open/merged → fine

      try {
        await setBlockedHuman(board.itemId, fieldCache, runner);
        await runner('gh', [
          'issue', 'comment', String(childIssue),
          '--repo', REPO,
          '--body',
          `Auto-parked by the dispatcher (stacked-base abandoned): this issue was ` +
            `dispatched stacked on \`${child.baseRefName}\` (PR #${base.prNumber}), but that ` +
            `PR was closed without merging, so the stacked base is dead. Set \`Blocked on\` ` +
            `back to \`Nothing\`/\`Another issue\` after deciding whether to rebase onto ` +
            `\`next\`, re-scope, or discard the worktree.`,
        ]);
        reblocked.push(childIssue);
      } catch (err) {
        console.error(`[stack-sweep] failed to re-block #${childIssue} (continuing):`, err);
      }
      break; // one dead base is enough to park the child
    }
  }

  return { reblocked };
}
