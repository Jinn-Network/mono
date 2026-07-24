import { describe, expect, it, vi } from 'vitest';

import {
  createJinnMonoGitHubAdoptionReadPort,
} from '../../src/autopilot/github-rest-adoption-read.js';

describe('Jinn mono GitHub adoption read adapter', () => {
  it('reads immutable comments with bounded REST pagination and optional authentication', async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify([{
      id: 17,
      user: { login: 'jinn-autopilot' },
      body: 'receipt',
      created_at: '2026-07-23T22:00:00.000Z',
      updated_at: '2026-07-23T22:01:00.000Z',
    }]), {
      status: 200,
      headers: {
        'content-type': 'application/json',
        link: '<https://github.test/repos/Jinn-Network/mono/issues/2101/comments?per_page=1&page=2>; rel="next"',
      },
    }));
    const port = createJinnMonoGitHubAdoptionReadPort({
      baseUrl: 'https://github.test',
      fetchImpl,
      token: 'github-token',
      pageSize: 1,
      maxPages: 2,
    });

    await expect(port.listPrIssueComments({
      prNumber: 2101,
    })).resolves.toEqual({
      comments: [{
        id: 17,
        authorLogin: 'jinn-autopilot',
        body: 'receipt',
        createdAt: '2026-07-23T22:00:00.000Z',
        updatedAt: '2026-07-23T22:01:00.000Z',
      }],
      nextCursor: '2',
    });
    expect(fetchImpl).toHaveBeenCalledWith(
      'https://github.test/repos/Jinn-Network/mono/issues/2101/comments?per_page=1&page=1',
      expect.objectContaining({
        method: 'GET',
        headers: expect.objectContaining({
          authorization: 'Bearer github-token',
        }),
        signal: expect.any(AbortSignal),
      }),
    );
  });

  it('reads exact PR head, labels, and native reviews without exposing writes', async () => {
    const fetchImpl = vi.fn(async (url: string | URL | Request) => {
      const text = String(url);
      if (text.endsWith('/pulls/2101')) {
        return new Response(JSON.stringify({
          head: { sha: '4'.repeat(40) },
          labels: [{ name: 'review:approved' }],
        }), { status: 200 });
      }
      return new Response(JSON.stringify([{
        id: 91,
        user: { login: 'jinn-autopilot' },
        state: 'APPROVED',
        commit_id: '4'.repeat(40),
        body: 'Approved.',
        submitted_at: '2026-07-23T22:09:00.000Z',
      }]), { status: 200 });
    });
    const port = createJinnMonoGitHubAdoptionReadPort({
      fetchImpl,
      pageSize: 100,
    });

    await expect(port.readPullRequest(2101)).resolves.toEqual({
      headSha: '4'.repeat(40),
      labels: ['review:approved'],
    });
    await expect(port.listPullRequestReviews({
      prNumber: 2101,
    })).resolves.toEqual({
      reviews: [{
        id: 91,
        authorLogin: 'jinn-autopilot',
        state: 'APPROVED',
        commitId: '4'.repeat(40),
        body: 'Approved.',
        submittedAt: '2026-07-23T22:09:00.000Z',
      }],
    });
    expect('createPrComment' in port).toBe(false);
  });

  it('rejects pages beyond the configured bound and malformed GitHub data', async () => {
    const port = createJinnMonoGitHubAdoptionReadPort({
      fetchImpl: async () => new Response(JSON.stringify([{
        id: 17,
        user: null,
        body: 'receipt',
        created_at: '2026-07-23T22:00:00.000Z',
        updated_at: '2026-07-23T22:01:00.000Z',
      }]), { status: 200 }),
      maxPages: 2,
    });

    await expect(port.listPrIssueComments({
      prNumber: 2101,
      cursor: '3',
    })).rejects.toThrow(/page/i);
    await expect(port.listPrIssueComments({
      prNumber: 2101,
    })).rejects.toThrow(/comment/i);
  });

  it('aborts a hung GitHub read at the configured timeout', async () => {
    const port = createJinnMonoGitHubAdoptionReadPort({
      timeoutMs: 5,
      fetchImpl: async (_url, init) => new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => {
          reject(new DOMException('Aborted', 'AbortError'));
        });
      }),
    });

    await expect(port.readPullRequest(2101)).rejects.toThrow(/timed out/i);
  });
});
