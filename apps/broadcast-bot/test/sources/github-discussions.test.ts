import { describe, it, expect } from 'vitest';
import { fetchDiscussions } from '../../src/sources/github-discussions.js';
import type { GithubClient } from '../../src/sources/github.js';

function client(nodes: unknown[]): GithubClient {
  return {
    async rest() {
      throw new Error('not used');
    },
    async graphql<T>() {
      return { repository: { discussions: { nodes } } } as T;
    },
  };
}

const nodes = [
  {
    id: 'D_kwDO_announce',
    number: 60,
    title: 'Monday release notes',
    url: 'https://github.com/Jinn-Network/mono/discussions/60',
    createdAt: '2026-05-18T09:30:00Z',
    category: { name: 'Announcements' },
    author: { login: 'oaksprout' },
  },
  {
    id: 'D_kwDO_qna',
    number: 58,
    title: 'How do I run a node',
    url: 'https://github.com/Jinn-Network/mono/discussions/58',
    createdAt: '2026-05-17T00:00:00Z',
    category: { name: 'Q&A' },
    author: { login: 'someone' },
  },
];

describe('fetchDiscussions', () => {
  it('keeps only categories on the allowlist', async () => {
    const events = await fetchDiscussions(client(nodes), {
      repo: 'Jinn-Network/mono',
      categories: ['Announcements', 'RFCs'],
      watermark: null,
      postedIds: new Set(),
    });
    expect(events).toHaveLength(1);
    expect(events[0].payload.category).toBe('Announcements');
  });

  it('respects watermark and posted set', async () => {
    const events = await fetchDiscussions(client(nodes), {
      repo: 'Jinn-Network/mono',
      categories: [],
      watermark: '2026-05-18T00:00:00Z',
      postedIds: new Set(),
    });
    expect(events.map((e) => e.payload.number)).toEqual([60]);

    const filtered = await fetchDiscussions(client(nodes), {
      repo: 'Jinn-Network/mono',
      categories: [],
      watermark: null,
      postedIds: new Set(['discussion:D_kwDO_announce']),
    });
    expect(filtered.map((e) => e.payload.number)).toEqual([58]);
  });
});
