import { describe, expect, it, vi } from 'vitest';
import type { CommandRunner } from '../../src/dispatcher/issue-source.js';
import {
  extractImplementationCompletionSummary,
  GhLifecycleReader,
} from '../../src/lifecycle/github-reader.js';
import {
  GitHubUsageMeter,
  makeGitHubUsageCommandRunner,
} from '../../src/lifecycle/github-usage.js';

const OPEN_HEAD = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const MERGED_HEAD = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
const REVIEW_CLAIM_GLOB = 'refs/jinn-autopilot/review-claims/v1/*';
const AUTOPILOT_BRANCH_GLOB = 'refs/heads/autopilot/*';

/**
 * Every review-claim read now goes over the git transport (a single
 * `git ls-remote <remote> '<glob>'` per snapshot, see github-reader.ts) —
 * GitHub's GraphQL `ref(qualifiedName:)` permanently returns null for this
 * custom ref namespace (jinn-mono#1883-follow-up, proven live). Fakes below
 * that don't care about review claims answer every `git` call with "no refs
 * yet" so every PR's `reviewClaim` resolves to null, matching the old
 * always-absent GraphQL stub they replace.
 */
function noReviewClaimRefs(command: string): string | undefined {
  return command === 'git' ? '' : undefined;
}

function isReviewClaimListingCall(args: string[]): boolean {
  return args[2] === 'ls-remote' && args[4] === REVIEW_CLAIM_GLOB;
}

