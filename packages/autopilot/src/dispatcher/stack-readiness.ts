import type { PolledIssue } from './types.js';
import type { PrLink } from './pr-links.js';

/** An issue admitted despite `Blocked on: Another issue` because its blockers
 *  are satisfied. `baseBranch` is the bare ref the dependent should stack on. */
export interface StackReady {
  /**
   * Bare git branch name to branch the worktree off and target the PR at.
   * Either the single unmerged blocker's PR head branch (a real stack), or
   * `'next'` when every blocker has already merged (build on `next` normally).
   */
  baseBranch: string;
}

const DEFAULT_BASE = 'next';

/**
 * Decide, per issue with `blocked_by` edges, whether it can be auto-unblocked
 * and what branch to stack on.
 *
 * **Rule (single-blocker MVP, spec 2026-07-13):** admit iff every blocker is
 * either MERGED, or exactly one blocker is unmerged-with-an-open-PR while all
 * others are MERGED.
 *  - all blockers merged            → admit, `baseBranch: 'next'`
 *  - exactly one open-PR blocker    → admit, `baseBranch: <that PR's head>`
 *  - a blocker with no PR            → not admitted (stays blocked)
 *  - a blocker only closed-unmerged  → not admitted (abandoned base)
 *  - >1 unmerged-with-PR blocker     → not admitted (multi-parent out of scope)
 *
 * Issues with no `blocked_by` edges are ignored (they are handled by the normal
 * `Blocked on: Nothing` path in `selectReady`). Pure — all state is in the
 * arguments; unit-testable without `gh`/`git`.
 */
export function resolveStackReady(
  polled: PolledIssue[],
  prByIssue: ReadonlyMap<number, PrLink[]>,
  authorAllowlist: ReadonlySet<string>,
): Map<number, StackReady> {
  const out = new Map<number, StackReady>();

  for (const issue of polled) {
    if (issue.blockedByIssues.length === 0) continue;

    const openBlockerHeads: string[] = [];
    let allBlockersSatisfied = true;

    for (const blocker of issue.blockedByIssues) {
      const links = prByIssue.get(blocker) ?? [];
      // A merged PR means the blocker's work is already in `next` — reviewed and
      // merged by a human, so trusted regardless of its author.
      if (links.some((l) => l.state === 'MERGED')) continue;
      // An open PR means the blocker is in-flight — the dependent can stack on
      // it, BUT only if that PR's author is on the dispatch allowlist. The
      // blocker branch becomes the base a headless session runs on, so it must
      // clear the same #497 trust boundary as the dependent's own author (which
      // `selectReady` gates separately). `authorAllowlist` is pre-lowercased by
      // the caller. (review 2026-07-13)
      const open = links.find(
        (l) => l.state === 'OPEN' && authorAllowlist.has(l.author.toLowerCase()),
      );
      if (open) {
        openBlockerHeads.push(open.headRefName);
        continue;
      }
      // No merged/open PR (no PR, or only a closed-unmerged one) → still blocked.
      allBlockersSatisfied = false;
      break;
    }

    if (!allBlockersSatisfied) continue;

    if (openBlockerHeads.length === 0) {
      // Every blocker merged: build on `next`, no real stack.
      out.set(issue.number, { baseBranch: DEFAULT_BASE });
    } else if (openBlockerHeads.length === 1) {
      // Exactly one unmerged blocker with an open PR: stack on its head branch.
      out.set(issue.number, { baseBranch: openBlockerHeads[0] });
    }
    // openBlockerHeads.length > 1 → multi-parent stacking is out of scope; not admitted.
  }

  return out;
}
