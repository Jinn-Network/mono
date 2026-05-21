import { describe, it, expect } from 'vitest';
import { fetchMergedPrs } from '../../src/sources/github-prs.js';
import type { GithubClient } from '../../src/sources/github.js';

function client(prs: unknown[]): GithubClient {
  return {
    async rest() {
      return prs;
    },
    async graphql() {
      throw new Error('not used');
    },
  };
}

const baseOpts = {
  repo: 'Jinn-Network/mono',
  baseBranches: ['next', 'main'],
  excludeAuthors: ['dependabot[bot]'],
  excludePrefixes: ['chore(deps)'],
  watermark: null,
  postedIds: new Set<string>(),
};

const prs = [
  {
    number: 262,
    title: 'fix(u34i): bootstrap reliability',
    html_url: 'https://github.com/Jinn-Network/mono/pull/262',
    draft: false,
    user: { login: 'oaksprout' },
    merged_at: '2026-05-18T08:00:00Z',
    base: { ref: 'next' },
  },
  {
    number: 261,
    title: 'chore(deps): bump viem',
    html_url: 'https://github.com/Jinn-Network/mono/pull/261',
    draft: false,
    user: { login: 'oaksprout' },
    merged_at: '2026-05-17T08:00:00Z',
    base: { ref: 'next' },
  },
  {
    number: 260,
    title: 'feat: thing',
    html_url: 'https://github.com/Jinn-Network/mono/pull/260',
    draft: false,
    user: { login: 'dependabot[bot]' },
    merged_at: '2026-05-16T08:00:00Z',
    base: { ref: 'next' },
  },
  {
    number: 259,
    title: 'unmerged work',
    html_url: 'https://...',
    draft: false,
    user: { login: 'oaksprout' },
    merged_at: null,
    base: { ref: 'next' },
  },
  {
    number: 258,
    title: 'thing on a feature branch',
    html_url: 'https://...',
    draft: false,
    user: { login: 'oaksprout' },
    merged_at: '2026-05-15T08:00:00Z',
    base: { ref: 'feature-x' },
  },
];

describe('fetchMergedPrs', () => {
  it('keeps only merged PRs into watched base branches', async () => {
    const events = await fetchMergedPrs(client(prs), baseOpts);
    expect(events).toHaveLength(1);
    expect(events[0].dedupeKey).toBe('pr:262');
  });

  it('excludes prefix-matched titles and excluded authors', async () => {
    const events = await fetchMergedPrs(
      client(prs),
      { ...baseOpts, excludeAuthors: [], excludePrefixes: [] },
    );
    const numbers = events.map((e) => e.payload.number);
    expect(numbers).toContain(261);
    expect(numbers).toContain(260);
  });

  it('respects watermark', async () => {
    const events = await fetchMergedPrs(client(prs), {
      ...baseOpts,
      watermark: '2026-05-18T00:00:00Z',
    });
    expect(events.map((e) => e.payload.number)).toEqual([262]);
  });
});
