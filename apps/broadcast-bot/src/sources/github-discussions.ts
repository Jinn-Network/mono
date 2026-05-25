import type { BroadcastEvent } from '../types.js';
import type { GithubClient } from './github.js';

const DISCUSSIONS_QUERY = `
  query Discussions($owner: String!, $name: String!) {
    repository(owner: $owner, name: $name) {
      discussions(first: 30, orderBy: { field: CREATED_AT, direction: DESC }) {
        nodes {
          id
          number
          title
          url
          createdAt
          category { name }
          author { login }
        }
      }
    }
  }
`;

interface DiscussionsResponse {
  repository: {
    discussions: {
      nodes: Array<{
        id: string;
        number: number;
        title: string;
        url: string;
        createdAt: string;
        category: { name: string } | null;
        author: { login: string } | null;
      }>;
    };
  };
}

export interface DiscussionsOptions {
  repo: string;
  categories: string[];
  watermark: string | null;
  postedIds: Set<string>;
}

export async function fetchDiscussions(
  gh: GithubClient,
  opts: DiscussionsOptions,
): Promise<BroadcastEvent[]> {
  const [owner, name] = opts.repo.split('/');
  const data = await gh.graphql<DiscussionsResponse>(DISCUSSIONS_QUERY, { owner, name });
  const events: BroadcastEvent[] = [];
  for (const d of data.repository.discussions.nodes) {
    const category = d.category?.name ?? '';
    if (opts.categories.length > 0 && !opts.categories.includes(category)) continue;
    if (opts.watermark && d.createdAt <= opts.watermark) continue;
    const dedupeKey = `discussion:${d.id}`;
    if (opts.postedIds.has(dedupeKey)) continue;
    events.push({
      type: 'discussion',
      dedupeKey,
      link: d.url,
      timestamp: d.createdAt,
      payload: {
        title: d.title,
        category,
        author: d.author?.login ?? 'unknown',
        number: d.number,
        link: d.url,
      },
    });
  }
  return events.sort((a, b) => a.timestamp.localeCompare(b.timestamp));
}
