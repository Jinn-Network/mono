import { describe, it, expect } from 'vitest';
import {
  fetchProjectSnapshot,
  ProjectFieldSchemaError,
  type CommandRunner,
  type ProjectSnapshot,
} from '../../src/dispatcher/project-snapshot.js';

// ---------------------------------------------------------------------------
// Fixtures
//
// Mirrors the real GitHub GraphQL response shape for:
//
//   query($cursor: String) {
//     rateLimit { remaining used resetAt }
//     organization(login: "Jinn-Network") {
//       projectV2(number: 1) {
//         items(first: 100, after: $cursor) {
//           pageInfo { hasNextPage endCursor }
//           nodes {
//             id
//             content {
//               __typename
//               ... on Issue { number issueType { name } }
//               ... on PullRequest { number }
//             }
//             status:    fieldValueByName(name: "Status")     { ... on ProjectV2ItemFieldSingleSelectValue { name } }
//             priority:  fieldValueByName(name: "Priority")   { ... on ProjectV2ItemFieldSingleSelectValue { name } }
//             effort:    fieldValueByName(name: "Effort")     { ... on ProjectV2ItemFieldSingleSelectValue { name } }
//             blockedOn: fieldValueByName(name: "Blocked on") { ... on ProjectV2ItemFieldSingleSelectValue { name } }
//           }
//         }
//       }
//     }
//   }
// ---------------------------------------------------------------------------

interface PageOptions {
  rateLimitRemaining: number;
  rateLimitUsed?: number;
  resetAt?: string;
  hasNextPage?: boolean;
  endCursor?: string;
  nodes: unknown[];
}

function buildPageResponse(opts: PageOptions): string {
  return JSON.stringify({
    data: {
      rateLimit: {
        remaining: opts.rateLimitRemaining,
        used: opts.rateLimitUsed ?? 5000 - opts.rateLimitRemaining,
        resetAt: opts.resetAt ?? '2026-05-25T16:00:00Z',
      },
      organization: {
        projectV2: {
          items: {
            pageInfo: {
              hasNextPage: opts.hasNextPage ?? false,
              endCursor: opts.endCursor ?? null,
            },
            nodes: opts.nodes,
          },
        },
      },
    },
  });
}

function singleSelect(name: string | null): { name: string } | null {
  return name == null ? null : { name };
}

function issueNode(args: {
  id: string;
  number: number;
  issueType?: string | null;
  status?: string | null;
  priority?: string | null;
  effort?: string | null;
  blockedOn?: string | null;
}): unknown {
  return {
    id: args.id,
    content: {
      __typename: 'Issue',
      number: args.number,
      issueType: args.issueType == null ? null : { name: args.issueType },
    },
    status: singleSelect(args.status ?? null),
    priority: singleSelect(args.priority ?? null),
    effort: singleSelect(args.effort ?? null),
    blockedOn: singleSelect(args.blockedOn ?? null),
  };
}

function prNode(args: { id: string; number: number }): unknown {
  return {
    id: args.id,
    content: {
      __typename: 'PullRequest',
      number: args.number,
    },
    status: null,
    priority: null,
    effort: null,
    blockedOn: null,
  };
}

function draftIssueNode(args: { id: string }): unknown {
  return {
    id: args.id,
    content: { __typename: 'DraftIssue' },
    status: null,
    priority: null,
    effort: null,
    blockedOn: null,
  };
}

function nullContentNode(args: { id: string }): unknown {
  // Underlying entity deleted while the project item lingered.
  return {
    id: args.id,
    content: null,
    status: singleSelect('Todo'),
    priority: singleSelect('P2'),
    effort: singleSelect('Low'),
    blockedOn: singleSelect('Nothing'),
  };
}

/**
 * Runner that returns one or more canned pages in sequence — first call returns
 * pages[0], second returns pages[1], etc. Throws if called more times than
 * configured. Records args from every call into `calls` for assertion.
 */
