import type { CommandRunner } from './issue-source.js';
import { defaultRunner } from './issue-source.js';
import type { PolledPr } from './types.js';
import { REPO } from './constants.js';

/** SEAM: where reviewable PRs come from. Local impl polls `gh`. */
export interface PrSource {
  poll(): Promise<PolledPr[]>;
}

interface GhPrListEntry {
  number: number;
  title: string;
  headRefName: string;
  headRefOid: string;
  isDraft: boolean;
  author?: { login?: string };
}

interface GhPrView {
  reviews: Array<{ author?: { login?: string }; state: string; submittedAt: string }>;
  commits: Array<{ committedDate: string }>;
}

function currentBotReviews(
  view: GhPrView,
  botLogin: string,
): GhPrView['reviews'] {
  if (view.commits.length === 0) return [];
  const latestCommitMs = Math.max(...view.commits.map((c) => Date.parse(c.committedDate)));
  // Case-fold: GitHub logins are case-insensitive, and the dual-identity boot
  // check (identity.ts) also compares case-insensitively — keep them consistent
  // so a configured-login casing difference can't cause endless re-review.
  const bot = botLogin.toLowerCase();
  return view.reviews.filter(
    (r) => (r.author?.login ?? '').toLowerCase() === bot && Date.parse(r.submittedAt) >= latestCommitMs,
  );
}

/** True iff the bot posted any review at or after the latest commit. */
function hasCurrentReview(view: GhPrView, botLogin: string): boolean {
  return currentBotReviews(view, botLogin).length > 0;
}

/**
 * True iff the bot's latest current decisive verdict is APPROVED. COMMENTED
 * reviews do not supersede GitHub's approval/changes-requested decision.
 */
function hasCurrentApproval(view: GhPrView, botLogin: string): boolean {
  const decisive = currentBotReviews(view, botLogin)
    .filter((review) => (
      review.state === 'APPROVED' ||
      review.state === 'CHANGES_REQUESTED'
    ))
    .sort((a, b) => Date.parse(b.submittedAt) - Date.parse(a.submittedAt));
  return decisive[0]?.state === 'APPROVED';
}

export class GhPrSource implements PrSource {
  constructor(
    private readonly run: CommandRunner = defaultRunner,
    private readonly label: string = 'engine:review',
    private readonly botLogin: string = '',
  ) {}

  async poll(): Promise<PolledPr[]> {
    if (this.botLogin.length === 0) return [];

    const listRaw = await this.run('gh', [
      'pr', 'list',
      '--repo', REPO,
      '--state', 'open',
      '--label', this.label,
      '--json', 'number,title,headRefName,headRefOid,isDraft,author',
      '--limit', '200',
    ]);
    const list: GhPrListEntry[] = JSON.parse(listRaw) as GhPrListEntry[];

    const out: PolledPr[] = [];
    for (const pr of list) {
      const viewRaw = await this.run('gh', [
        'pr', 'view', String(pr.number),
        '--repo', REPO,
        '--json', 'reviews,commits',
      ]);
      const view: GhPrView = JSON.parse(viewRaw) as GhPrView;
      const currentReviewExists = hasCurrentReview(view, this.botLogin);
      out.push({
        number: pr.number,
        title: pr.title,
        headRefName: pr.headRefName,
        headRefOid: pr.headRefOid,
        isDraft: pr.isDraft,
        author: pr.author?.login ?? '',
        hasReviewLabel: true,
        // A current approval on a draft is an incomplete clean-flow
        // transaction: the final `gh pr ready` never happened. Redispatch it
        // for reconciliation instead of letting the approval suppress review
        // forever. Once non-draft, that same current approval is complete.
        needsReview:
          !currentReviewExists ||
          (pr.isDraft && hasCurrentApproval(view, this.botLogin)),
      });
    }
    return out;
  }
}
