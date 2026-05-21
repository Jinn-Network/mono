import { describe, it, expect } from 'vitest';
import { fetchReleases } from '../../src/sources/github-releases.js';
import type { GithubClient } from '../../src/sources/github.js';

function mockClient(releases: unknown[]): GithubClient {
  return {
    async rest() {
      return releases;
    },
    async graphql() {
      throw new Error('not used');
    },
  };
}

const fixture = [
  {
    id: 100,
    tag_name: 'v0.1.6',
    name: 'tokenomics fork prep',
    html_url: 'https://github.com/Jinn-Network/mono/releases/tag/v0.1.6',
    draft: false,
    prerelease: false,
    published_at: '2026-05-18T09:00:00Z',
  },
  {
    id: 99,
    tag_name: 'v0.1.5-draft',
    name: 'draft',
    html_url: 'https://...',
    draft: true,
    prerelease: false,
    published_at: '2026-05-17T09:00:00Z',
  },
  {
    id: 98,
    tag_name: 'v0.1.4',
    name: 'older',
    html_url: 'https://github.com/Jinn-Network/mono/releases/tag/v0.1.4',
    draft: false,
    prerelease: false,
    published_at: '2026-05-11T09:00:00Z',
  },
];

describe('fetchReleases', () => {
  it('emits only releases past the watermark', async () => {
    const gh = mockClient(fixture);
    const events = await fetchReleases(gh, {
      repo: 'Jinn-Network/mono',
      watermark: '2026-05-15T00:00:00Z',
      postedIds: new Set(),
    });
    expect(events).toHaveLength(1);
    expect(events[0].dedupeKey).toBe('release:100');
    expect(events[0].payload.tag).toBe('v0.1.6');
  });

  it('skips drafts and prereleases', async () => {
    const gh = mockClient(fixture);
    const events = await fetchReleases(gh, {
      repo: 'Jinn-Network/mono',
      watermark: null,
      postedIds: new Set(),
    });
    expect(events.map((e) => e.dedupeKey)).toEqual(['release:98', 'release:100']);
  });

  it('skips already-posted releases', async () => {
    const gh = mockClient(fixture);
    const events = await fetchReleases(gh, {
      repo: 'Jinn-Network/mono',
      watermark: null,
      postedIds: new Set(['release:100']),
    });
    expect(events.map((e) => e.dedupeKey)).toEqual(['release:98']);
  });
});
