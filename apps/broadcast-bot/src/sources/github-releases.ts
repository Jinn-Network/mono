import type { BroadcastEvent } from '../types.js';
import type { GithubClient } from './github.js';

interface ReleaseApi {
  id: number;
  tag_name: string;
  name: string | null;
  html_url: string;
  draft: boolean;
  prerelease: boolean;
  published_at: string | null;
}

export interface ReleasesOptions {
  repo: string;
  /** ISO timestamp; only releases with `published_at > watermark` are emitted. */
  watermark: string | null;
  postedIds: Set<string>;
}

export async function fetchReleases(
  gh: GithubClient,
  opts: ReleasesOptions,
): Promise<BroadcastEvent[]> {
  const releases = (await gh.rest(`/repos/${opts.repo}/releases?per_page=30`)) as ReleaseApi[];
  const events: BroadcastEvent[] = [];
  for (const r of releases) {
    if (r.draft || r.prerelease) continue;
    if (!r.published_at) continue;
    if (opts.watermark && r.published_at <= opts.watermark) continue;
    const dedupeKey = `release:${r.id}`;
    if (opts.postedIds.has(dedupeKey)) continue;
    events.push({
      type: 'release',
      dedupeKey,
      link: r.html_url,
      timestamp: r.published_at,
      payload: {
        tag: r.tag_name,
        name: r.name ?? r.tag_name,
        repo: opts.repo,
        link: r.html_url,
      },
    });
  }
  return events.sort((a, b) => a.timestamp.localeCompare(b.timestamp));
}
