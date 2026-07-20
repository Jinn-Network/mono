import { describe, expect, it } from 'vitest';
import type { CommandRunner } from '../../src/dispatcher/issue-source.js';
import { GhLifecycleReader } from '../../src/lifecycle/github-reader.js';

const OPEN_HEAD = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const MERGED_HEAD = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';

function graphQlPr(input: {
  readonly number: number;
  readonly state: 'OPEN' | 'MERGED';
  readonly head: string;
  readonly comments?: readonly string[];
  readonly headRefName?: string;
  readonly historyTruncated?: boolean;
  readonly labels?: readonly string[];
  readonly message?: string;
}) {
  return {
    number: input.number,
    title: `PR ${input.number}`,
    body: 'Lifecycle PR',
    author: { login: 'trusted' },
    baseRefName: 'next',
    headRefName: input.headRefName ?? `autopilot/${input.number === 101 ? 42 : 41}`,
    headRefOid: input.head,
    isDraft: input.state === 'OPEN',
    state: input.state,
    labels: {
      pageInfo: { hasNextPage: false },
      nodes: (input.labels ?? ['engine:review']).map((name) => ({ name })),
    },
    closingIssuesReferences: {
      pageInfo: { hasNextPage: false },
      nodes: [{ number: input.number === 101 ? 42 : 41 }],
    },
    mergeable: 'MERGEABLE',
    mergeStateStatus: 'BLOCKED',
    mergedAt: input.state === 'MERGED' ? '2026-07-20T10:00:00.000Z' : null,
    mergeCommit: input.state === 'MERGED' ? { oid: input.head } : null,
    commits: {
      pageInfo: { hasPreviousPage: input.historyTruncated ?? false },
      nodes: [{
        commit: {
          oid: input.head,
          committedDate: '2026-07-20T09:00:00.000Z',
          message: input.message ?? 'work',
        },
      }],
    },
    reviews: {
      pageInfo: { hasNextPage: false },
      nodes: [],
    },
    comments: {
      pageInfo: { hasPreviousPage: false },
      nodes: (input.comments ?? []).map((body, index) => ({
        body,
        createdAt: `2026-07-20T09:0${index}:00.000Z`,
      })),
    },
    statusCheckRollup: null,
  };
}

