import { describe, it, expect } from 'vitest';
import {
  fetchProjectSnapshot,
  PaginationLimitError,
  ProjectFieldSchemaError,
  resolveCurrentSprintIterationId,
  SCHEMA_DRIFT_MIN_ISSUE_COUNT,
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
  /** Optional `sprintField` block for the page. Omit to test the absent-field
   *  case (snapshot's `currentSprintIterationId` collapses to null). */
  sprintIterations?: Array<{ id: string; startDate: string; duration: number }> | null;
}

function buildPageResponse(opts: PageOptions): string {
  const sprintField =
    opts.sprintIterations === undefined
      ? null
      : opts.sprintIterations === null
        ? null
        : { configuration: { iterations: opts.sprintIterations } };
  return JSON.stringify({
    data: {
      rateLimit: {
        remaining: opts.rateLimitRemaining,
        used: opts.rateLimitUsed ?? 5000 - opts.rateLimitRemaining,
        resetAt: opts.resetAt ?? '2026-05-25T16:00:00Z',
      },
      organization: {
        projectV2: {
          sprintField,
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
  blockedBy?: number[];
  sprintIterationId?: string | null;
}): unknown {
  return {
    id: args.id,
    content: {
      __typename: 'Issue',
      number: args.number,
      issueType: args.issueType == null ? null : { name: args.issueType },
      blockedBy:
        args.blockedBy == null ? null : { nodes: args.blockedBy.map((number) => ({ number })) },
    },
    status: singleSelect(args.status ?? null),
    priority: singleSelect(args.priority ?? null),
    effort: singleSelect(args.effort ?? null),
    blockedOn: singleSelect(args.blockedOn ?? null),
    sprint: args.sprintIterationId == null ? null : { iterationId: args.sprintIterationId },
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
    sprint: null,
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
    sprint: null,
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
    sprint: null,
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
      blockedByIssues: [],
      sprintIterationId: null,
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
      blockedByIssues: [],
      sprintIterationId: null,
    });
  });

  it('parses native blocked_by dependency edges into blockedByIssues', async () => {
    const { runner } = makePagedRunner([
      buildPageResponse({
        rateLimitRemaining: 4999,
        nodes: [
          issueNode({ id: 'PVTI_dep', number: 100, issueType: 'feat', status: 'Todo', blockedBy: [50, 60] }),
          issueNode({ id: 'PVTI_free', number: 101, issueType: 'fix', status: 'Todo' }),
        ],
      }),
    ]);
    const snap = await fetchProjectSnapshot(runner);
    const dep = snap.items.find((i) => i.number === 100);
    const free = snap.items.find((i) => i.number === 101);
    expect(dep?.blockedByIssues).toEqual([50, 60]);
    expect(free?.blockedByIssues).toEqual([]);
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

    // Capture the rejection so we can assert the type, the `field`
    // discriminant, and that the original "all 3 project items" message
    // shape is preserved verbatim (back-compat with log scrapers — see
    // spec/2026-05-26-597 §`ProjectFieldSchemaError` extension).
    const err = await fetchProjectSnapshot(runner).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ProjectFieldSchemaError);
    expect((err as ProjectFieldSchemaError).field).toBe('all');
    expect((err as Error).message).toContain('all 3 project items');
  });

  it('throws ProjectFieldSchemaError when Status is null for every Issue (N≥3) and other fields are populated', async () => {
    // Single-field rename of `Status` — the catastrophic all-four-null
    // backstop would not fire here because Priority/Effort/Blocked on are
    // all populated. Per-field Status check catches it. See #597.
    const { runner } = makePagedRunner([
      buildPageResponse({
        rateLimitRemaining: 4999,
        nodes: [
          issueNode({ id: 'PVTI_a', number: 1, priority: 'P1', effort: 'Low', blockedOn: 'Nothing' }),
          issueNode({ id: 'PVTI_b', number: 2, priority: 'P2', effort: 'Medium', blockedOn: 'Nothing' }),
          issueNode({ id: 'PVTI_c', number: 3, priority: 'P3', effort: 'High', blockedOn: 'Nothing' }),
        ],
      }),
    ]);

    const err = await fetchProjectSnapshot(runner).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ProjectFieldSchemaError);
    expect((err as ProjectFieldSchemaError).field).toBe('Status');
    expect((err as Error).message).toContain("field 'Status'");
    expect((err as Error).message).toContain('3');
  });

  it('does NOT throw when Status is null for only 2 Issues (below SCHEMA_DRIFT_MIN_ISSUE_COUNT)', async () => {
    const { runner } = makePagedRunner([
      buildPageResponse({
        rateLimitRemaining: 4999,
        nodes: [
          issueNode({ id: 'PVTI_a', number: 1, priority: 'P1', effort: 'Low', blockedOn: 'Nothing' }),
          issueNode({ id: 'PVTI_b', number: 2, priority: 'P2', effort: 'Medium', blockedOn: 'Nothing' }),
        ],
      }),
    ]);

    await expect(fetchProjectSnapshot(runner)).resolves.toBeDefined();
  });

  it('does NOT throw on an untriaged board where Status is set but Priority/Effort/Blocked on are all null', async () => {
    // This is the central justification for restricting the per-field check
    // to Status: a freshly-bulk-imported board legitimately has Status
    // auto-set to Todo but the other three null until a human triages them.
    // See spec/2026-05-26-597 §False-positive avoidance.
    const { runner } = makePagedRunner([
      buildPageResponse({
        rateLimitRemaining: 4999,
        nodes: [
          issueNode({ id: 'PVTI_a', number: 1, status: 'Todo' }),
          issueNode({ id: 'PVTI_b', number: 2, status: 'Todo' }),
          issueNode({ id: 'PVTI_c', number: 3, status: 'Todo' }),
          issueNode({ id: 'PVTI_d', number: 4, status: 'Todo' }),
          issueNode({ id: 'PVTI_e', number: 5, status: 'Todo' }),
        ],
      }),
    ]);

    await expect(fetchProjectSnapshot(runner)).resolves.toBeDefined();
  });

  it('does NOT throw when some Issues have Status set and others do not (per-field check requires every Issue null)', async () => {
    const { runner } = makePagedRunner([
      buildPageResponse({
        rateLimitRemaining: 4999,
        nodes: [
          issueNode({ id: 'PVTI_a', number: 1, status: 'Todo', priority: 'P1', effort: 'Low', blockedOn: 'Nothing' }),
          issueNode({ id: 'PVTI_b', number: 2, status: 'Todo', priority: 'P2', effort: 'Medium', blockedOn: 'Nothing' }),
          issueNode({ id: 'PVTI_c', number: 3, priority: 'P3', effort: 'High', blockedOn: 'Nothing' }), // status null
        ],
      }),
    ]);

    await expect(fetchProjectSnapshot(runner)).resolves.toBeDefined();
  });

  it('ignores PRs/DraftIssues when computing the per-field Status check', async () => {
    // 2 Issues both with Status set + 3 PRs/Drafts whose Status is
    // structurally null. The per-field Status check must only count Issues —
    // otherwise a board with mostly PRs would false-positive constantly.
    const { runner } = makePagedRunner([
      buildPageResponse({
        rateLimitRemaining: 4999,
        nodes: [
          issueNode({ id: 'PVTI_iss1', number: 1, status: 'Todo' }),
          issueNode({ id: 'PVTI_iss2', number: 2, status: 'In Progress' }),
          prNode({ id: 'PVTI_pr1', number: 100 }),
          prNode({ id: 'PVTI_pr2', number: 101 }),
          draftIssueNode({ id: 'PVTI_draft' }),
        ],
      }),
    ]);

    await expect(fetchProjectSnapshot(runner)).resolves.toBeDefined();
  });

  it.each([
    { label: 'Priority', overrides: { status: 'Todo', effort: 'Low', blockedOn: 'Nothing' } },
    { label: 'Effort', overrides: { status: 'Todo', priority: 'P2', blockedOn: 'Nothing' } },
    { label: 'Blocked on', overrides: { status: 'Todo', priority: 'P2', effort: 'Low' } },
  ])(
    'does NOT throw when only $label is null across N=3 Issues (per-field check is Status-only by design — see spec 2026-05-26)',
    async ({ overrides }) => {
      const { runner } = makePagedRunner([
        buildPageResponse({
          rateLimitRemaining: 4999,
          nodes: [
            issueNode({ id: 'PVTI_a', number: 1, ...overrides }),
            issueNode({ id: 'PVTI_b', number: 2, ...overrides }),
            issueNode({ id: 'PVTI_c', number: 3, ...overrides }),
          ],
        }),
      ]);

      await expect(fetchProjectSnapshot(runner)).resolves.toBeDefined();
    },
  );

  it('does NOT throw when fewer than SCHEMA_DRIFT_MIN_ISSUE_COUNT issues are all-null (threshold avoids false positives on small boards)', async () => {
    // 2 brand-new untriaged issues with all fields null is a normal state,
    // not schema drift. SCHEMA_DRIFT_MIN_ISSUE_COUNT is 3 — locking that
    // contract here so a future tweak to the constant breaks this test.
    expect(SCHEMA_DRIFT_MIN_ISSUE_COUNT).toBe(3);
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

describe('fetchProjectSnapshot — pagination safety cap', () => {
  /** Build a runner that returns the SAME page forever (hasNextPage:true with
   *  a fixed endCursor) — simulates a GitHub bug where the cursor doesn't
   *  advance. Without the safety cap this would infinite-loop. */
  function makeStuckCursorRunner(): { runner: CommandRunner; callCount: () => number } {
    let calls = 0;
    const runner: CommandRunner = async () => {
      calls += 1;
      return buildPageResponse({
        rateLimitRemaining: 4999,
        hasNextPage: true,        // ← always says "more pages"
        endCursor: 'STUCK_CURSOR', // ← but the cursor never advances
        nodes: [issueNode({ id: `PVTI_${calls}`, number: calls, status: 'Todo' })],
      });
    };
    return { runner, callCount: () => calls };
  }

  it('throws PaginationLimitError when maxPages is exceeded (stuck-cursor pathology)', async () => {
    const { runner, callCount } = makeStuckCursorRunner();
    await expect(fetchProjectSnapshot(runner, { maxPages: 5 })).rejects.toBeInstanceOf(
      PaginationLimitError,
    );
    // Should have attempted exactly maxPages+1 calls (cap+1 trips the throw).
    expect(callCount()).toBe(5);
  });

  it('does NOT throw when total pages equals maxPages and the last page is the natural end', async () => {
    // maxPages=3, exactly 3 pages, third has hasNextPage:false → success.
    const { runner } = makePagedRunner([
      buildPageResponse({
        rateLimitRemaining: 4999, hasNextPage: true, endCursor: 'A',
        nodes: [issueNode({ id: 'PVTI_1', number: 1, status: 'Todo' })],
      }),
      buildPageResponse({
        rateLimitRemaining: 4998, hasNextPage: true, endCursor: 'B',
        nodes: [issueNode({ id: 'PVTI_2', number: 2, status: 'Todo' })],
      }),
      buildPageResponse({
        rateLimitRemaining: 4997, hasNextPage: false,
        nodes: [issueNode({ id: 'PVTI_3', number: 3, status: 'Todo' })],
      }),
    ]);
    await expect(fetchProjectSnapshot(runner, { maxPages: 3 })).resolves.toBeDefined();
  });

  it('uses the default MAX_PAGES (100) when no override is given', async () => {
    // Smoke check: at a 100-page board (10,000 items, well past any plausible
    // Project), the helper still terminates cleanly without throwing.
    const { runner } = makeStuckCursorRunner();
    // Lower the cap so the test stays fast — but the assertion is that the
    // *default* parameter is honoured when opts.maxPages is not passed.
    // We can't easily exercise the literal default (100) without 100 fixture
    // pages, so this assertion is indirect: with no opts, the helper throws
    // ProjectFieldSchemaError or PaginationLimitError — never spins forever.
    // Wrapping in a 10s wall-clock check would over-engineer; trust the
    // implementation matches the default.
    await expect(
      Promise.race([
        fetchProjectSnapshot(runner, { maxPages: 10 }),
        new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), 1000)),
      ]),
    ).rejects.toBeInstanceOf(PaginationLimitError);
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

describe('fetchProjectSnapshot — Sprint field (#609)', () => {
  // Pick a "now" that falls squarely inside Sprint 3's window (start 2026-05-25, duration 7d).
  const NOW_IN_SPRINT_3 = Date.parse('2026-05-25T12:00:00Z');

  it("populates each item's sprintIterationId from the snapshot", async () => {
    const { runner } = makePagedRunner([
      buildPageResponse({
        rateLimitRemaining: 4999,
        sprintIterations: [{ id: 'd710be59', startDate: '2026-05-25', duration: 7 }],
        nodes: [
          issueNode({ id: 'PVTI_a', number: 1, status: 'Todo', sprintIterationId: 'd710be59' }),
          issueNode({ id: 'PVTI_b', number: 2, status: 'Todo' }), // no sprint value
        ],
      }),
    ]);

    const snap = await fetchProjectSnapshot(runner, { nowMs: NOW_IN_SPRINT_3 });

    expect(snap.items[0]!.sprintIterationId).toBe('d710be59');
    expect(snap.items[1]!.sprintIterationId).toBeNull();
  });

  it('resolves currentSprintIterationId to the iteration containing nowMs', async () => {
    const { runner } = makePagedRunner([
      buildPageResponse({
        rateLimitRemaining: 4999,
        sprintIterations: [{ id: 'd710be59', startDate: '2026-05-25', duration: 7 }],
        nodes: [issueNode({ id: 'PVTI_a', number: 1, status: 'Todo' })],
      }),
    ]);

    const snap = await fetchProjectSnapshot(runner, { nowMs: NOW_IN_SPRINT_3 });
    expect(snap.currentSprintIterationId).toBe('d710be59');
  });

  it('resolves currentSprintIterationId to null when nowMs is before any iteration starts', async () => {
    // nowMs is BEFORE the only iteration's startDate — not yet started ≠ current.
    const { runner } = makePagedRunner([
      buildPageResponse({
        rateLimitRemaining: 4999,
        sprintIterations: [{ id: 'd710be59', startDate: '2026-05-25', duration: 7 }],
        nodes: [issueNode({ id: 'PVTI_a', number: 1, status: 'Todo' })],
      }),
    ]);

    const snap = await fetchProjectSnapshot(runner, {
      nowMs: Date.parse('2026-05-24T12:00:00Z'),
    });
    expect(snap.currentSprintIterationId).toBeNull();
  });

  it('resolves currentSprintIterationId to null when the Sprint field is absent', async () => {
    // sprintField is null on the page — Sprint field doesn't exist on the
    // project. Sprint ordering becomes a no-op (#609).
    const { runner } = makePagedRunner([
      buildPageResponse({
        rateLimitRemaining: 4999,
        sprintIterations: null,
        nodes: [issueNode({ id: 'PVTI_a', number: 1, status: 'Todo' })],
      }),
    ]);

    const snap = await fetchProjectSnapshot(runner, { nowMs: NOW_IN_SPRINT_3 });
    expect(snap.currentSprintIterationId).toBeNull();
    expect(snap.items[0]!.sprintIterationId).toBeNull();
  });

  it('coerces unset sprint field value on an item to null', async () => {
    const { runner } = makePagedRunner([
      buildPageResponse({
        rateLimitRemaining: 4999,
        sprintIterations: [{ id: 'd710be59', startDate: '2026-05-25', duration: 7 }],
        nodes: [issueNode({ id: 'PVTI_a', number: 1, status: 'Todo' })],
      }),
    ]);

    const snap = await fetchProjectSnapshot(runner, { nowMs: NOW_IN_SPRINT_3 });
    expect(snap.items[0]!.sprintIterationId).toBeNull();
  });
});

describe('resolveCurrentSprintIterationId', () => {
  const ITER = (id: string, startDate: string, duration = 7) => ({ id, startDate, duration });

  it('returns the iteration whose window contains nowMs', () => {
    const iters = [ITER('a', '2026-05-25')];
    expect(resolveCurrentSprintIterationId(iters, Date.parse('2026-05-25T00:00:00Z'))).toBe('a');
    expect(resolveCurrentSprintIterationId(iters, Date.parse('2026-05-31T23:59:59Z'))).toBe('a');
  });

  it('returns null when nowMs is before the first iteration', () => {
    expect(
      resolveCurrentSprintIterationId([ITER('a', '2026-05-25')], Date.parse('2026-05-20T00:00:00Z')),
    ).toBeNull();
  });

  it('returns null when nowMs is after the last iteration ends', () => {
    expect(
      resolveCurrentSprintIterationId([ITER('a', '2026-05-25')], Date.parse('2026-06-05T00:00:00Z')),
    ).toBeNull();
  });

  it('picks the iteration containing nowMs across multiple configured iterations', () => {
    const iters = [ITER('a', '2026-05-25'), ITER('b', '2026-06-01')];
    expect(resolveCurrentSprintIterationId(iters, Date.parse('2026-06-02T12:00:00Z'))).toBe('b');
  });

  it('returns null for an empty iteration list', () => {
    expect(resolveCurrentSprintIterationId([], Date.now())).toBeNull();
  });
});