function makePagedRunner(pages: string[]): {
  runner: CommandRunner;
  calls: { cmd: string; args: string[] }[];
} {
  const calls: { cmd: string; args: string[] }[] = [];
  let i = 0;
  const runner: CommandRunner = async (cmd, args) => {
    calls.push({ cmd, args });
    if (i >= pages.length) {
      throw new Error(`unexpected extra runner call #${i + 1}; only ${pages.length} pages configured`);
    }
    return pages[i++]!;
  };
  return { runner, calls };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('fetchProjectSnapshot — single-page parsing', () => {
  it('parses a single-page response into typed SnapshotItem[]', async () => {
    const { runner } = makePagedRunner([
      buildPageResponse({
        rateLimitRemaining: 4999,
        nodes: [
          issueNode({
            id: 'PVTI_a',
            number: 561,
            issueType: 'fix',
            status: 'In Progress',
            priority: 'P1',
            effort: 'Medium',
            blockedOn: 'Nothing',
          }),
          issueNode({
            id: 'PVTI_b',
            number: 572,
            issueType: 'feat',
            status: 'Todo',
            priority: 'P2',
            effort: 'Low',
            blockedOn: 'Nothing',
          }),
        ],
      }),
    ]);

    const snap: ProjectSnapshot = await fetchProjectSnapshot(runner);

    expect(snap.items).toHaveLength(2);
    expect(snap.items[0]).toEqual({
      id: 'PVTI_a',
      number: 561,
      contentType: 'Issue',
      status: 'In Progress',
      priority: 'P1',
      effort: 'Medium',
      blockedOn: 'Nothing',
      issueType: 'fix',
    });
    expect(snap.items[1]).toEqual({
      id: 'PVTI_b',
      number: 572,
      contentType: 'Issue',
      status: 'Todo',
      priority: 'P2',
      effort: 'Low',
      blockedOn: 'Nothing',
      issueType: 'feat',
    });
  });

  it('coerces unset single-select fields to null', async () => {
    const { runner } = makePagedRunner([
      buildPageResponse({
        rateLimitRemaining: 4999,
        nodes: [
          issueNode({ id: 'PVTI_a', number: 600 }),
        ],
      }),
    ]);

    const snap = await fetchProjectSnapshot(runner);
    expect(snap.items[0]).toMatchObject({
      number: 600,
      status: null,
      priority: null,
      effort: null,
      blockedOn: null,
      issueType: null,
    });
  });

  it('coerces unknown issueType values to null', async () => {
    const { runner } = makePagedRunner([
      buildPageResponse({
        rateLimitRemaining: 4999,
        nodes: [
          issueNode({
            id: 'PVTI_a',
            number: 700,
            issueType: 'unknown-shape',
            status: 'Todo',
            priority: 'P2',
            effort: 'Low',
            blockedOn: 'Nothing',
          }),
        ],
      }),
    ]);

    const snap = await fetchProjectSnapshot(runner);
    expect(snap.items[0]!.issueType).toBeNull();
  });
});

describe('fetchProjectSnapshot — pagination', () => {
  it('follows endCursor across pages and concatenates items', async () => {
    // Populate at least one field so the schema-drift check (N≥3 all-null)
    // doesn't fire on this fixture; this test is about pagination, not schema.
    const { runner, calls } = makePagedRunner([
      buildPageResponse({
        rateLimitRemaining: 4999,
        hasNextPage: true,
        endCursor: 'CURSOR_A',
        nodes: [issueNode({ id: 'PVTI_1', number: 1, status: 'Todo' })],
      }),
      buildPageResponse({
        rateLimitRemaining: 4998,
        hasNextPage: true,
        endCursor: 'CURSOR_B',
        nodes: [issueNode({ id: 'PVTI_2', number: 2, status: 'Todo' })],
      }),
      buildPageResponse({
        rateLimitRemaining: 4997,
        hasNextPage: false,
        nodes: [issueNode({ id: 'PVTI_3', number: 3, status: 'Todo' })],
      }),
    ]);

    const snap = await fetchProjectSnapshot(runner);

    expect(snap.items.map((i) => i.number)).toEqual([1, 2, 3]);

    // First call must NOT contain a cursor variable.
    expect(calls[0]!.args.some((a) => a.startsWith('cursor='))).toBe(false);
    // Second call must pass cursor=CURSOR_A from the first response.
    expect(calls[1]!.args).toContain('cursor=CURSOR_A');
    // Third call must pass cursor=CURSOR_B from the second response.
    expect(calls[2]!.args).toContain('cursor=CURSOR_B');
  });

  it('surfaces rateLimit from the LAST page only', async () => {
    const { runner } = makePagedRunner([
      buildPageResponse({
        rateLimitRemaining: 4999,
        hasNextPage: true,
        endCursor: 'X',
        nodes: [issueNode({ id: 'PVTI_1', number: 1 })],
      }),
      buildPageResponse({
        rateLimitRemaining: 4500, // intentionally decreased to make the test diagnostic
        resetAt: '2026-05-25T17:00:00Z',
        hasNextPage: false,
        nodes: [issueNode({ id: 'PVTI_2', number: 2 })],
      }),
    ]);

    const snap = await fetchProjectSnapshot(runner);
    expect(snap.rateLimit).toEqual({
      remaining: 4500,
      used: 500,
      resetAt: '2026-05-25T17:00:00Z',
    });
  });

  it('does not make a follow-up call when hasNextPage is false', async () => {
    // Only one page configured; the runner throws if called twice.
    const { runner, calls } = makePagedRunner([
      buildPageResponse({
        rateLimitRemaining: 4999,
        hasNextPage: false,
        nodes: [issueNode({ id: 'PVTI_1', number: 1 })],
      }),
    ]);

    await expect(fetchProjectSnapshot(runner)).resolves.toBeDefined();
    expect(calls).toHaveLength(1);
  });
});

describe('fetchProjectSnapshot — content filtering', () => {
  it('drops items whose content is null (deleted underlying entity)', async () => {
    const { runner } = makePagedRunner([
      buildPageResponse({
        rateLimitRemaining: 4999,
        nodes: [
          issueNode({ id: 'PVTI_a', number: 1, status: 'Todo' }),
          nullContentNode({ id: 'PVTI_dead' }),
          issueNode({ id: 'PVTI_b', number: 2, status: 'Todo' }),
        ],
      }),
    ]);

    const snap = await fetchProjectSnapshot(runner);
    expect(snap.items.map((i) => i.id)).toEqual(['PVTI_a', 'PVTI_b']);
  });

  it('surfaces PullRequest items with contentType=PullRequest and issueType=null', async () => {
    const { runner } = makePagedRunner([
      buildPageResponse({
        rateLimitRemaining: 4999,
        nodes: [
          issueNode({ id: 'PVTI_iss', number: 100, issueType: 'fix', status: 'Todo' }),
          prNode({ id: 'PVTI_pr', number: 581 }),
        ],
      }),
    ]);

    const snap = await fetchProjectSnapshot(runner);
    expect(snap.items).toHaveLength(2);
    const pr = snap.items.find((i) => i.id === 'PVTI_pr');
    expect(pr).toBeDefined();
    expect(pr!.contentType).toBe('PullRequest');
    expect(pr!.number).toBe(581);
    expect(pr!.issueType).toBeNull();
  });

  it('surfaces DraftIssue items with contentType=DraftIssue, number=-1, issueType=null', async () => {
    const { runner } = makePagedRunner([
      buildPageResponse({
        rateLimitRemaining: 4999,
        nodes: [
          draftIssueNode({ id: 'PVTI_draft' }),
        ],
      }),
    ]);

    const snap = await fetchProjectSnapshot(runner);
    expect(snap.items).toHaveLength(1);
    expect(snap.items[0]).toMatchObject({
      id: 'PVTI_draft',
      contentType: 'DraftIssue',
      number: -1,
      issueType: null,
    });
  });
});

describe('fetchProjectSnapshot — schema-drift detection', () => {
  it('throws ProjectFieldSchemaError when every item has all four single-select fields null', async () => {
    const { runner } = makePagedRunner([
      buildPageResponse({
        rateLimitRemaining: 4999,
        nodes: [
          issueNode({ id: 'PVTI_a', number: 1 }), // all fields unset
          issueNode({ id: 'PVTI_b', number: 2 }),
          issueNode({ id: 'PVTI_c', number: 3 }),
        ],
      }),
    ]);

    await expect(fetchProjectSnapshot(runner)).rejects.toBeInstanceOf(ProjectFieldSchemaError);
  });

  it('does NOT throw when fewer than 3 issues are all-null (threshold avoids false positives on small boards)', async () => {
    // 2 brand-new untriaged issues with all fields null is a normal state,
    // not schema drift. The threshold is SCHEMA_DRIFT_MIN_ISSUE_COUNT (3).
    const { runner } = makePagedRunner([
      buildPageResponse({
        rateLimitRemaining: 4999,
        nodes: [
          issueNode({ id: 'PVTI_a', number: 1 }),
          issueNode({ id: 'PVTI_b', number: 2 }),
        ],
      }),
    ]);

    await expect(fetchProjectSnapshot(runner)).resolves.toBeDefined();
  });

  it('does NOT throw when some items have all fields null and others do not (mixed)', async () => {
    const { runner } = makePagedRunner([
      buildPageResponse({
        rateLimitRemaining: 4999,
        nodes: [
          issueNode({ id: 'PVTI_a', number: 1 }), // brand-new untriaged
          issueNode({
            id: 'PVTI_b',
            number: 2,
            status: 'Todo',
            priority: 'P2',
            effort: 'Low',
            blockedOn: 'Nothing',
          }),
        ],
      }),
    ]);

    await expect(fetchProjectSnapshot(runner)).resolves.toBeDefined();
  });

  it('does NOT throw on an empty board', async () => {
    const { runner } = makePagedRunner([
      buildPageResponse({
        rateLimitRemaining: 4999,
        nodes: [],
      }),
    ]);

    const snap = await fetchProjectSnapshot(runner);
    expect(snap.items).toEqual([]);
  });

  it('ignores PRs/DraftIssues when computing the schema-drift check', async () => {
    // PRs and DraftIssues legitimately have all four fields null, so a board
    // containing ONLY PRs and DraftIssues (zero Issues) should not be flagged.
    const { runner } = makePagedRunner([
      buildPageResponse({
        rateLimitRemaining: 4999,
        nodes: [
          prNode({ id: 'PVTI_pr', number: 100 }),
          draftIssueNode({ id: 'PVTI_draft' }),
        ],
      }),
    ]);

    await expect(fetchProjectSnapshot(runner)).resolves.toBeDefined();
  });
});

describe('fetchProjectSnapshot — invocation shape', () => {
  it('invokes gh api graphql with -f query=… form variable', async () => {
    const { runner, calls } = makePagedRunner([
      buildPageResponse({
        rateLimitRemaining: 4999,
        nodes: [issueNode({ id: 'PVTI_a', number: 1, status: 'Todo' })],
      }),
    ]);

    await fetchProjectSnapshot(runner);

    expect(calls[0]!.cmd).toBe('gh');
    expect(calls[0]!.args[0]).toBe('api');
    expect(calls[0]!.args[1]).toBe('graphql');
    // `query=…` form variable must be present
    expect(calls[0]!.args.some((a) => a.startsWith('query='))).toBe(true);
  });
});
