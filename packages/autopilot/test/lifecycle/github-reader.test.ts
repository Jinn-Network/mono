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
}) {
  return {
    number: input.number,
    title: `PR ${input.number}`,
    body: 'Lifecycle PR',
    author: { login: 'trusted' },
    baseRefName: 'next',
    headRefName: `autopilot/${input.number === 101 ? 42 : 41}`,
    headRefOid: input.head,
    isDraft: input.state === 'OPEN',
    state: input.state,
    labels: {
      pageInfo: { hasNextPage: false },
      nodes: [{ name: 'engine:review' }],
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
      pageInfo: { hasPreviousPage: false },
      nodes: [{
        commit: {
          oid: input.head,
          committedDate: '2026-07-20T09:00:00.000Z',
          message: 'work',
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
});
