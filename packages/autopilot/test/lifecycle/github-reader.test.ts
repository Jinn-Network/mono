import { describe, expect, it, vi } from 'vitest';
import type { CommandRunner } from '../../src/dispatcher/issue-source.js';
import {
  extractImplementationCompletionSummary,
  GhLifecycleReader,
} from '../../src/lifecycle/github-reader.js';

const OPEN_HEAD = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const MERGED_HEAD = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';

it('extracts the durable summary from an exact phase-complete commit envelope', () => {
  const trailers = [
    'Jinn-Autopilot-Protocol: 2',
    'Jinn-Autopilot-Phase: implement',
    'Jinn-Autopilot-Issue: 42',
    'Jinn-Autopilot-PR: 101',
    'Jinn-Autopilot-Attempt: 11111111-1111-4111-8111-111111111111',
    'Jinn-Autopilot-Runner: runner-a',
    'Jinn-Autopilot-Login: implementer',
    `Jinn-Autopilot-Expected-Head: ${OPEN_HEAD}`,
    'Jinn-Autopilot-Target-Base: next',
    'Jinn-Autopilot-Claimed-At: 2026-07-20T12:00:00.000Z',
    'Jinn-Autopilot-Phase-Complete: true',
  ].join('\n');
  const message = [
    'Autopilot implementation phase complete',
    '',
    'Implemented exact lifecycle ownership.',
    '',
    trailers,
  ].join('\n');

  expect(extractImplementationCompletionSummary(message, trailers))
    .toBe('Implemented exact lifecycle ownership.');
});

function graphQlPr(input: {
  readonly number: number;
  readonly state: 'OPEN' | 'MERGED' | 'CLOSED';
  readonly head: string;
  readonly comments?: readonly string[];
  readonly headRefName?: string;
  readonly historyTruncated?: boolean;
  readonly commentsTruncated?: boolean;
  readonly labels?: readonly string[];
  readonly message?: string;
  readonly closingIssueNumber?: number;
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
      nodes: [{ number: input.closingIssueNumber ?? (input.number === 101 ? 42 : 41) }],
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
      pageInfo: { hasPreviousPage: input.commentsTruncated ?? false },
      nodes: (input.comments ?? []).map((body, index) => ({
        body,
        createdAt: `2026-07-20T09:0${index}:00.000Z`,
      })),
    },
    statusCheckRollup: null,
  };
}