describe('GhLifecycleReader', () => {
  it('scopes open reads, batches merged outcomes, reads refs only for open PRs, and parses Human evidence', async () => {
    const calls: string[][] = [];
    const humanComment = '<!-- jinn-autopilot-human:v2 issue=42 pr=101 '
      + 'phase=implementing code=implementation-escalation -->\n\n'
      + 'Autopilot parked this item for Human review.\n\nNeeds product judgment';
    const run: CommandRunner = async (_command, args) => {
      calls.push(args);
      const query = args.find((arg) => arg.startsWith('query=')) ?? '';
      if (query.includes('closedByPullRequestsReferences')) {
        return JSON.stringify({
          data: {
            repository: {
              issue42: {
                closedByPullRequestsReferences: {
                  pageInfo: { hasNextPage: false },
                  nodes: [graphQlPr({
                    number: 99,
                    state: 'MERGED',
                    head: MERGED_HEAD,
                  })],
                },
              },
            },
          },
        });
      }
      if (query.includes('ref(qualifiedName')) {
        return JSON.stringify({ data: { repository: { ref: null } } });
      }
      return JSON.stringify({
        data: {
          repository: {
            pullRequests: {
              pageInfo: { hasNextPage: false, endCursor: null },
              nodes: [graphQlPr({
                number: 101,
                state: 'OPEN',
                head: OPEN_HEAD,
                comments: [humanComment],
              })],
            },
          },
        },
      });
    };
    const reader = new GhLifecycleReader(run);

    const page = await reader.readPullRequests(null, [42]);

    expect(page.nodes.map((pr) => pr.number)).toEqual([101, 99]);
    expect(page.nodes[0]?.humanReason).toEqual({
      phase: 'implementing',
      code: 'implementation-escalation',
      detail: 'Needs product judgment',
    });
    const queries = calls.map((args) => args.find((arg) => arg.startsWith('query=')) ?? '');
    expect(queries[0]).toContain('states: [OPEN]');
    expect(queries[0]).toContain('labels: ["engine:review"]');
    const mergedQuery = queries.find((query) => query.includes('closedByPullRequestsReferences'));
    expect(mergedQuery).toContain('issue42: issue(number: 42)');
    expect(mergedQuery).not.toContain('reviews(');
    expect(mergedQuery).not.toContain('comments(');
    expect(mergedQuery).not.toContain('statusCheckRollup');
    expect(queries.filter((query) => query.includes('ref(qualifiedName'))).toHaveLength(1);
  });

  it('paginates adopted-branch ancestry until it finds the latest v2 marker', async () => {
    const calls: string[][] = [];
    const claimMessage = [
      'claim',
      '',
      'Jinn-Autopilot-Protocol: 2',
      'Jinn-Autopilot-Phase: implement',
      'Jinn-Autopilot-Issue: 42',
      'Jinn-Autopilot-Attempt: 11111111-1111-4111-8111-111111111111',
      'Jinn-Autopilot-Runner: runner-a',
      'Jinn-Autopilot-Login: trusted',
      `Jinn-Autopilot-Expected-Head: ${MERGED_HEAD}`,
      'Jinn-Autopilot-Target-Base: next',
      'Jinn-Autopilot-Claimed-At: 2026-07-20T08:00:00.000Z',
    ].join('\n');
    const historyPage = (page: number) => Array.from({ length: page === 1 ? 100 : 1 }, (_, index) => ({
      sha: page === 1 && index === 0 ? OPEN_HEAD : `${page}${String(index).padStart(39, '0')}`,
      commit: {
        message: page === 2 ? claimMessage : `checkpoint ${index}`,
        committer: { date: '2026-07-20T09:00:00.000Z' },
      },
    }));
    const run: CommandRunner = async (_command, args) => {
      calls.push(args);
      const query = args.find((arg) => arg.startsWith('query=')) ?? '';
      if (query.includes('ref(qualifiedName')) {
        return JSON.stringify({ data: { repository: { ref: null } } });
      }
      if (args[1]?.includes('/commits?')) {
        const page = args[1].includes('page=2') ? 2 : 1;
        return JSON.stringify(historyPage(page));
      }
      return JSON.stringify({
        data: {
          repository: {
            pullRequests: {
              pageInfo: { hasNextPage: false, endCursor: null },
              nodes: [graphQlPr({
                number: 101,
                state: 'OPEN',
                head: OPEN_HEAD,
                headRefName: 'feature/adopted-42',
                historyTruncated: true,
              })],
            },
          },
        },
      });
    };

    const page = await new GhLifecycleReader(run).readPullRequests(null);

    expect(page.nodes[0]?.branchClaimTrailers).toContain('Jinn-Autopilot-Protocol: 2');
    expect(calls.some((args) => args[1]?.includes('page=2'))).toBe(true);
  });

  it('paginates stable-branch ancestry after checkpoint commits', async () => {
    const calls: string[][] = [];
    const claimMessage = [
      'claim',
      '',
      'Jinn-Autopilot-Protocol: 2',
      'Jinn-Autopilot-Phase: implement',
      'Jinn-Autopilot-Issue: 42',
      'Jinn-Autopilot-Attempt: 11111111-1111-4111-8111-111111111111',
      'Jinn-Autopilot-Runner: runner-a',
      'Jinn-Autopilot-Login: trusted',
      `Jinn-Autopilot-Expected-Head: ${MERGED_HEAD}`,
      'Jinn-Autopilot-Target-Base: next',
      'Jinn-Autopilot-Claimed-At: 2026-07-20T08:00:00.000Z',
    ].join('\n');
    const run: CommandRunner = async (_command, args) => {
      calls.push(args);
      if (args[1]?.includes('matching-refs')) {
        return JSON.stringify([[{
          ref: 'refs/heads/autopilot/42',
          object: { sha: OPEN_HEAD },
        }]]);
      }
      if (args[1]?.includes('/commits?')) {
        const second = args[1].includes('page=2');
        return JSON.stringify(Array.from({ length: second ? 1 : 100 }, (_, index) => ({
          sha: !second && index === 0 ? OPEN_HEAD : `${second ? 2 : 1}${String(index).padStart(39, '0')}`,
          commit: {
            message: second ? claimMessage : `checkpoint ${index}`,
            committer: { date: '2026-07-20T09:00:00.000Z' },
          },
        })));
      }
      throw new Error(`Unexpected call: ${args.join(' ')}`);
    };

    const claims = await new GhLifecycleReader(run).readBranchClaims();

    expect(claims).toHaveLength(1);
    expect(claims[0]?.claimTrailers).toContain('Jinn-Autopilot-Protocol: 2');
    expect(calls.some((args) => args[1]?.includes('page=2'))).toBe(true);
  });

  it('retries a transient ancestry read failure on the next cycle', async () => {
    let ancestryAttempts = 0;
    const claimMessage = [
      'claim',
      '',
      'Jinn-Autopilot-Protocol: 2',
      'Jinn-Autopilot-Phase: implement',
      'Jinn-Autopilot-Issue: 42',
      'Jinn-Autopilot-Attempt: 11111111-1111-4111-8111-111111111111',
      'Jinn-Autopilot-Runner: runner-a',
      'Jinn-Autopilot-Login: trusted',
      `Jinn-Autopilot-Expected-Head: ${MERGED_HEAD}`,
      'Jinn-Autopilot-Target-Base: next',
      'Jinn-Autopilot-Claimed-At: 2026-07-20T08:00:00.000Z',
    ].join('\n');
    const run: CommandRunner = async (_command, args) => {
      if (args[1]?.includes('matching-refs')) {
        return JSON.stringify([[{
          ref: 'refs/heads/autopilot/42',
          object: { sha: OPEN_HEAD },
        }]]);
      }
      if (args[1]?.includes('/commits?')) {
        ancestryAttempts += 1;
        if (ancestryAttempts === 1) throw new Error('transient GitHub read failure');
        return JSON.stringify([{
          sha: OPEN_HEAD,
          commit: {
            message: claimMessage,
            committer: { date: '2026-07-20T09:00:00.000Z' },
          },
        }]);
      }
      throw new Error(`Unexpected call: ${args.join(' ')}`);
    };
    const reader = new GhLifecycleReader(run);

    await expect(reader.readBranchClaims()).rejects.toThrow(/transient/);
    await expect(reader.readBranchClaims()).resolves.toHaveLength(1);
  });

  it('rediscovers an adopted v2 PR whose engine:review projection is missing', async () => {
    const claimMessage = [
      'claim',
      '',
      'Jinn-Autopilot-Protocol: 2',
      'Jinn-Autopilot-Phase: implement',
      'Jinn-Autopilot-Issue: 42',
      'Jinn-Autopilot-PR: 101',
      'Jinn-Autopilot-Attempt: 11111111-1111-4111-8111-111111111111',
      'Jinn-Autopilot-Runner: runner-a',
      'Jinn-Autopilot-Login: trusted',
      `Jinn-Autopilot-Expected-Head: ${MERGED_HEAD}`,
      'Jinn-Autopilot-Target-Base: next',
      'Jinn-Autopilot-Claimed-At: 2026-07-20T08:00:00.000Z',
    ].join('\n');
    const adopted = graphQlPr({
      number: 101,
      state: 'OPEN',
      head: OPEN_HEAD,
      headRefName: 'feature/adopted-42',
      labels: [],
      message: claimMessage,
    });
    const run: CommandRunner = async (_command, args) => {
      const query = args.find((arg) => arg.startsWith('query=')) ?? '';
      if (query.includes('closedByPullRequestsReferences')) {
        return JSON.stringify({
          data: {
            repository: {
              issue42: {
                closedByPullRequestsReferences: {
                  pageInfo: { hasNextPage: false },
                  nodes: [adopted],
                },
              },
            },
          },
        });
      }
      if (query.includes('pullRequest(number:')) {
        return JSON.stringify({ data: { repository: { pullRequest: adopted } } });
      }
      if (query.includes('ref(qualifiedName')) {
        return JSON.stringify({ data: { repository: { ref: null } } });
      }
      return JSON.stringify({
        data: {
          repository: {
            pullRequests: {
              pageInfo: { hasNextPage: false, endCursor: null },
              nodes: [],
            },
          },
        },
      });
    };

    const page = await new GhLifecycleReader(run).readPullRequests(null, [42]);

    expect(page.nodes).toEqual([
      expect.objectContaining({
        number: 101,
        headRefName: 'feature/adopted-42',
        labels: [],
        branchClaimTrailers: expect.stringContaining('Jinn-Autopilot-Issue: 42'),
      }),
    ]);
  });

  it('ignores a foreign protocol marker before the candidate branch claim', async () => {
    const messageForIssue = (issueNumber: number) => [
      'claim',
      '',
      'Jinn-Autopilot-Protocol: 2',
      'Jinn-Autopilot-Phase: implement',
      `Jinn-Autopilot-Issue: ${issueNumber}`,
      'Jinn-Autopilot-Attempt: 11111111-1111-4111-8111-111111111111',
      'Jinn-Autopilot-Runner: runner-a',
      'Jinn-Autopilot-Login: trusted',
      `Jinn-Autopilot-Expected-Head: ${MERGED_HEAD}`,
      'Jinn-Autopilot-Target-Base: next',
      'Jinn-Autopilot-Claimed-At: 2026-07-20T08:00:00.000Z',
    ].join('\n');
    const run: CommandRunner = async (_command, args) => {
      if (args[1]?.includes('matching-refs')) {
        return JSON.stringify([[{
          ref: 'refs/heads/autopilot/42',
          object: { sha: OPEN_HEAD },
        }]]);
      }
      if (args[1]?.includes('/commits?')) {
        return JSON.stringify([
          {
            sha: OPEN_HEAD,
            commit: {
              message: messageForIssue(99),
              committer: { date: '2026-07-20T09:00:00.000Z' },
            },
          },
          {
            sha: MERGED_HEAD,
            commit: {
              message: messageForIssue(42),
              committer: { date: '2026-07-20T08:00:00.000Z' },
            },
          },
        ]);
      }
      throw new Error(`Unexpected call: ${args.join(' ')}`);
    };

    const claims = await new GhLifecycleReader(run).readBranchClaims();

    expect(claims[0]?.claimTrailers).toContain('Jinn-Autopilot-Issue: 42');
    expect(claims[0]?.claimTrailers).not.toContain('Jinn-Autopilot-Issue: 99');
  });
});
