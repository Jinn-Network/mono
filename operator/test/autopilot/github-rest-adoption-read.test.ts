import { describe, expect, it, vi } from 'vitest';

import {
  createJinnMonoGitHubAdoptionReadPort,
  validateReviewClaimTransition,
} from '../../src/autopilot/github-rest-adoption-read.js';

describe('Jinn mono GitHub adoption read adapter', () => {
  it('reads and caches the exact bounded review generation through Git data', async () => {
    const rootOid = '5'.repeat(40);
    const currentOid = '6'.repeat(40);
    const intentOid = '7'.repeat(40);
    const generation = '123e4567-e89b-42d3-a456-426614174010';
    const attempt = '123e4567-e89b-42d3-a456-426614174099';
    const marker = '123e4567-e89b-42d3-a456-426614174098';
    const common = {
      protocolVersion: 2,
      prNumber: 2101,
      generation,
      attempt,
      reviewer: 'jinn-autopilot',
      head: '4'.repeat(40),
      recordedAt: '2026-07-23T22:00:00.000Z',
    };
    const records = new Map([
      [currentOid, { ...common, state: 'terminal-approved', verdict: {
        state: 'APPROVE',
        marker,
      } }],
      [intentOid, { ...common, state: 'verdict-intent', verdict: {
        state: 'APPROVE',
        marker,
      } }],
      [rootOid, { ...common, state: 'active' }],
    ]);
    const treeByCommit = new Map([
      [currentOid, '8'.repeat(40)],
      [intentOid, '9'.repeat(40)],
      [rootOid, 'a'.repeat(40)],
    ]);
    const blobByTree = new Map([
      ['8'.repeat(40), 'b'.repeat(40)],
      ['9'.repeat(40), 'c'.repeat(40)],
      ['a'.repeat(40), 'd'.repeat(40)],
    ]);
    const parentByCommit = new Map([
      [currentOid, intentOid],
      [intentOid, rootOid],
    ]);
    const fetchImpl = vi.fn(async (url: string | URL | Request) => {
      const path = new URL(String(url)).pathname;
      if (path.includes('/git/ref/')) {
        return new Response(JSON.stringify({
          object: { sha: currentOid },
        }), { status: 200 });
      }
      const commitOid = [...records.keys()].find((oid) =>
        path.endsWith(`/git/commits/${oid}`));
      if (commitOid !== undefined) {
        const parent = parentByCommit.get(commitOid);
        return new Response(JSON.stringify({
          tree: { sha: treeByCommit.get(commitOid) },
          parents: parent === undefined ? [] : [{ sha: parent }],
        }), { status: 200 });
      }
      const treeOid = [...blobByTree.keys()].find((oid) =>
        path.endsWith(`/git/trees/${oid}`));
      if (treeOid !== undefined) {
        return new Response(JSON.stringify({
          tree: [{
            path: 'jinn-autopilot-review.json',
            type: 'blob',
            sha: blobByTree.get(treeOid),
          }],
        }), { status: 200 });
      }
      const entry = [...blobByTree.entries()].find(([, blobOid]) =>
        path.endsWith(`/git/blobs/${blobOid}`));
      if (entry !== undefined) {
        const commit = [...treeByCommit.entries()]
          .find(([, treeOid]) => treeOid === entry[0])?.[0];
        return new Response(JSON.stringify({
          encoding: 'base64',
          content: Buffer.from(
            JSON.stringify(records.get(commit!)),
          ).toString('base64'),
        }), { status: 200 });
      }
      return new Response('not found', { status: 404 });
    });
    const port = createJinnMonoGitHubAdoptionReadPort({ fetchImpl });

    const first = await port.readReviewAuthority(2101, rootOid);
    expect(first.history.map(({ oid }) => oid)).toEqual([
      currentOid,
      intentOid,
      rootOid,
    ]);
    const immutableCalls = fetchImpl.mock.calls.length;
    await expect(port.readReviewAuthority(2101, rootOid)).resolves.toEqual(first);
    expect(fetchImpl.mock.calls.length).toBe(immutableCalls + 1);
  });

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

  it('filters nullable unrelated comments without hiding valid receipts', async () => {
    const port = createJinnMonoGitHubAdoptionReadPort({
      fetchImpl: async () => new Response(JSON.stringify([
        {
          id: 16,
          user: null,
          body: null,
          created_at: '2026-07-23T21:00:00.000Z',
          updated_at: '2026-07-23T21:01:00.000Z',
        },
        {
          id: 17,
          user: { login: 'jinn-autopilot' },
          body: 'receipt',
          created_at: '2026-07-23T22:00:00.000Z',
          updated_at: '2026-07-23T22:01:00.000Z',
        },
      ]), { status: 200 }),
      maxPages: 2,
    });

    await expect(port.listPrIssueComments({
      prNumber: 2101,
      cursor: '3',
    })).rejects.toThrow(/page/i);
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
    });
  });

  it('filters unusable old reviews but preserves anonymous change requests as blockers', async () => {
    const port = createJinnMonoGitHubAdoptionReadPort({
      fetchImpl: async () => new Response(JSON.stringify([
        {
          id: 90,
          user: null,
          state: 'APPROVED',
          commit_id: null,
          body: null,
          submitted_at: null,
        },
        {
          id: 91,
          user: { login: 'jinn-autopilot' },
          state: 'CHANGES_REQUESTED',
          commit_id: null,
          body: null,
          submitted_at: null,
        },
        {
          id: 92,
          user: { login: 'jinn-autopilot' },
          state: 'APPROVED',
          commit_id: '4'.repeat(40),
          body: 'Approved.',
          submitted_at: '2026-07-23T22:09:00.000Z',
        },
      ]), { status: 200 }),
    });

    await expect(port.listPullRequestReviews({
      prNumber: 2101,
    })).resolves.toEqual({
      reviews: [
        {
          id: 91,
          authorLogin: '@unattributed-review:91',
          state: 'CHANGES_REQUESTED',
          commitId: '0'.repeat(40),
          body: '',
          submittedAt: '0001-01-01T00:00:00.000Z',
        },
        {
          id: 92,
          authorLogin: 'jinn-autopilot',
          state: 'APPROVED',
          commitId: '4'.repeat(40),
          body: 'Approved.',
          submittedAt: '2026-07-23T22:09:00.000Z',
        },
      ],
    });
  });

  it('rejects terminal approval marker substitution', () => {
    const common = {
      protocolVersion: 2 as const,
      prNumber: 2101,
      generation: '123e4567-e89b-42d3-a456-426614174010',
      attempt: '123e4567-e89b-42d3-a456-426614174099',
      reviewer: 'jinn-autopilot',
      head: '4'.repeat(40),
      recordedAt: '2026-07-23T22:00:00.000Z',
    };
    expect(() => validateReviewClaimTransition(
      {
        ...common,
        state: 'terminal-approved',
        verdict: {
          state: 'APPROVE',
          marker: '123e4567-e89b-42d3-a456-426614174098',
        },
      },
      {
        ...common,
        state: 'verdict-intent',
        verdict: {
          state: 'APPROVE',
          marker: '123e4567-e89b-42d3-a456-426614174097',
        },
      },
    )).toThrow(/changed verdict intent/);
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
