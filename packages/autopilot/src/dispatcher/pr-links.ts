import { REPO } from './constants.js';
import type { CommandRunner } from './issue-source.js';

export type PrState = 'OPEN' | 'CLOSED' | 'MERGED';

/** A PR that closes an issue (via a `Closes #N` body keyword → GitHub's
 *  native `closingIssuesReferences` link). */
export interface PrLink {
  prNumber: number;
  /** Head branch — the ref a dependent issue stacks its worktree/PR onto. */
  headRefName: string;
  baseRefName: string;
  state: PrState;
  isDraft: boolean;
  /**
   * GitHub login of the PR author. The stack resolver gates on this: a
   * dependent may only stack on an *open* blocker PR whose author is on the
   * dispatch allowlist, since the blocker branch becomes the base a headless
   * session runs on (#497 trust boundary — the allowlist otherwise gates only
   * the dependent's author). Empty string when the payload omits it → never
   * matches the allowlist (fail-safe). (review 2026-07-13)
   */
  author: string;
  /**
   * Label names on the PR. Feeds the review-label enforcement sweep (#1733):
   * a session-opened PR missing `engine:review` is invisible to the review
   * loop (GhPrSource polls BY that label), so the dispatcher re-applies it
   * from here. Same single per-cycle `gh pr list` call — no extra API cost.
   */
  labels: string[];
}

interface GhPrListEntry {
  number: number;
  headRefName: string;
  baseRefName: string;
  state: string;
  isDraft: boolean;
  author?: { login?: string };
  labels?: Array<{ name?: string }>;
  closingIssuesReferences?: Array<{ number: number }>;
}

const PR_LIST_LIMIT = 300;

function normalizeState(s: string): PrState | null {
  const u = s.toUpperCase();
  return u === 'OPEN' || u === 'CLOSED' || u === 'MERGED' ? (u as PrState) : null;
}

/**
 * Build an issue → closing-PRs map in a single `gh pr list` call.
 *
 * Keyed on GitHub's native `closingIssuesReferences` (the "this PR closes
 * issue #N" link a `Closes/Fixes/Resolves #N` body keyword creates). `--state
 * all` is deliberate: the {@link resolveStackReady} resolver must distinguish a
 * blocker that **merged** (a dependent can build on `next`), one with an
 * **open** PR (stack the dependent on it), or one whose PR was **closed
 * without merging** (dependent stays blocked). One REST-backed query per cycle
 * — it does not touch the GraphQL budget the project snapshot guards (#585).
 *
 * An issue may map to more than one PR (e.g. a closed attempt plus an open
 * one); the resolver classifies across the whole list.
 */
export async function fetchIssuePrMap(
  runner: CommandRunner,
): Promise<Map<number, PrLink[]>> {
  const raw = await runner('gh', [
    'pr', 'list',
    '--repo', REPO,
    '--state', 'all',
    '--json', 'number,headRefName,baseRefName,state,isDraft,author,labels,closingIssuesReferences',
    '--limit', String(PR_LIST_LIMIT),
  ]);
  const entries = JSON.parse(raw) as GhPrListEntry[];
  const map = new Map<number, PrLink[]>();
  for (const e of entries) {
    const state = normalizeState(e.state);
    if (state === null) continue;
    const link: PrLink = {
      prNumber: e.number,
      headRefName: e.headRefName,
      baseRefName: e.baseRefName,
      state,
      isDraft: Boolean(e.isDraft),
      author: e.author?.login ?? '',
      labels: (e.labels ?? []).map((l) => l.name ?? '').filter((n) => n !== ''),
    };
    for (const ref of e.closingIssuesReferences ?? []) {
      const list = map.get(ref.number);
      if (list) list.push(link);
      else map.set(ref.number, [link]);
    }
  }
  return map;
}