function rateLimit() {
  return {
    cost: 1,
    remaining: 4_999,
    resetAt: '2026-07-22T13:00:00.000Z',
  };
}

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
  it('reads exact live GraphQL remaining evidence from the uncharged REST quota resource', async () => {
    const calls: string[][] = [];
    const reader = new GhLifecycleReader(async (_command, args) => {
      calls.push(args);
      return JSON.stringify({
        resources: {
          graphql: {
            limit: 5_000,
            used: 4_490,
            remaining: 510,
            reset: 1_784_725_200,
          },
        },
      });
    });

    await expect(reader.readGraphQlRemaining()).resolves.toBe(510);
    expect(calls[0]).toEqual([
      'api',
      '-H',
      'Accept: application/vnd.github+json',
      '-H',
      'X-GitHub-Api-Version: 2026-03-10',
      '/rate_limit',
    ]);
    expect(reader.githubUsage()).toMatchObject({
      graphqlRequests: 0,
      graphqlCost: 0,
      graphqlRemaining: 510,
      graphqlResetAt: '2026-07-22T13:00:00.000Z',
      restRequests: 1,
    });
  });

  it.each([
    ['missing resources', {}],
    ['missing graphql resource', { resources: {} }],
    ['invalid remaining', {
      resources: { graphql: { limit: 5_000, used: 5_001, remaining: -1, reset: 1_784_725_200 } },
    }],
    ['missing reset', {
      resources: { graphql: { limit: 5_000, used: 4_490, remaining: 510 } },
    }],
    ['inconsistent limit and used', {
      resources: { graphql: { limit: 5_000, used: 4_000, remaining: 510, reset: 1_784_725_200 } },
    }],
  ])('fails closed when the REST quota response has %s', async (_label, response) => {
    const reader = new GhLifecycleReader(async () => JSON.stringify(response));

    await expect(reader.readGraphQlRemaining()).rejects.toThrow(/rate-limit.*remaining|graphql/i);
  });

  it('fails closed when a requested native Project issue alias resolves to null', async () => {
    let query = '';
    const reader = new GhLifecycleReader(async (_command, args) => {
      query = args.find((arg) => arg.startsWith('query=')) ?? '';
      return JSON.stringify({
        data: {
          rateLimit: { cost: 2, remaining: 518, resetAt: '2026-07-22T13:00:00.000Z' },
          repository: {
            issue42: {
              closedByPullRequestsReferences: {
                pageInfo: { hasNextPage: false },
                nodes: [{ number: 101, state: 'OPEN' }, { number: 99, state: 'MERGED' }],
              },
            },
            issue43: null,
          },
        },
      });
    });

    await expect(reader.readPullRequestNumbersClosingIssues([43, 42, 42]))
      .rejects.toThrow(/issue #43.*null|issue #43.*missing/i);
    expect(query).toContain('rateLimit { cost remaining resetAt }');
    expect(query).toContain('issue42: issue(number: 42)');
    expect(query).toContain('nodes { number state }');
    expect(reader.githubUsage()).toMatchObject({
      graphqlRequests: 1,
      graphqlCost: 2,
      graphqlRemaining: 518,
    });
  });

  it('discovers only open PR numbers closing targeted issues with strict quota evidence', async () => {
    const reader = new GhLifecycleReader(async () => JSON.stringify({
      data: {
        rateLimit: { cost: 2, remaining: 518, resetAt: '2026-07-22T13:00:00.000Z' },
        repository: {
          issue42: {
            closedByPullRequestsReferences: {
              pageInfo: { hasNextPage: false },
              nodes: [{ number: 101, state: 'OPEN' }, { number: 99, state: 'MERGED' }],
            },
          },
        },
      },
    }));

    await expect(reader.readPullRequestNumbersClosingIssues([42, 42]))
      .resolves.toEqual(new Set([101]));
  });

  it.each([
    ['partial data with GraphQL errors', [{ message: 'issue lookup failed' }]],
    ['a malformed GraphQL errors member', { message: 'not an array' }],
  ] as const)('fails closed on %s', async (_label, errors) => {
    const reader = new GhLifecycleReader(async () => JSON.stringify({
      errors,
      data: {
        rateLimit: { cost: 1, remaining: 518, resetAt: '2026-07-22T13:00:00.000Z' },
        repository: {
          issue42: {
            closedByPullRequestsReferences: {
              pageInfo: { hasNextPage: false },
              nodes: [{ number: 101, state: 'OPEN' }],
            },
          },
        },
      },
    }));

    await expect(reader.readPullRequestNumbersClosingIssues([42]))
      .rejects.toThrow(/GraphQL errors/i);
  });

  it('fails closed when targeted issue-to-closing-PR discovery is truncated', async () => {
    const reader = new GhLifecycleReader(async () => JSON.stringify({
      data: {
        rateLimit: { cost: 1, remaining: 518, resetAt: '2026-07-22T13:00:00.000Z' },
        repository: {
          issue42: {
            closedByPullRequestsReferences: {
              pageInfo: { hasNextPage: true },
              nodes: [{ number: 101, state: 'OPEN' }],
            },
          },
        },
      },
    }));

    await expect(reader.readPullRequestNumbersClosingIssues([42]))
      .rejects.toThrow(/truncated|pagination/i);
  });

  it('fails closed when targeted issue-to-closing-PR discovery omits quota evidence', async () => {
    const reader = new GhLifecycleReader(async () => JSON.stringify({
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
    }));

    await expect(reader.readPullRequestNumbersClosingIssues([42]))
      .rejects.toThrow(/rateLimit/i);
  });

  it('reuses a shared metered runner without counting reader traffic twice', async () => {
    const raw: CommandRunner = async () => '[]';
    const meter = new GitHubUsageMeter();
    const run = makeGitHubUsageCommandRunner(raw, meter);
    const reader = new GhLifecycleReader(run, {
      usageMeter: meter,
      runnerIsMetered: true,
    });

    await expect(reader.readIssues({
      currentSprintIterationId: null,
      getIssue: () => null,
    })).resolves.toEqual([]);
    expect(reader.githubUsage().restRequests).toBe(1);
  });

  it('counts each explicit REST page used to read open issues', async () => {
    const calls: string[][] = [];
    const rows = Array.from({ length: 101 }, (_, index) => ({
      number: index + 1,
      title: `Issue ${index + 1}`,
      labels: [],
      author: { login: 'trusted' },
      user: { login: 'trusted' },
    }));
    const run: CommandRunner = async (command, args) => {
      calls.push(args);
      if (command !== 'gh') throw new Error('unexpected command');
      if (args[0] === 'issue') return JSON.stringify(rows);
      const endpoint = args[1] ?? '';
      if (endpoint.endsWith('&page=1')) return JSON.stringify(rows.slice(0, 100));
      if (endpoint.endsWith('&page=2')) return JSON.stringify(rows.slice(100));
      throw new Error(`unexpected call: ${args.join(' ')}`);
    };
    const reader = new GhLifecycleReader(run);

    const issues = await reader.readIssues({
      currentSprintIterationId: null,
      getIssue: () => null,
    });

    expect(issues).toHaveLength(101);
    expect(calls).toEqual([
      ['api', 'repos/Jinn-Network/mono/issues?state=open&per_page=100&page=1'],
      ['api', 'repos/Jinn-Network/mono/issues?state=open&per_page=100&page=2'],
    ]);
    expect(reader.githubUsage().restRequests).toBe(2);
  });

  it('counts each explicit REST page used to read matching branch refs', async () => {
    const calls: string[][] = [];
    const firstPage = Array.from({ length: 100 }, (_, index) => ({
      ref: `refs/heads/not-autopilot-${index}`,
      object: { sha: `${index}`.padStart(40, '0') },
    }));
    const run: CommandRunner = async (_command, args) => {
      calls.push(args);
      if (args.includes('--paginate')) return JSON.stringify([firstPage, []]);
      const endpoint = args[1] ?? '';
      if (endpoint.endsWith('&page=1')) return JSON.stringify(firstPage);
      if (endpoint.endsWith('&page=2')) return JSON.stringify([]);
      throw new Error(`unexpected call: ${args.join(' ')}`);
    };
    const reader = new GhLifecycleReader(run);

    await expect(reader.readBranchClaims()).resolves.toEqual([]);

    expect(calls).toEqual([
      ['api', 'repos/Jinn-Network/mono/git/matching-refs/heads/autopilot/?per_page=100&page=1'],
      ['api', 'repos/Jinn-Network/mono/git/matching-refs/heads/autopilot/?per_page=100&page=2'],
    ]);
    expect(reader.githubUsage().restRequests).toBe(2);
  });

  it('requests and meters top-level GraphQL rate-limit evidence', async () => {
    let query = '';
    const run: CommandRunner = async (_command, args) => {
      query = args.find((arg) => arg.startsWith('query=')) ?? '';
      return JSON.stringify({
        data: {
          rateLimit: {
            cost: 3,
            remaining: 4_997,
            resetAt: '2026-07-22T13:00:00.000Z',
          },
          repository: {
            issue: {
              projectItems: {
                pageInfo: { hasNextPage: false },
                nodes: [{
                  id: 'PVTI_42',
                  project: { number: 1 },
                  status: { name: 'In Review' },
                  priority: { name: 'P1' },
                  effort: { name: 'Medium' },
                  blockedOn: { name: 'Nothing' },
                  issueType: { name: 'fix' },
                }],
              },
            },
          },
        },
      });
    };
    const reader = new GhLifecycleReader(run);

    await expect(reader.readProjectItemForReconciliation(42)).resolves.toEqual({
      id: 'PVTI_42',
      status: 'In Review',
      priority: 'P1',
      effort: 'Medium',
      blockedOn: 'Nothing',
      issueType: 'fix',
    });

    expect(query).toContain('rateLimit { cost remaining resetAt }');
    expect(query).toContain('fieldValueByName(name: "Priority")');
    expect(query).toContain('fieldValueByName(name: "Effort")');
    expect(query).toContain('fieldValueByName(name: "Type")');
    expect(reader.githubUsage()).toMatchObject({
      graphqlRequests: 1,
      graphqlCost: 3,
      graphqlRemaining: 4_997,
    });
  });

  it('fails closed when the direct targeted Project-item lookup exceeds its fixed limit', async () => {
    const run: CommandRunner = async () => JSON.stringify({
      data: {
        rateLimit: { cost: 1, remaining: 4_999, resetAt: '2026-07-22T13:00:00.000Z' },
        repository: {
          issue: {
            projectItems: { pageInfo: { hasNextPage: true }, nodes: [] },
          },
        },
      },
    });

    await expect(new GhLifecycleReader(run).readProjectItemForReconciliation(42))
      .rejects.toThrow(/Project-item.*pagination|pagination.*fixed limit/i);
  });

  it('combines targeted Project and open closing-PR relation evidence in one query', async () => {
    let query = '';
    const run: CommandRunner = async (_command, args) => {
      query = args.find((arg) => arg.startsWith('query=')) ?? '';
      return JSON.stringify({
        data: {
          rateLimit: { cost: 2, remaining: 4_998, resetAt: '2026-07-22T13:00:00.000Z' },
          repository: {
            issue: {
              projectItems: {
                pageInfo: { hasNextPage: false },
                nodes: [{
                  id: 'PVTI_42',
                  project: { number: 1 },
                  status: { name: 'In Progress' },
                  priority: { name: 'P1' },
                  effort: { name: 'Medium' },
                  blockedOn: { name: 'Nothing' },
                  issueType: { name: 'fix' },
                }],
              },
              closedByPullRequestsReferences: {
                pageInfo: { hasNextPage: false },
                nodes: [
                  { number: 101, state: 'OPEN' },
                  { number: 99, state: 'MERGED' },
                ],
              },
            },
          },
        },
      });
    };
    const reader = new GhLifecycleReader(run);

    await expect(reader.readIssueActionContextForReconciliation(42)).resolves.toEqual({
      projectItem: expect.objectContaining({ id: 'PVTI_42', status: 'In Progress' }),
      openPullRequestNumbers: new Set([101]),
    });
    expect(query).toContain('projectItems(first: 10)');
    expect(query).toContain('closedByPullRequestsReferences(first: 100, includeClosedPrs: true)');
    expect(reader.githubUsage()).toMatchObject({ graphqlRequests: 1, graphqlCost: 2 });
  });

  it('fails closed when the combined targeted issue context is paginated', async () => {
    const run: CommandRunner = async () => JSON.stringify({
      data: {
        rateLimit: { cost: 2, remaining: 4_998, resetAt: '2026-07-22T13:00:00.000Z' },
        repository: {
          issue: {
            projectItems: { pageInfo: { hasNextPage: false }, nodes: [] },
            closedByPullRequestsReferences: {
              pageInfo: { hasNextPage: true },
              nodes: [],
            },
          },
        },
      },
    });

    await expect(new GhLifecycleReader(run).readIssueActionContextForReconciliation(42))
      .rejects.toThrow(/pagination/i);
  });

  it('fails closed when the combined context reports more than its two-point reserve', async () => {
    const run: CommandRunner = async () => JSON.stringify({
      data: {
        rateLimit: { cost: 3, remaining: 4_997, resetAt: '2026-07-22T13:00:00.000Z' },
        repository: {
          issue: {
            projectItems: { pageInfo: { hasNextPage: false }, nodes: [] },
            closedByPullRequestsReferences: {
              pageInfo: { hasNextPage: false },
              nodes: [],
            },
          },
        },
      },
    });

    await expect(new GhLifecycleReader(run).readIssueActionContextForReconciliation(42))
      .rejects.toThrow(/exceeded 2-point reserve/i);
  });

  it('fails closed when a lifecycle GraphQL response omits rate-limit evidence', async () => {
    const run: CommandRunner = async () => JSON.stringify({
      data: { repository: { issue: { projectItems: { nodes: [] } } } },
    });

    await expect(new GhLifecycleReader(run).readProjectItemForReconciliation(42))
      .rejects.toThrow(/rateLimit/i);
  });

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
    const run: CommandRunner = async (command, args) => {
      const stub = noReviewClaimRefs(command);
      if (stub !== undefined) return stub;
      const query = args.find((arg) => arg.startsWith('query=')) ?? '';
      if (query.includes('closedByPullRequestsReferences')) {
        return JSON.stringify({
          data: {
            rateLimit: rateLimit(),
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
      return JSON.stringify({
        data: {
          rateLimit: rateLimit(),
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
    const run: CommandRunner = async (command, args) => {
      calls.push(args);
      const stub = noReviewClaimRefs(command);
      if (stub !== undefined) return stub;
      const query = args.find((arg) => arg.startsWith('query=')) ?? '';
      if (query.includes('closedByPullRequestsReferences')) {
        return JSON.stringify({
          data: {
            rateLimit: rateLimit(),
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
      return JSON.stringify({
        data: {
          rateLimit: rateLimit(),
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
    // Replaces the old per-PR GraphQL ref(qualifiedName) query-count assertion:
    // review-claim reads are now one shared git-transport listing per page,
    // not one GraphQL call per PR (jinn-mono#1883-follow-up).
    expect(calls.filter(isReviewClaimListingCall)).toHaveLength(1);
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
    const run: CommandRunner = async (command, args) => {
      calls.push(args);
      const stub = noReviewClaimRefs(command);
      if (stub !== undefined) return stub;
      if (args[1]?.includes('/commits?')) {
        const page = args[1].includes('page=2') ? 2 : 1;
        return JSON.stringify(historyPage(page));
      }
      return JSON.stringify({
        data: {
          rateLimit: rateLimit(),
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
        return JSON.stringify([{
          ref: 'refs/heads/autopilot/42',
          object: { sha: OPEN_HEAD },
        }]);
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

  it('discovers incremental Autopilot branch claims through git transport', async () => {
    const calls: Array<{ command: string; args: string[] }> = [];
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
    const run: CommandRunner = async (command, args) => {
      calls.push({ command, args });
      if (command === 'git') {
        expect(args[2]).toBe('ls-remote');
        expect(args[4]).toBe(AUTOPILOT_BRANCH_GLOB);
        return `${OPEN_HEAD}\trefs/heads/autopilot/42\n`;
      }
      if (args[1]?.includes('/commits?')) {
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

    const claims = await new GhLifecycleReader(run).readIncrementalBranchClaims();

    expect(claims).toEqual([
      expect.objectContaining({ issueNumber: 42, headOid: OPEN_HEAD }),
    ]);
    expect(calls.some(({ args }) => args[1]?.includes('matching-refs'))).toBe(false);
  });

  it('ignores well-formed nonnumeric and nested refs around numeric incremental claims', async () => {
    const ignoredOne = 'cccccccccccccccccccccccccccccccccccccccc';
    const ignoredTwo = 'dddddddddddddddddddddddddddddddddddddddd';
    const claimMessage = (issueNumber: number) => [
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
    const run: CommandRunner = async (command, args) => {
      if (command === 'git') {
        return [
          `${ignoredOne}\trefs/heads/autopilot/capability-probe`,
          `${OPEN_HEAD}\trefs/heads/autopilot/42`,
          `${ignoredTwo}\trefs/heads/autopilot/temporary/nested`,
          `${MERGED_HEAD}\trefs/heads/autopilot/43`,
          '',
        ].join('\n');
      }
      if (args[1]?.includes('/commits?')) {
        const issueNumber = args[1].includes(OPEN_HEAD) ? 42 : 43;
        const head = issueNumber === 42 ? OPEN_HEAD : MERGED_HEAD;
        return JSON.stringify([{
          sha: head,
          commit: {
            message: claimMessage(issueNumber),
            committer: { date: '2026-07-20T09:00:00.000Z' },
          },
        }]);
      }
      throw new Error(`Unexpected call: ${args.join(' ')}`);
    };

    await expect(new GhLifecycleReader(run).readIncrementalBranchClaims()).resolves.toEqual([
      expect.objectContaining({ issueNumber: 42, headOid: OPEN_HEAD }),
      expect.objectContaining({ issueNumber: 43, headOid: MERGED_HEAD }),
    ]);
  });

  it.each([
    ['a missing tab', `${OPEN_HEAD} refs/heads/autopilot/42\n`],
    ['an extra tab', `${OPEN_HEAD}\trefs/heads/autopilot/42\textra\n`],
    ['a trailing empty tab field', `${OPEN_HEAD}\trefs/heads/autopilot/42\t\n`],
    ['a trailing space in the ref', `${OPEN_HEAD}\trefs/heads/autopilot/42 \n`],
    ['a whitespace-only line', ' \n'],
    ['a non-head ref', `${OPEN_HEAD}\trefs/tags/autopilot/42\n`],
    ['a ref outside the requested prefix', `${OPEN_HEAD}\trefs/heads/not-autopilot/42\n`],
    ['a control character', `${OPEN_HEAD}\trefs/heads/autopilot/bad\u0001ref\n`],
    ['an invalid OID', `not-an-oid\trefs/heads/autopilot/42\n`],
    [
      'a numeric issue outside the safe integer range',
      `${OPEN_HEAD}\trefs/heads/autopilot/99999999999999999999\n`,
    ],
  ])('fails closed when an incremental branch listing contains %s', async (_label, listing) => {
    const reader = new GhLifecycleReader(async (command) => (
      command === 'git' ? listing : '[]'
    ));

    await expect(reader.readIncrementalBranchClaims())
      .rejects.toThrow(/branch ref listing|Git OID|Git ref/i);
  });

  it('fails closed on duplicate numeric incremental branch refs', async () => {
    const reader = new GhLifecycleReader(async (command) => (
      command === 'git'
        ? `${OPEN_HEAD}\trefs/heads/autopilot/42\n${MERGED_HEAD}\trefs/heads/autopilot/42\n`
        : '[]'
    ));

    await expect(reader.readIncrementalBranchClaims()).rejects.toThrow(/branch ref listing/i);
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
        return JSON.stringify([{
          ref: 'refs/heads/autopilot/42',
          object: { sha: OPEN_HEAD },
        }]);
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
    const run: CommandRunner = async (command, args) => {
      const stub = noReviewClaimRefs(command);
      if (stub !== undefined) return stub;
      const query = args.find((arg) => arg.startsWith('query=')) ?? '';
      if (query.includes('closedByPullRequestsReferences')) {
        return JSON.stringify({
          data: {
            rateLimit: rateLimit(),
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
        return JSON.stringify({
          data: { rateLimit: rateLimit(), repository: { pullRequest: adopted } },
        });
      }
      return JSON.stringify({
        data: {
          rateLimit: rateLimit(),
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
        return JSON.stringify([{
          ref: 'refs/heads/autopilot/42',
          object: { sha: OPEN_HEAD },
        }]);
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
    return async (command) => {
      const stub = noReviewClaimRefs(command);
      if (stub !== undefined) return stub;
      return JSON.stringify({
        data: {
          rateLimit: rateLimit(),
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
    const run: CommandRunner = async (command) => {
      if (command === 'git') throw new Error('transient GitHub network failure');
      return JSON.stringify({
        data: {
          rateLimit: rateLimit(),
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
    return async (command, args) => {
      const stub = noReviewClaimRefs(command);
      if (stub !== undefined) return stub;
      const query = args.find((arg) => arg.startsWith('query=')) ?? '';
      if (query.includes('closedByPullRequestsReferences')) {
        return JSON.stringify({
          data: {
            rateLimit: rateLimit(),
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
      return JSON.stringify({
        data: {
          rateLimit: rateLimit(),
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
    const run: CommandRunner = async (command, args) => {
      const stub = noReviewClaimRefs(command);
      if (stub !== undefined) return stub;
      const query = args.find((arg) => arg.startsWith('query=')) ?? '';
      if (query.includes('closedByPullRequestsReferences')) {
        throw new Error('transient GitHub network failure');
      }
      return JSON.stringify({
        data: {
          rateLimit: rateLimit(),
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

  describe('review-claim git transport', () => {
    function openPrPage(...nodes: ReturnType<typeof graphQlPr>[]): string {
      return JSON.stringify({
        data: {
          rateLimit: rateLimit(),
          repository: {
            pullRequests: {
              pageInfo: { hasNextPage: false, endCursor: null },
              nodes,
            },
          },
        },
      });
    }

    it('resolves a review claim via ls-remote + cat-file, returning the same shape as before', async () => {
      const oid = 'c'.repeat(40);
      const payload = '{"protocolVersion":2}';
      const ref = 'refs/jinn-autopilot/review-claims/v1/101';
      const gitCalls: string[][] = [];
      const run: CommandRunner = async (command, args) => {
        if (command !== 'git') {
          return openPrPage(graphQlPr({ number: 101, state: 'OPEN', head: OPEN_HEAD }));
        }
        const rest = args.slice(2);
        gitCalls.push(rest);
        if (rest[0] === 'ls-remote' && rest[2] === REVIEW_CLAIM_GLOB) return `${oid}\t${ref}\n`;
        if (rest[0] === 'cat-file' && rest[1] === '-e') return ''; // object already present locally
        if (rest[0] === 'cat-file' && rest[1] === '-p') return payload;
        throw new Error(`unexpected git call: ${rest.join(' ')}`);
      };

      const page = await new GhLifecycleReader(run).readPullRequests(null);

      expect(page.nodes[0]?.reviewClaim).toEqual({ oid, payload });
      // Objects already present locally (this scenario) never trigger a fetch.
      expect(gitCalls.some((call) => call[0] === 'fetch')).toBe(false);
    });

    it('caches a review-claim payload by OID: no fetch on a repeated OID, one fetch per changed OID', async () => {
      const oidX = 'd'.repeat(40);
      const oidY = 'e'.repeat(40);
      const ref = 'refs/jinn-autopilot/review-claims/v1/101';
      let currentOid = oidX;
      const localObjects = new Set<string>();
      const fetchCalls: string[][] = [];
      const run: CommandRunner = async (command, args) => {
        if (command !== 'git') {
          return openPrPage(graphQlPr({ number: 101, state: 'OPEN', head: OPEN_HEAD }));
        }
        const rest = args.slice(2);
        if (rest[0] === 'ls-remote' && rest[2] === REVIEW_CLAIM_GLOB) {
          return `${currentOid}\t${ref}\n`;
        }
        if (rest[0] === 'cat-file' && rest[1] === '-e') {
          if (localObjects.has(rest[2] ?? '')) return '';
          throw new Error('object not found locally');
        }
        if (rest[0] === 'fetch') {
          fetchCalls.push(rest);
          localObjects.add(currentOid);
          return '';
        }
        if (rest[0] === 'cat-file' && rest[1] === '-p') {
          const [payloadOid] = (rest[2] ?? '').split(':');
          return `{"oid":"${payloadOid}"}`;
        }
        throw new Error(`unexpected git call: ${rest.join(' ')}`);
      };
      const reader = new GhLifecycleReader(run);

      const first = await reader.readPullRequests(null);
      expect(fetchCalls).toHaveLength(1);
      expect(first.nodes[0]?.reviewClaim?.oid).toBe(oidX);

      const second = await reader.readPullRequests(null);
      expect(fetchCalls).toHaveLength(1);
      expect(second.nodes[0]?.reviewClaim?.oid).toBe(oidX);

      currentOid = oidY;
      const third = await reader.readPullRequests(null);
      expect(fetchCalls).toHaveLength(2);
      expect(third.nodes[0]?.reviewClaim?.oid).toBe(oidY);
    });

    it('resolves an absent review claim to null from empty ls-remote output', async () => {
      const run: CommandRunner = async (command) => {
        if (command === 'git') return '';
        return openPrPage(graphQlPr({ number: 101, state: 'OPEN', head: OPEN_HEAD }));
      };

      const page = await new GhLifecycleReader(run).readPullRequests(null);

      expect(page.nodes[0]?.reviewClaim).toBeNull();
    });

    it('fails loud on malformed git ls-remote output for review-claim refs', async () => {
      const run: CommandRunner = async (command) => {
        if (command === 'git') return 'not-a-valid-tab-separated-line\n';
        return openPrPage(graphQlPr({ number: 101, state: 'OPEN', head: OPEN_HEAD }));
      };

      await expect(new GhLifecycleReader(run).readPullRequests(null))
        .rejects.toThrow(/Malformed git ls-remote output/);
    });

    it('performs exactly one review-claim ls-remote listing for a snapshot with several PRs', async () => {
      const listingCalls: string[][] = [];
      const run: CommandRunner = async (command, args) => {
        if (command === 'git') {
          const rest = args.slice(2);
          if (rest[0] === 'ls-remote' && rest[2] === REVIEW_CLAIM_GLOB) listingCalls.push(rest);
          return '';
        }
        return openPrPage(
          graphQlPr({ number: 101, state: 'OPEN', head: '1'.repeat(40), headRefName: 'feature/101' }),
          graphQlPr({ number: 102, state: 'OPEN', head: '2'.repeat(40), headRefName: 'feature/102' }),
          graphQlPr({ number: 103, state: 'OPEN', head: '3'.repeat(40), headRefName: 'feature/103' }),
        );
      };

      const page = await new GhLifecycleReader(run).readPullRequests(null);

      expect(page.nodes).toHaveLength(3);
      expect(listingCalls).toHaveLength(1);
    });
  });
});
