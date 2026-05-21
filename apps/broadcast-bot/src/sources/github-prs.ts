import type { BroadcastEvent } from '../types.js';
import type { GithubClient } from './github.js';

interface PrApi {
  number: number;
  title: string;
  html_url: string;
  draft: boolean;
  user: { login: string } | null;
  merged_at: string | null;
  base: { ref: string };
}

export interface PrsOptions {
  repo: string;
  baseBranches: string[];
  excludeAuthors: string[];
  excludePrefixes: string[];
  watermark: string | null;
  postedIds: Set<string>;
}

export async function fetchMergedPrs(
  gh: GithubClient,
  opts: PrsOptions,
): Promise<BroadcastEvent[]> {
  // GitHub's REST sort=updated lets us page newest-first; we walk one page
  // (30 PRs) and stop. The 15-min cron + 30-PR window is comfortable headroom
  // even for the busiest day Jinn-Network/mono has seen.
  const prs = (await gh.rest(
    `/repos/${opts.repo}/pulls?state=closed&sort=updated&direction=desc&per_page=30`,
  )) as PrApi[];

  const events: BroadcastEvent[] = [];
  for (const pr of prs) {
    if (!pr.merged_at) continue;
    if (pr.draft) continue;
    if (!opts.baseBranches.includes(pr.base.ref)) continue;
    const author = pr.user?.login ?? 'unknown';
    if (opts.excludeAuthors.includes(author)) continue;
    if (opts.excludePrefixes.some((p) => pr.title.startsWith(p))) continue;
    if (opts.watermark && pr.merged_at <= opts.watermark) continue;
    const dedupeKey = `pr:${pr.number}`;
    if (opts.postedIds.has(dedupeKey)) continue;
    events.push({
      type: 'pr',
      dedupeKey,
      link: pr.html_url,
      timestamp: pr.merged_at,
      payload: {
        title: pr.title,
        number: pr.number,
        author,
        base: pr.base.ref,
        link: pr.html_url,
      },
    });
  }
  return events.sort((a, b) => a.timestamp.localeCompare(b.timestamp));
}