describe('GhLifecycleReader', () => {
  it('parses lifecycle metadata only from the terminal trailer block', async () => {
    const trailers = [
      'Jinn-Autopilot-Protocol: 2',
      'Jinn-Autopilot-Phase: implement',
      'Jinn-Autopilot-Issue: 42',
      'Jinn-Autopilot-PR: 101',
      'Jinn-Autopilot-Attempt: 11111111-1111-4111-8111-111111111111',
      'Jinn-Autopilot-Runner: runner-a',
      'Jinn-Autopilot-Login: implementer',
      `Jinn-Autopilot-Expected-Head: ${OPEN_HEAD}`,
      'Jinn-Autopilot-Target-Base: next',
      'Jinn-Autopilot-Claimed-At: 2026-07-20T12:00:00.000Z',
      'Jinn-Autopilot-Phase-Complete: true',
    ].join('\n');
    const summary = [
      'Implemented lifecycle recovery.',
      'Jinn-Autopilot-Login: this line is summary content',
      'Preserved exact authority.',
    ].join('\n');
    const message = [
      'Autopilot implementation phase complete',
      '',
      summary,
      '',
      trailers,
    ].join('\n');
    const run: CommandRunner = async (_command, args) => {
      const query = args.find((arg) => arg.startsWith('query=')) ?? '';
      if (query.includes('closedByPullRequestsReferences')) {
        return JSON.stringify({
          data: {
            repository: {
              issue42: {
                closedByPullRequestsReferences: {
                  pageInfo: { hasNextPage: false },
                  nodes: [],
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
                message,
              })],
            },
          },
        },
      });
    };

    const page = await new GhLifecycleReader(run).readPullRequests(null, [42]);

    expect(page.nodes[0]?.implementationCompletionSummary).toBe(summary);
  });

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
                  }), graphQlPr({
                    number: 98,
                    state: 'CLOSED',
                    head: 'cccccccccccccccccccccccccccccccccccccccc',
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
    expect(mergedQuery).toContain(
      'closedByPullRequestsReferences(first: 100, includeClosedPrs: true)',
    );
    expect(mergedQuery).not.toContain('reviews(');
    expect(mergedQuery).not.toContain('comments(');
    expect(mergedQuery).not.toContain('statusCheckRollup');
    expect(queries.filter((query) => query.includes('ref(qualifiedName'))).toHaveLength(1);
    expect(page.nodes.map((pr) => [pr.number, pr.state])).toEqual([
      [101, 'OPEN'],
      [99, 'MERGED'],
    ]);
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

  function pageOf(...nodes: ReturnType<typeof graphQlPr>[]): CommandRunner {
    return async (_command, args) => {
      const query = args.find((arg) => arg.startsWith('query=')) ?? '';
      if (query.includes('ref(qualifiedName')) {
        return JSON.stringify({ data: { repository: { ref: null } } });
      }
      return JSON.stringify({
        data: {
          repository: {
            pullRequests: {
              pageInfo: { hasNextPage: false, endCursor: null },
              nodes,
            },
          },
        },
      });
    };
  }

  it('degrades a PR with an undecodable Human marker instead of failing the whole page', async () => {
    const hostile = graphQlPr({
      number: 201,
      state: 'OPEN',
      head: 'c'.repeat(40),
      headRefName: 'feature/201',
      comments: [
        '<!-- jinn-autopilot-human:v2 pr=201 phase=awaiting-review code=review-escalation -->\n\n',
      ],
    });
    const healthy = graphQlPr({
      number: 202,
      state: 'OPEN',
      head: 'd'.repeat(40),
      headRefName: 'feature/202',
    });

    const page = await new GhLifecycleReader(pageOf(hostile, healthy)).readPullRequests(null);

    expect(page.nodes.map((pr) => pr.number)).toEqual([201, 202]);
    const degraded = page.nodes[0];
    expect(degraded?.humanReason).toMatchObject({
      phase: 'awaiting-review',
      code: 'review-escalation',
    });
    expect(degraded?.humanReason?.detail).toContain('undecodable structured Human evidence');
    expect(degraded?.branchClaimTrailers).toBeNull();
    expect(degraded?.reviewClaim).toBeNull();
    expect(page.nodes[1]?.humanReason).toBeNull();
  });

  it('degrades a PR whose Human marker pr= field contradicts its own PR number', async () => {
    const hostile = graphQlPr({
      number: 203,
      state: 'OPEN',
      head: 'e'.repeat(40),
      headRefName: 'feature/203',
      comments: [
        '<!-- jinn-autopilot-human:v2 pr=999 phase=awaiting-review code=review-escalation -->'
        + '\n\nA real detail sentence.',
      ],
    });
    const healthy = graphQlPr({
      number: 204,
      state: 'OPEN',
      head: 'f'.repeat(40),
      headRefName: 'feature/204',
    });

    const page = await new GhLifecycleReader(pageOf(hostile, healthy)).readPullRequests(null);

    expect(page.nodes.map((pr) => pr.number)).toEqual([203, 204]);
    expect(page.nodes[0]?.humanReason?.detail).toContain('contradictory structured Human evidence');
    expect(page.nodes[1]?.humanReason).toBeNull();
  });

  it('degrades a PR whose comments were truncated by the first-page cap', async () => {
    const hostile = graphQlPr({
      number: 205,
      state: 'OPEN',
      head: '1'.repeat(40),
      headRefName: 'feature/205',
      commentsTruncated: true,
    });
    const healthy = graphQlPr({
      number: 206,
      state: 'OPEN',
      head: '2'.repeat(40),
      headRefName: 'feature/206',
    });

    const page = await new GhLifecycleReader(pageOf(hostile, healthy)).readPullRequests(null);

    expect(page.nodes.map((pr) => pr.number)).toEqual([205, 206]);
    expect(page.nodes[0]?.humanReason?.detail).toContain('comments were truncated');
    expect(page.nodes[0]?.checks).toEqual([]);
    expect(page.nodes[0]?.reviews).toEqual([]);
    expect(page.nodes[1]?.humanReason).toBeNull();
  });

  it('still fails the whole page on errors unrelated to per-PR evidence decoding', async () => {
    const run: CommandRunner = async (_command, args) => {
      const query = args.find((arg) => arg.startsWith('query=')) ?? '';
      if (query.includes('ref(qualifiedName')) {
        throw new Error('transient GitHub network failure');
      }
      return JSON.stringify({
        data: {
          repository: {
            pullRequests: {
              pageInfo: { hasNextPage: false, endCursor: null },
              nodes: [graphQlPr({ number: 301, state: 'OPEN', head: '3'.repeat(40) })],
            },
          },
        },
      });
    };

    await expect(new GhLifecycleReader(run).readPullRequests(null))
      .rejects.toThrow(/transient GitHub network failure/);
  });

  function mergedOutcomesRun(nodes: ReturnType<typeof graphQlPr>[]): CommandRunner {
    return async (_command, args) => {
      const query = args.find((arg) => arg.startsWith('query=')) ?? '';
      if (query.includes('closedByPullRequestsReferences')) {
        return JSON.stringify({
          data: {
            repository: {
              issue42: {
                closedByPullRequestsReferences: {
                  pageInfo: { hasNextPage: false },
                  nodes,
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
              nodes: [],
            },
          },
        },
      });
    };
  }

  it('skips a merged PR whose branch was garbage-collected post-merge (PR #1710) instead of failing the snapshot', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    // Mirrors the real PR #1710: MERGED, mergeCommit null, and commits(last:1)
    // no longer matches headRefOid because the branch was deleted after merge.
    const survivingCommitOid = 'c'.repeat(40);
    const staleHeadRefOid = 'd'.repeat(40);
    const goneBranch = {
      ...graphQlPr({
        number: 1710,
        state: 'MERGED',
        head: survivingCommitOid,
        closingIssueNumber: 42,
      }),
      headRefOid: staleHeadRefOid,
      mergeCommit: null,
    };
    const healthy = graphQlPr({
      number: 99,
      state: 'MERGED',
      head: MERGED_HEAD,
      closingIssueNumber: 42,
    });

    const page = await new GhLifecycleReader(mergedOutcomesRun([goneBranch, healthy]))
      .readPullRequests(null, [42]);

    expect(page.nodes.map((pr) => pr.number)).toEqual([99]);
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('skipping merged PR #1710 evidence'),
    );
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('missing its exact merged head commit'),
    );
    warnSpy.mockRestore();
  });

  it('skips a merged PR whose labels were truncated instead of failing the snapshot', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const truncated = {
      ...graphQlPr({
        number: 1712,
        state: 'MERGED',
        head: 'e'.repeat(40),
        closingIssueNumber: 42,
      }),
      labels: { pageInfo: { hasNextPage: true }, nodes: [] },
    };
    const healthy = graphQlPr({
      number: 99,
      state: 'MERGED',
      head: MERGED_HEAD,
      closingIssueNumber: 42,
    });

    const page = await new GhLifecycleReader(mergedOutcomesRun([truncated, healthy]))
      .readPullRequests(null, [42]);

    expect(page.nodes.map((pr) => pr.number)).toEqual([99]);
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('labels were truncated'));
    warnSpy.mockRestore();
  });

  it('skips a merged PR whose closing issue references were truncated instead of failing the snapshot', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const truncated = {
      ...graphQlPr({
        number: 1713,
        state: 'MERGED',
        head: 'f'.repeat(40),
        closingIssueNumber: 42,
      }),
      closingIssuesReferences: { pageInfo: { hasNextPage: true }, nodes: [] },
    };
    const healthy = graphQlPr({
      number: 99,
      state: 'MERGED',
      head: MERGED_HEAD,
      closingIssueNumber: 42,
    });

    const page = await new GhLifecycleReader(mergedOutcomesRun([truncated, healthy]))
      .readPullRequests(null, [42]);

    expect(page.nodes.map((pr) => pr.number)).toEqual([99]);
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('closing issue references were truncated'),
    );
    warnSpy.mockRestore();
  });

  it('still fails the whole page on a network failure reading merged outcomes', async () => {
    const run: CommandRunner = async (_command, args) => {
      const query = args.find((arg) => arg.startsWith('query=')) ?? '';
      if (query.includes('closedByPullRequestsReferences')) {
        throw new Error('transient GitHub network failure');
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

    await expect(new GhLifecycleReader(run).readPullRequests(null, [42]))
      .rejects.toThrow(/transient GitHub network failure/);
  });

  it('does not swallow a non-evidence error while decoding a single merged PR', async () => {
    // A malformed node (missing `labels` entirely) is a genuinely different
    // failure than the per-PR evidence-trust conditions the catch targets —
    // it must still fail the whole read, proving the catch isn't overbroad.
    const malformed = {
      ...graphQlPr({
        number: 1714,
        state: 'MERGED',
        head: MERGED_HEAD,
        closingIssueNumber: 42,
      }),
      labels: undefined,
    } as unknown as ReturnType<typeof graphQlPr>;

    await expect(
      new GhLifecycleReader(mergedOutcomesRun([malformed])).readPullRequests(null, [42]),
    ).rejects.toBeInstanceOf(TypeError);
  });
});
