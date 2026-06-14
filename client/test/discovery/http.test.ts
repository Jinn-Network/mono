/**
 * Tests for HttpDiscoveryAPI — the GraphQL→DiscoveryAPI adapter backed by a
 * Ponder indexer endpoint.
 *
 * Tests:
 *   - Each of the four DiscoveryAPI methods builds the correct GraphQL query
 *     (mock fetchImpl, assert request shape)
 *   - Each method correctly parses a representative response
 *   - GraphQL errors[] in response throws DiscoveryUnavailableError
 *   - Network failure throws DiscoveryUnavailableError
 *
 * The Ponder indexer itself is NOT run in tests — the adapter is the
 * testable seam. Tests mock globalThis.fetch with a stub fetchImpl.
 *
 * Moved from packages/indexer/test/discovery-adapter.test.ts as part of
 * jinn-mono-280n.4 (HttpDiscoveryAPI in client/, indexer becomes server-side
 * only).
 */
import { describe, it, expect, vi } from 'vitest';
import { createHttpDiscoveryAPI } from '../../src/discovery/http.js';
import { DiscoveryUnavailableError } from '../../src/discovery/types.js';

// ── Test helpers ──────────────────────────────────────────────────────────────

/** True for the host-root `/ready` readiness probe HttpDiscoveryAPI issues. */
function isReadyProbe(url: string): boolean {
  return url.endsWith('/ready');
}

/**
 * Build a mock fetchImpl that returns the given JSON body and HTTP status for
 * GraphQL POSTs, and a 200 for the `/ready` readiness probe (so the GraphQL
 * path under test is reached). Captures GraphQL request details for assertion;
 * `/ready` probes are not recorded.
 */
function mockFetch(body: unknown, status = 200) {
  const calls: { url: string; body: unknown }[] = [];
  const impl = vi.fn(async (url: string, init?: RequestInit) => {
    if (isReadyProbe(url)) {
      return new Response(null, { status: 200 });
    }
    calls.push({ url, body: JSON.parse(init?.body as string) });
    return new Response(JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json' },
    });
  });
  return { impl, calls };
}

/**
 * Build a mock fetchImpl that returns a non-200 for the `/ready` probe — the
 * indexer is up but still cold-syncing. Every DiscoveryAPI method should turn
 * this into a DiscoveryUnavailableError before issuing any GraphQL query.
 */
function notReadyFetch(status = 503) {
  const graphqlCalls: string[] = [];
  const impl = vi.fn(async (url: string, _init?: RequestInit) => {
    if (isReadyProbe(url)) {
      return new Response(null, { status });
    }
    graphqlCalls.push(url);
    return new Response(JSON.stringify({ data: {} }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  });
  return { impl, graphqlCalls };
}

/**
 * Build a mock fetchImpl that throws a network error.
 */
function networkErrorFetch() {
  return vi.fn(async (_url: string, _init?: RequestInit) => {
    throw new TypeError('fetch failed: connection refused');
  });
}

const BASE_URL = 'http://localhost:42069';

// ── findClaimableTasks ────────────────────────────────────────────────────────

describe('findClaimableTasks', () => {
  it('returns empty array when no manifest CIDs provided', async () => {
    const { impl } = mockFetch({ data: { tasks: { items: [], pageInfo: { hasNextPage: false } } } });
    const client = createHttpDiscoveryAPI({ url: BASE_URL, fetchImpl: impl as unknown as typeof fetch });
    const result = await client.findClaimableTasks({
      solverNetManifestCids: [],
      operatorAddress: '0xdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef',
    });
    expect(result).toEqual([]);
    // No fetch calls when no CIDs.
    expect(impl).not.toHaveBeenCalled();
  });

  it('posts a GraphQL query to /graphql and passes manifestDigest', async () => {
    // First call: tasks page query. Second call: batched attempts query for the
    // page of tasks (ATTEMPTS_FOR_TASKS_QUERY — one round-trip per page, not
    // one per task). The attempt item must include `taskId` so the client-side
    // grouping can attribute the count to the correct task.
    const tasksResponse = {
      data: {
        tasks: {
          items: [
            {
              id: '1',
              taskCidDigest: '0x' + 'ab'.repeat(32),
              manifestDigest: '0x' + 'cd'.repeat(32),
              createdAtBlock: '1000',
              createdAtTx: '0x' + 'ef'.repeat(32),
              claimWindowEnd: '9999999999',
              maxClaims: 5,
              chainId: 84532,
            },
          ],
          pageInfo: { hasNextPage: false },
        },
      },
    };
    const attemptsResponse = {
      data: {
        attempts: {
          items: [
            // taskId field is required by ATTEMPTS_FOR_TASKS_QUERY (batched form).
            { taskId: '1', operator: '0x1111111111111111111111111111111111111111', attemptIndex: 0 },
          ],
        },
      },
    };

    const callCount = { n: 0 };
    const impl = vi.fn(async (url: string, init?: RequestInit) => {
      if (isReadyProbe(url)) return new Response(null, { status: 200 });
      callCount.n++;
      const body = JSON.parse(init?.body as string) as { query: string };
      // Discriminate by query name: 'query Tasks(' is the tasks page query;
      // 'query AttemptsForTasks(' is the batched attempts query. Use exact
      // prefix match to avoid 'AttemptsForTasks' matching 'Tasks('.
      if (body.query.includes('query Tasks(')) {
        return new Response(JSON.stringify(tasksResponse), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      return new Response(JSON.stringify(attemptsResponse), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    });

    const client = createHttpDiscoveryAPI({ url: BASE_URL, fetchImpl: impl as unknown as typeof fetch });
    const result = await client.findClaimableTasks({
      solverNetManifestCids: ['bafyreiabc123'],
      operatorAddress: '0x2222222222222222222222222222222222222222',
    });

    // Should have called fetch at least twice (tasks + attempts), not counting
    // the /ready probe.
    expect(callCount.n).toBeGreaterThanOrEqual(2);

    // GraphQL calls go to /graphql via POST. (calls[0] is the /ready GET.)
    const gqlCall = impl.mock.calls.find(([u]) => (u as string).endsWith('/graphql')) as [string, RequestInit];
    expect(gqlCall[0]).toBe(`${BASE_URL}/graphql`);
    expect(gqlCall[1].method).toBe('POST');

    // Result should have one candidate.
    expect(result).toHaveLength(1);
    expect(result[0].taskId).toBe('1');
    expect(result[0].attemptCount).toBe(1);
    expect(result[0].operatorAttemptCount).toBe(0); // operator doesn't match
    expect(result[0].claimWindowEnd).toBe(9999999999);
  });

  it('filters out tasks where operator has already attempted', async () => {
    const OPERATOR = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
    const tasksResponse = {
      data: {
        tasks: {
          items: [
            {
              id: '2',
              taskCidDigest: '0x' + 'ab'.repeat(32),
              manifestDigest: '0x' + 'cd'.repeat(32),
              maxClaims: 3,
              chainId: 84532,
            },
          ],
          pageInfo: { hasNextPage: false },
        },
      },
    };
    const attemptsResponse = {
      data: {
        attempts: {
          items: [
            // taskId field is required by the batched ATTEMPTS_FOR_TASKS_QUERY.
            { taskId: '2', operator: OPERATOR, attemptIndex: 0 },
          ],
        },
      },
    };

    const impl = vi.fn(async (url: string, init?: RequestInit) => {
      if (isReadyProbe(url)) return new Response(null, { status: 200 });
      const body = JSON.parse(init?.body as string) as { query: string };
      if (body.query.includes('query Tasks(')) {
        return new Response(JSON.stringify(tasksResponse), { status: 200, headers: { 'content-type': 'application/json' } });
      }
      return new Response(JSON.stringify(attemptsResponse), { status: 200, headers: { 'content-type': 'application/json' } });
    });

    const client = createHttpDiscoveryAPI({ url: BASE_URL, fetchImpl: impl as unknown as typeof fetch });
    const result = await client.findClaimableTasks({
      solverNetManifestCids: ['bafyreiabc123'],
      operatorAddress: OPERATOR as `0x${string}`,
    });

    // operatorAttemptCount = 1, so task is still returned (filtering is done
    // at claim time by canClaimTask, not here). The adapter reports counts.
    expect(result).toHaveLength(1);
    expect(result[0].operatorAttemptCount).toBe(1);
  });

  it('uses a single batched attempts query per page (not one per task)', async () => {
    // Important 4 regression: ATTEMPTS_FOR_TASKS_QUERY must send taskId_in with
    // all task IDs from the page in one round-trip, not one query per task.
    const tasksResponse = {
      data: {
        tasks: {
          items: [
            { id: '10', taskCidDigest: '0x' + 'ab'.repeat(32), manifestDigest: '0x' + 'cd'.repeat(32), chainId: 84532 },
            { id: '11', taskCidDigest: '0x' + 'ab'.repeat(32), manifestDigest: '0x' + 'cd'.repeat(32), chainId: 84532 },
          ],
          pageInfo: { hasNextPage: false },
        },
      },
    };
    const attemptsResponse = {
      data: {
        attempts: {
          items: [
            { taskId: '10', operator: '0x1111111111111111111111111111111111111111', attemptIndex: 0 },
            { taskId: '11', operator: '0x2222222222222222222222222222222222222222', attemptIndex: 0 },
          ],
        },
      },
    };

    const fetchCalls: { query: string; variables: unknown }[] = [];
    const impl = vi.fn(async (url: string, init?: RequestInit) => {
      if (isReadyProbe(url)) return new Response(null, { status: 200 });
      const body = JSON.parse(init?.body as string) as { query: string; variables: unknown };
      fetchCalls.push({ query: body.query, variables: body.variables });
      if (body.query.includes('query Tasks(')) {
        return new Response(JSON.stringify(tasksResponse), { status: 200, headers: { 'content-type': 'application/json' } });
      }
      return new Response(JSON.stringify(attemptsResponse), { status: 200, headers: { 'content-type': 'application/json' } });
    });

    const client = createHttpDiscoveryAPI({ url: BASE_URL, fetchImpl: impl as unknown as typeof fetch });
    const result = await client.findClaimableTasks({
      solverNetManifestCids: ['bafyreiabc123'],
      operatorAddress: '0x3333333333333333333333333333333333333333',
    });

    // Exactly 2 fetch calls: 1 tasks page + 1 batched attempts query (not 3 = 1 + 2 per task).
    expect(fetchCalls).toHaveLength(2);

    // The second call should be the batched attempts query with taskId_in.
    const attemptsCall = fetchCalls[1] as { query: string; variables: { taskIds: string[] } };
    expect(attemptsCall.query).toContain('AttemptsForTasks(');
    expect(attemptsCall.variables.taskIds).toEqual(expect.arrayContaining(['10', '11']));
    expect(attemptsCall.variables.taskIds).toHaveLength(2);

    // Both tasks should be returned with correct counts.
    expect(result).toHaveLength(2);
    const task10 = result.find((r) => r.taskId === '10');
    const task11 = result.find((r) => r.taskId === '11');
    expect(task10?.attemptCount).toBe(1);
    expect(task11?.attemptCount).toBe(1);
  });

  it('paginates the batched attempts query across multiple pages (limit ≤ 1000)', async () => {
    // Ponder caps plural-query `limit` at 1000, so the attempts fetch must
    // paginate with the `after` cursor rather than asking for one giant page.
    const tasksResponse = {
      data: {
        tasks: {
          items: [
            { id: '20', taskCidDigest: '0x' + 'ab'.repeat(32), manifestDigest: '0x' + 'cd'.repeat(32), maxClaims: 0, chainId: 84532 },
          ],
          pageInfo: { hasNextPage: false },
        },
      },
    };
    // Two pages of attempts for the same task; counts must sum across pages.
    const attemptsPage1 = {
      data: {
        attempts: {
          items: [
            { taskId: '20', operator: '0x1111111111111111111111111111111111111111', attemptIndex: 0 },
            { taskId: '20', operator: '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', attemptIndex: 1 },
          ],
          pageInfo: { hasNextPage: true, endCursor: 'CURSOR_1' },
        },
      },
    };
    const attemptsPage2 = {
      data: {
        attempts: {
          items: [
            { taskId: '20', operator: '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', attemptIndex: 2 },
          ],
          pageInfo: { hasNextPage: false, endCursor: null },
        },
      },
    };

    const attemptsQueries: Array<{ limit: number; after: string | null }> = [];
    const impl = vi.fn(async (url: string, init?: RequestInit) => {
      if (isReadyProbe(url)) return new Response(null, { status: 200 });
      const body = JSON.parse(init?.body as string) as { query: string; variables: { limit?: number; after?: string | null } };
      if (body.query.includes('query Tasks(')) {
        return new Response(JSON.stringify(tasksResponse), { status: 200, headers: { 'content-type': 'application/json' } });
      }
      // ATTEMPTS_FOR_TASKS_QUERY
      attemptsQueries.push({ limit: body.variables.limit ?? 0, after: body.variables.after ?? null });
      const page = body.variables.after === 'CURSOR_1' ? attemptsPage2 : attemptsPage1;
      return new Response(JSON.stringify(page), { status: 200, headers: { 'content-type': 'application/json' } });
    });

    const client = createHttpDiscoveryAPI({ url: BASE_URL, fetchImpl: impl as unknown as typeof fetch });
    const result = await client.findClaimableTasks({
      solverNetManifestCids: ['bafyreiabc123'],
      operatorAddress: '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    });

    // Two attempts-query round-trips: first with no cursor, second with the page-1 endCursor.
    expect(attemptsQueries).toHaveLength(2);
    expect(attemptsQueries[0]).toEqual({ limit: 1000, after: null });
    expect(attemptsQueries[1]).toEqual({ limit: 1000, after: 'CURSOR_1' });

    // Counts must include attempts from both pages.
    expect(result).toHaveLength(1);
    expect(result[0].taskId).toBe('20');
    expect(result[0].attemptCount).toBe(3);
    expect(result[0].operatorAttemptCount).toBe(2);
  });

  it('propagates a DiscoveryUnavailableError from the attempts query (not swallowed)', async () => {
    // A genuine failure in the batched attempts fetch must surface so
    // withFallback can engage the on-chain floor — not be swallowed into
    // wrong-but-plausible zero counts.
    const tasksResponse = {
      data: {
        tasks: {
          items: [
            { id: '30', taskCidDigest: '0x' + 'ab'.repeat(32), manifestDigest: '0x' + 'cd'.repeat(32), chainId: 84532 },
          ],
          pageInfo: { hasNextPage: false },
        },
      },
    };
    const impl = vi.fn(async (url: string, init?: RequestInit) => {
      if (isReadyProbe(url)) return new Response(null, { status: 200 });
      const body = JSON.parse(init?.body as string) as { query: string };
      if (body.query.includes('query Tasks(')) {
        return new Response(JSON.stringify(tasksResponse), { status: 200, headers: { 'content-type': 'application/json' } });
      }
      // Attempts query errors out.
      return new Response(JSON.stringify({ errors: [{ message: 'limit exceeds maximum' }] }), {
        status: 200, headers: { 'content-type': 'application/json' },
      });
    });

    const client = createHttpDiscoveryAPI({ url: BASE_URL, fetchImpl: impl as unknown as typeof fetch });
    await expect(
      client.findClaimableTasks({
        solverNetManifestCids: ['bafyreiabc123'],
        operatorAddress: '0x1234567890123456789012345678901234567890',
      }),
    ).rejects.toThrow(DiscoveryUnavailableError);
  });

  it('throws DiscoveryUnavailableError on GraphQL errors', async () => {
    const { impl } = mockFetch({
      errors: [{ message: 'internal server error' }],
    });
    const client = createHttpDiscoveryAPI({ url: BASE_URL, fetchImpl: impl as unknown as typeof fetch });
    await expect(
      client.findClaimableTasks({
        solverNetManifestCids: ['bafyreiabc123'],
        operatorAddress: '0x1234567890123456789012345678901234567890',
      }),
    ).rejects.toThrow(DiscoveryUnavailableError);
  });

  it('throws DiscoveryUnavailableError on network failure', async () => {
    const client = createHttpDiscoveryAPI({
      url: BASE_URL,
      fetchImpl: networkErrorFetch() as unknown as typeof fetch,
    });
    await expect(
      client.findClaimableTasks({
        solverNetManifestCids: ['bafyreiabc123'],
        operatorAddress: '0x1234567890123456789012345678901234567890',
      }),
    ).rejects.toThrow(DiscoveryUnavailableError);
  });

  it('throws DiscoveryUnavailableError on HTTP 5xx', async () => {
    const { impl } = mockFetch('Internal Server Error', 500);
    const client = createHttpDiscoveryAPI({ url: BASE_URL, fetchImpl: impl as unknown as typeof fetch });
    await expect(
      client.findClaimableTasks({
        solverNetManifestCids: ['bafyreiabc123'],
        operatorAddress: '0x1234567890123456789012345678901234567890',
      }),
    ).rejects.toThrow(DiscoveryUnavailableError);
  });

  it('round-robin interleaves candidates across joined SolverNets (no starvation)', async () => {
    // Regression for the task-discovery starvation bug verified live on task 210
    // (op-b, release/v2026.05.25). When an operator joins two SolverNets — one
    // with a large unfinalized backlog (low task IDs), one with a single
    // higher-id task — a global ASC-by-taskId sort across CIDs lets the
    // backlogged SolverNet monopolise the per-tick yield in
    // discoverSubgraphRestorationTasks (which yields one announcement per
    // poll cycle, see adapter.ts ~line 721). Effect: 12 cycles of claiming
    // backlog tasks before the lone sibling task is even considered.
    //
    // Fix: per-CID buckets + round-robin interleave. The lone B task must
    // appear in slot index 1 (the second slot of the very first round),
    // not pushed to the end behind every A backlog task.
    const CID_A = 'bafyreichdzbacklog'; // hot SolverNet — 12 backlogged low-id tasks
    const CID_B = 'bafyreievikisolated'; // quiet SolverNet — one higher-id task

    // We need keccak256 of each CID's bytes to discriminate the GraphQL
    // requests by `manifestDigest` (HttpDiscoveryAPI computes this client-side).
    const { keccak256, toBytes } = await import('viem');
    const digestA = keccak256(toBytes(CID_A));
    const digestB = keccak256(toBytes(CID_B));

    // CID A: 12 low-id backlog tasks (170 .. 181), all claimable.
    const backlogIds = ['170', '171', '172', '173', '174', '175', '176', '177', '178', '179', '180', '181'];
    const tasksResponseA = {
      data: {
        tasks: {
          items: backlogIds.map((id) => ({
            id,
            taskCidDigest: '0x' + 'ab'.repeat(32),
            manifestDigest: digestA,
            chainId: 84532,
          })),
          pageInfo: { hasNextPage: false },
        },
      },
    };

    // CID B: one high-id task (210), claimable.
    const tasksResponseB = {
      data: {
        tasks: {
          items: [
            {
              id: '210',
              taskCidDigest: '0x' + 'cd'.repeat(32),
              manifestDigest: digestB,
              chainId: 84532,
            },
          ],
          pageInfo: { hasNextPage: false },
        },
      },
    };

    // No prior attempts on either side.
    const emptyAttemptsResponse = {
      data: { attempts: { items: [], pageInfo: { hasNextPage: false, endCursor: null } } },
    };

    const impl = vi.fn(async (url: string, init?: RequestInit) => {
      if (isReadyProbe(url)) return new Response(null, { status: 200 });
      const body = JSON.parse(init?.body as string) as {
        query: string;
        variables: { manifestDigest?: string };
      };
      if (body.query.includes('query Tasks(')) {
        // Discriminate per-CID by the manifestDigest variable.
        const resp = body.variables.manifestDigest === digestA ? tasksResponseA : tasksResponseB;
        return new Response(JSON.stringify(resp), {
          status: 200, headers: { 'content-type': 'application/json' },
        });
      }
      return new Response(JSON.stringify(emptyAttemptsResponse), {
        status: 200, headers: { 'content-type': 'application/json' },
      });
    });

    const client = createHttpDiscoveryAPI({ url: BASE_URL, fetchImpl: impl as unknown as typeof fetch });
    const result = await client.findClaimableTasks({
      solverNetManifestCids: [CID_A, CID_B],
      operatorAddress: '0x3333333333333333333333333333333333333333',
    });

    // Sanity: all 13 candidates present.
    expect(result).toHaveLength(13);

    // Core fairness invariant: CID B's only task (210) must NOT be at the
    // bottom of a global ASC-by-taskId list. With the bug it would be at
    // index 12 (after every backlog task). With round-robin it appears
    // immediately after CID A's first contribution.
    const indexOf210 = result.findIndex((c) => c.taskId === '210');
    expect(indexOf210).toBe(1);

    // Stronger pin: the round-robin order is [A0, B0, A1, A2, ...] when one
    // bucket is exhausted, so the consumer (the daemon's per-tick yield in
    // discoverSubgraphRestorationTasks) reaches CID B within the first
    // round-trip, not 12 cycles later.
    expect(result[0].taskId).toBe('170');
    expect(result[1].taskId).toBe('210');
    expect(result[2].taskId).toBe('171');
  });

  it('sorts per-CID bucket by taskId ASC using BigInt (uint256-safe above MAX_SAFE_INTEGER)', async () => {
    const MAX = Number.MAX_SAFE_INTEGER;
    const taskIds = [
      String(MAX + 1),
      '1',
      String((1n << 54n)),
      String(MAX - 1),
      String(MAX),
    ];

    const tasksResponse = {
      data: {
        tasks: {
          items: taskIds.map((id) => ({
            id,
            taskCidDigest: '0x' + 'ab'.repeat(32),
            manifestDigest: '0x' + 'cd'.repeat(32),
            chainId: 84532,
          })),
          pageInfo: { hasNextPage: false },
        },
      },
    };
    const emptyAttemptsResponse = {
      data: { attempts: { items: [], pageInfo: { hasNextPage: false, endCursor: null } } },
    };

    const impl = vi.fn(async (url: string, init?: RequestInit) => {
      if (isReadyProbe(url)) return new Response(null, { status: 200 });
      const body = JSON.parse(init?.body as string) as { query: string };
      if (body.query.includes('query Tasks(')) {
        return new Response(JSON.stringify(tasksResponse), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      return new Response(JSON.stringify(emptyAttemptsResponse), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    });

    const client = createHttpDiscoveryAPI({ url: BASE_URL, fetchImpl: impl as unknown as typeof fetch });
    const result = await client.findClaimableTasks({
      solverNetManifestCids: ['bafyreiabc123'],
      operatorAddress: '0x3333333333333333333333333333333333333333',
    });

    expect(result.map((c) => c.taskId)).toEqual([
      '1',
      String(MAX - 1),
      String(MAX),
      String(MAX + 1),
      String(1n << 54n),
    ]);
  });
});

// ── listLaunchedSolverNets ────────────────────────────────────────────────────

describe('listLaunchedSolverNets', () => {
  it('returns solver net summaries from response', async () => {
    const { impl } = mockFetch({
      data: {
        solverNetManifests: {
          items: [
            {
              id: 'bafyreifoo',
              launcherAgentId: '42',
              status: 'launched',
              statusUpdatedAt: '2026-05-11T00:00:00Z',
              manifestHash: '0x' + 'ff'.repeat(32),
              anchorBlock: '12345',
              chainId: 84532,
            },
          ],
        },
      },
    });

    const client = createHttpDiscoveryAPI({ url: BASE_URL, fetchImpl: impl as unknown as typeof fetch });
    const result = await client.listLaunchedSolverNets();

    expect(result).toHaveLength(1);
    expect(result[0].manifestCid).toBe('bafyreifoo');
    expect(result[0].launcherAgentId).toBe('42');
    expect(result[0].status).toBe('launched');
    expect(result[0].anchorBlock).toBe(12345);
  });

  it('populates all 14 SolverNetManifestSummary fields with sentinels for IPFS-only fields', async () => {
    // Critical 3 regression: the indexer adapter must return all 14 fields of
    // SolverNetManifestSummary (not just the 6 on-chain fields). The 8 IPFS-only
    // fields are set to sentinel values so callers can detect and enrich them.
    const { impl } = mockFetch({
      data: {
        solverNetManifests: {
          items: [
            {
              id: 'bafyreisummary',
              launcherAgentId: '7',
              status: 'paused',
              statusUpdatedAt: '2026-05-11T01:00:00Z',
              manifestHash: '0x' + 'aa'.repeat(32),
              anchorBlock: '99',
              chainId: 8453,
            },
          ],
        },
      },
    });

    const client = createHttpDiscoveryAPI({ url: BASE_URL, fetchImpl: impl as unknown as typeof fetch });
    const result = await client.listLaunchedSolverNets();

    expect(result).toHaveLength(1);
    const row = result[0];

    // On-chain fields — must be populated from the GraphQL response.
    expect(row.manifestCid).toBe('bafyreisummary');
    expect(row.launcherAgentId).toBe('7');
    expect(row.status).toBe('paused');
    expect(row.statusUpdatedAt).toBe('2026-05-11T01:00:00Z');
    expect(row.anchorBlock).toBe(99);

    // IPFS-only fields — must be sentinel values (not undefined).
    expect(row.solverNetId).toBe('bafyreisummary'); // best-effort: cid as id
    expect(row.name).toBe('');
    expect(row.network).toBe('');
    expect(row.launcherSafeAddress).toBe('0x0000000000000000000000000000000000000000');
    expect(row.contractId).toBe('');
    expect(row.contractVersion).toBe('');
    expect(row.solutionPriceWei).toBe('0');
    expect(row.verdictPriceWei).toBe('0');
    expect(row.openRoles).toEqual([]);
  });

  it('filters by launcherAgentId when provided', async () => {
    const calls: unknown[] = [];
    const impl = vi.fn(async (url: string, init?: RequestInit) => {
      if (isReadyProbe(url)) return new Response(null, { status: 200 });
      calls.push(JSON.parse(init?.body as string));
      return new Response(
        JSON.stringify({ data: { solverNetManifests: { items: [] } } }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    });

    const client = createHttpDiscoveryAPI({ url: BASE_URL, fetchImpl: impl as unknown as typeof fetch });
    await client.listLaunchedSolverNets({ launcherAgentId: '99' });

    expect(calls).toHaveLength(1);
    const body = calls[0] as { variables: { where: { launcherAgentId?: string; status_in?: string[] } } };
    expect(body.variables.where.launcherAgentId).toBe('99');
  });

  it('omits status_in from where when no status filter given (avoids Ponder null-IN SQL error)', async () => {
    const calls: unknown[] = [];
    const impl = vi.fn(async (url: string, init?: RequestInit) => {
      if (isReadyProbe(url)) return new Response(null, { status: 200 });
      calls.push(JSON.parse(init?.body as string));
      return new Response(
        JSON.stringify({ data: { solverNetManifests: { items: [] } } }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    });

    const client = createHttpDiscoveryAPI({ url: BASE_URL, fetchImpl: impl as unknown as typeof fetch });
    await client.listLaunchedSolverNets();

    expect(calls).toHaveLength(1);
    const body = calls[0] as { variables: { where: Record<string, unknown> } };
    // No filters supplied → empty where object, not { status_in: null } or { launcherAgentId: null }.
    expect(body.variables.where).toEqual({});
  });

  it('throws DiscoveryUnavailableError on GraphQL errors', async () => {
    const { impl } = mockFetch({ errors: [{ message: 'timeout' }] });
    const client = createHttpDiscoveryAPI({ url: BASE_URL, fetchImpl: impl as unknown as typeof fetch });
    await expect(client.listLaunchedSolverNets()).rejects.toThrow(DiscoveryUnavailableError);
  });

  it('projects enriched fields when manifestEnrichmentStatus is "ok" (issue #985)', async () => {
    // A new indexer returns the row already enriched. The list path must
    // project the indexer fields verbatim — no IPFS round-trip.
    const { impl } = mockFetch({
      data: {
        solverNetManifests: {
          items: [
            {
              id: 'bafyenriched',
              launcherAgentId: '5474',
              status: 'launched',
              statusUpdatedAt: '2026-05-11T00:00:00Z',
              manifestHash: '0x' + 'ff'.repeat(32),
              anchorBlock: '12345',
              chainId: 84532,
              name: 'SWE-rebench v2',
              network: 'base-sepolia',
              solutionPriceWei: '1000000000000000',
              verdictPriceWei: '500000000000000',
              openRoles: ['solver', 'evaluator'],
              launcherSafeAddress: '0x' + 'ab'.repeat(20),
              contractId: 'swe-rebench-v2',
              contractVersion: 'v1',
              solverNetId: 'launcher/swe-rebench-v2',
              manifestEnrichmentStatus: 'ok',
            },
          ],
        },
      },
    });
    const client = createHttpDiscoveryAPI({ url: BASE_URL, fetchImpl: impl as unknown as typeof fetch });
    const rows = await client.listLaunchedSolverNets();
    expect(rows).toHaveLength(1);
    const row = rows[0];
    expect(row.name).toBe('SWE-rebench v2');
    expect(row.network).toBe('base-sepolia');
    expect(row.solutionPriceWei).toBe('1000000000000000');
    expect(row.verdictPriceWei).toBe('500000000000000');
    expect(row.openRoles).toEqual(['solver', 'evaluator']);
    expect(row.launcherSafeAddress).toBe('0x' + 'ab'.repeat(20));
    expect(row.contractId).toBe('swe-rebench-v2');
    expect(row.contractVersion).toBe('v1');
    expect(row.solverNetId).toBe('launcher/swe-rebench-v2');
    expect(row.chainId).toBe(84532);
  });

  it('keeps sentinels for a pending/failed enrichment row (does not present empty price as real)', async () => {
    // Enrichment has not landed: the indexer returns the row with the default
    // empty fields and status !== 'ok'. The guard must keep sentinels.
    const { impl } = mockFetch({
      data: {
        solverNetManifests: {
          items: [
            {
              id: 'bafypending',
              launcherAgentId: '5474',
              status: 'launched',
              statusUpdatedAt: '2026-05-11T00:00:00Z',
              manifestHash: '0x' + 'ff'.repeat(32),
              anchorBlock: '99',
              chainId: 84532,
              name: '',
              network: '',
              solutionPriceWei: '',
              verdictPriceWei: '',
              openRoles: [],
              launcherSafeAddress: '',
              contractId: '',
              contractVersion: '',
              solverNetId: '',
              manifestEnrichmentStatus: 'pending',
            },
          ],
        },
      },
    });
    const client = createHttpDiscoveryAPI({ url: BASE_URL, fetchImpl: impl as unknown as typeof fetch });
    const rows = await client.listLaunchedSolverNets();
    expect(rows).toHaveLength(1);
    const row = rows[0];
    expect(row.name).toBe('');
    expect(row.network).toBe('');
    expect(row.solutionPriceWei).toBe('0');
    expect(row.verdictPriceWei).toBe('0');
    expect(row.openRoles).toEqual([]);
    expect(row.launcherSafeAddress).toBe('0x0000000000000000000000000000000000000000');
    expect(row.solverNetId).toBe('bafypending'); // best-effort: cid as id
    expect(row.chainId).toBe(84532);
  });

  it('degrades to the legacy query against an old indexer (no enriched columns)', async () => {
    // An OLD indexer rejects the extended selection set with a GraphQL
    // validation error; the daemon must re-run the legacy query and project
    // sentinels rather than throw. Mirrors the getPluginScores degrade path.
    const graphqlQueries: string[] = [];
    const impl = vi.fn(async (url: string, init?: RequestInit) => {
      if (isReadyProbe(url)) return new Response(null, { status: 200 });
      const body = JSON.parse(init?.body as string) as { query: string };
      graphqlQueries.push(body.query);
      // First GraphQL POST: the extended selection set → validation error.
      if (graphqlQueries.length === 1) {
        return new Response(
          JSON.stringify({
            errors: [{ message: 'Cannot query field "openRoles" on type "solverNetManifest".' }],
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }
      // Second GraphQL POST: the legacy query → a valid page, no enriched cols.
      return new Response(
        JSON.stringify({
          data: {
            solverNetManifests: {
              items: [
                {
                  id: 'bafyold',
                  launcherAgentId: '5474',
                  status: 'launched',
                  statusUpdatedAt: '2026-05-06T00:00:00Z',
                  manifestHash: '0x' + 'ab'.repeat(32),
                  anchorBlock: 100,
                  chainId: 84532,
                },
              ],
            },
          },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    });

    const client = createHttpDiscoveryAPI({ url: BASE_URL, fetchImpl: impl as unknown as typeof fetch });
    const rows = await client.listLaunchedSolverNets();
    expect(rows).toHaveLength(1);
    expect(rows[0].chainId).toBe(84532);
    expect(rows[0].name).toBe('');            // sentinel — old indexer has no enriched field
    expect(rows[0].solutionPriceWei).toBe('0');
    expect(rows[0].openRoles).toEqual([]);
    // Proves the degrade re-query fired: two GraphQL POSTs, the second is the
    // legacy query (no openRoles in its selection set).
    expect(graphqlQueries).toHaveLength(2);
    expect(graphqlQueries[1]).not.toContain('openRoles');
  });

  it('throws DiscoveryUnavailableError on network failure', async () => {
    const client = createHttpDiscoveryAPI({
      url: BASE_URL,
      fetchImpl: networkErrorFetch() as unknown as typeof fetch,
    });
    await expect(client.listLaunchedSolverNets()).rejects.toThrow(DiscoveryUnavailableError);
  });
});

// ── getLifecycleStatus ────────────────────────────────────────────────────────

describe('getLifecycleStatus', () => {
  it('returns lifecycle status when manifest exists (with manifestHash)', async () => {
    const realHash = '0x' + 'ab'.repeat(32);
    const { impl } = mockFetch({
      data: {
        solverNetManifest: {
          status: 'launched',
          statusUpdatedAt: '2026-05-11T12:00:00Z',
          anchorBlock: '99999',
          manifestHash: realHash,
        },
      },
    });

    const client = createHttpDiscoveryAPI({ url: BASE_URL, fetchImpl: impl as unknown as typeof fetch });
    const result = await client.getLifecycleStatus('bafyreifoo');

    expect(result).toBeDefined();
    expect(result!.status).toBe('launched');
    expect(result!.statusUpdatedAt).toBe('2026-05-11T12:00:00Z');
    expect(result!.sourceBlock).toBe(99999);
    expect(result!.manifestHash).toBe(realHash);
  });

  it('maps null manifestHash from indexer to the "0x" sentinel', async () => {
    // Older indexed rows predate the manifestHash column — the indexer returns
    // null. http.ts must map null → '0x' (the sentinel) so callers can detect
    // "no advertised hash available" without optional-field handling.
    const { impl } = mockFetch({
      data: {
        solverNetManifest: {
          status: 'launched',
          statusUpdatedAt: '2026-05-11T12:00:00Z',
          anchorBlock: '99999',
          manifestHash: null,
        },
      },
    });

    const client = createHttpDiscoveryAPI({ url: BASE_URL, fetchImpl: impl as unknown as typeof fetch });
    const result = await client.getLifecycleStatus('bafyreifoo');

    expect(result).toBeDefined();
    expect(result!.manifestHash).toBe('0x');
  });

  it('returns undefined when manifest not found', async () => {
    const { impl } = mockFetch({ data: { solverNetManifest: null } });
    const client = createHttpDiscoveryAPI({ url: BASE_URL, fetchImpl: impl as unknown as typeof fetch });
    const result = await client.getLifecycleStatus('bafyreinone');
    expect(result).toBeUndefined();
  });

  it('passes manifestCid as variable in GraphQL query', async () => {
    const calls: unknown[] = [];
    const impl = vi.fn(async (url: string, init?: RequestInit) => {
      if (isReadyProbe(url)) return new Response(null, { status: 200 });
      calls.push(JSON.parse(init?.body as string));
      return new Response(
        JSON.stringify({ data: { solverNetManifest: null } }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    });

    const client = createHttpDiscoveryAPI({ url: BASE_URL, fetchImpl: impl as unknown as typeof fetch });
    await client.getLifecycleStatus('bafyreimycid');

    expect(calls).toHaveLength(1);
    const body = calls[0] as { variables: { manifestCid: string } };
    expect(body.variables.manifestCid).toBe('bafyreimycid');
  });

  it('throws DiscoveryUnavailableError on GraphQL errors', async () => {
    const { impl } = mockFetch({ errors: [{ message: 'not found' }] });
    const client = createHttpDiscoveryAPI({ url: BASE_URL, fetchImpl: impl as unknown as typeof fetch });
    await expect(client.getLifecycleStatus('bafyreifoo')).rejects.toThrow(DiscoveryUnavailableError);
  });

  it('throws DiscoveryUnavailableError on network failure', async () => {
    const client = createHttpDiscoveryAPI({
      url: BASE_URL,
      fetchImpl: networkErrorFetch() as unknown as typeof fetch,
    });
    await expect(client.getLifecycleStatus('bafyreifoo')).rejects.toThrow(DiscoveryUnavailableError);
  });
});

// ── getSolverNetOperatorCount (#351) ──────────────────────────────────────────

describe('getSolverNetOperatorCount', () => {
  /**
   * Mock a two-leg GraphQL exchange: `OperatorCountTasks` returns the task
   * page, `OperatorCountAttempts` returns the attempts page. `/ready` probes
   * resolve 200 so the GraphQL path is reached.
   */
  function mockTwoLeg(tasksData: unknown, attemptsData: unknown) {
    const queries: string[] = [];
    const impl = vi.fn(async (url: string, init?: RequestInit) => {
      if (isReadyProbe(url)) return new Response(null, { status: 200 });
      const body = JSON.parse(init?.body as string) as { query: string };
      queries.push(body.query);
      const payload = body.query.includes('query OperatorCountTasks(')
        ? tasksData
        : attemptsData;
      return new Response(JSON.stringify({ data: payload }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    });
    return { impl, queries };
  }

  it('counts distinct operators across the SolverNet attempts', async () => {
    const { impl } = mockTwoLeg(
      {
        tasks: {
          items: [
            { id: '1', chainId: 84532 },
            { id: '2', chainId: 84532 },
          ],
          pageInfo: { hasNextPage: false, endCursor: null },
        },
      },
      {
        attempts: {
          items: [
            // op-a attempts twice, op-b once → 2 distinct operators.
            { operator: '0xAAAA000000000000000000000000000000000000' },
            { operator: '0xaaaa000000000000000000000000000000000000' },
            { operator: '0xBBBB000000000000000000000000000000000000' },
          ],
          pageInfo: { hasNextPage: false, endCursor: null },
        },
      },
    );
    const client = createHttpDiscoveryAPI({ url: BASE_URL, fetchImpl: impl as unknown as typeof fetch });
    const count = await client.getSolverNetOperatorCount('bafkreitestcid');
    expect(count).toBe(2);
  });

  it('returns 0 when the SolverNet has no tasks', async () => {
    const { impl, queries } = mockTwoLeg(
      { tasks: { items: [], pageInfo: { hasNextPage: false, endCursor: null } } },
      { attempts: { items: [], pageInfo: { hasNextPage: false, endCursor: null } } },
    );
    const client = createHttpDiscoveryAPI({ url: BASE_URL, fetchImpl: impl as unknown as typeof fetch });
    const count = await client.getSolverNetOperatorCount('bafkreiempty');
    expect(count).toBe(0);
    // Short-circuit: no attempt query is issued when there are no tasks.
    expect(queries.some((q) => q.includes('query OperatorCountAttempts('))).toBe(false);
  });

  it('returns 0 when tasks exist but no operator has attempted any', async () => {
    const { impl } = mockTwoLeg(
      {
        tasks: {
          items: [{ id: '1', chainId: 84532 }],
          pageInfo: { hasNextPage: false, endCursor: null },
        },
      },
      { attempts: { items: [], pageInfo: { hasNextPage: false, endCursor: null } } },
    );
    const client = createHttpDiscoveryAPI({ url: BASE_URL, fetchImpl: impl as unknown as typeof fetch });
    const count = await client.getSolverNetOperatorCount('bafkreinoattempts');
    expect(count).toBe(0);
  });

  it('filters tasks by the keccak256 manifest digest of the cid', async () => {
    const { impl, queries } = mockTwoLeg(
      { tasks: { items: [], pageInfo: { hasNextPage: false, endCursor: null } } },
      { attempts: { items: [], pageInfo: { hasNextPage: false, endCursor: null } } },
    );
    const client = createHttpDiscoveryAPI({ url: BASE_URL, fetchImpl: impl as unknown as typeof fetch });
    await client.getSolverNetOperatorCount('bafkreitestcid');
    // The tasks query is keyed by manifestDigest (a 0x-prefixed keccak hash),
    // not by the raw cid string.
    expect(queries[0]).toContain('query OperatorCountTasks(');
  });

  it('throws DiscoveryUnavailableError on GraphQL errors', async () => {
    const { impl } = mockFetch({ errors: [{ message: 'indexer 500' }] });
    const client = createHttpDiscoveryAPI({ url: BASE_URL, fetchImpl: impl as unknown as typeof fetch });
    await expect(
      client.getSolverNetOperatorCount('bafkreitestcid'),
    ).rejects.toThrow(DiscoveryUnavailableError);
  });

  it('throws DiscoveryUnavailableError on network failure', async () => {
    const client = createHttpDiscoveryAPI({
      url: BASE_URL,
      fetchImpl: networkErrorFetch() as unknown as typeof fetch,
    });
    await expect(
      client.getSolverNetOperatorCount('bafkreitestcid'),
    ).rejects.toThrow(DiscoveryUnavailableError);
  });
});

// ── queryEnvelopes ────────────────────────────────────────────────────────────

describe('queryEnvelopes', () => {
  it('returns envelope refs from response', async () => {
    const { impl } = mockFetch({
      data: {
        envelopes: {
          items: [
            {
              agentId: '7',
              manifestCid: 'bafyreienvelopes',
              manifestHash: '0x' + 'aa'.repeat(32),
              evidenceTier: 'self-signed',
              publishedAtBlock: '500000',
            },
          ],
        },
      },
    });

    const client = createHttpDiscoveryAPI({ url: BASE_URL, fetchImpl: impl as unknown as typeof fetch });
    const result = await client.queryEnvelopes({ limit: 10 });

    expect(result).toHaveLength(1);
    expect(result[0].manifestCid).toBe('bafyreienvelopes');
    expect(result[0].evidenceTier).toBe('self-signed');
    expect(result[0].operator.agentId).toBe('7');
    expect(result[0].publishedAt).toBe(500000);
  });

  it('passes evidenceTier filter in variables', async () => {
    const calls: unknown[] = [];
    const impl = vi.fn(async (url: string, init?: RequestInit) => {
      if (isReadyProbe(url)) return new Response(null, { status: 200 });
      calls.push(JSON.parse(init?.body as string));
      return new Response(
        JSON.stringify({ data: { envelopes: { items: [] } } }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    });

    const client = createHttpDiscoveryAPI({ url: BASE_URL, fetchImpl: impl as unknown as typeof fetch });
    await client.queryEnvelopes({ evidenceTier: 'committed', limit: 20 });

    expect(calls).toHaveLength(1);
    const body = calls[0] as { variables: { where: { evidenceTier?: string }; limit: number } };
    expect(body.variables.where.evidenceTier).toBe('committed');
    expect(body.variables.limit).toBe(20);
  });

  it('omits evidenceTier from where when not given (avoids Ponder IS-NULL filter)', async () => {
    const calls: unknown[] = [];
    const impl = vi.fn(async (url: string, init?: RequestInit) => {
      if (isReadyProbe(url)) return new Response(null, { status: 200 });
      calls.push(JSON.parse(init?.body as string));
      return new Response(
        JSON.stringify({ data: { envelopes: { items: [] } } }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    });

    const client = createHttpDiscoveryAPI({ url: BASE_URL, fetchImpl: impl as unknown as typeof fetch });
    await client.queryEnvelopes({ limit: 10 });

    expect(calls).toHaveLength(1);
    const body = calls[0] as { variables: { where: Record<string, unknown> } };
    expect(body.variables.where).toEqual({});
  });

  it('throws DiscoveryUnavailableError on GraphQL errors', async () => {
    const { impl } = mockFetch({ errors: [{ message: 'database error' }] });
    const client = createHttpDiscoveryAPI({ url: BASE_URL, fetchImpl: impl as unknown as typeof fetch });
    await expect(client.queryEnvelopes({})).rejects.toThrow(DiscoveryUnavailableError);
  });

  it('throws DiscoveryUnavailableError on network failure', async () => {
    const client = createHttpDiscoveryAPI({
      url: BASE_URL,
      fetchImpl: networkErrorFetch() as unknown as typeof fetch,
    });
    await expect(client.queryEnvelopes({})).rejects.toThrow(DiscoveryUnavailableError);
  });

  it('throws DiscoveryUnavailableError when response has no data field', async () => {
    const { impl } = mockFetch({});
    const client = createHttpDiscoveryAPI({ url: BASE_URL, fetchImpl: impl as unknown as typeof fetch });
    await expect(client.queryEnvelopes({})).rejects.toThrow(DiscoveryUnavailableError);
  });
});

// ── URL normalization ─────────────────────────────────────────────────────────

describe('URL normalization', () => {
  it('appends /graphql to base URL that does not end with it', async () => {
    const gqlCalls: string[] = [];
    const readyCalls: string[] = [];
    const impl = vi.fn(async (url: string, _init?: RequestInit) => {
      if (isReadyProbe(url)) {
        readyCalls.push(url);
        return new Response(null, { status: 200 });
      }
      gqlCalls.push(url);
      return new Response(
        JSON.stringify({ data: { envelopes: { items: [] } } }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    });

    const client = createHttpDiscoveryAPI({ url: 'http://my-indexer.example', fetchImpl: impl as unknown as typeof fetch });
    await client.queryEnvelopes({});
    expect(gqlCalls[0]).toBe('http://my-indexer.example/graphql');
    // /ready hangs off the host root, not under /graphql.
    expect(readyCalls[0]).toBe('http://my-indexer.example/ready');
  });

  it('does not double-append /graphql when URL already ends with it', async () => {
    const gqlCalls: string[] = [];
    const readyCalls: string[] = [];
    const impl = vi.fn(async (url: string, _init?: RequestInit) => {
      if (isReadyProbe(url)) {
        readyCalls.push(url);
        return new Response(null, { status: 200 });
      }
      gqlCalls.push(url);
      return new Response(
        JSON.stringify({ data: { envelopes: { items: [] } } }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    });

    const client = createHttpDiscoveryAPI({ url: 'http://my-indexer.example/graphql', fetchImpl: impl as unknown as typeof fetch });
    await client.queryEnvelopes({});
    expect(gqlCalls[0]).toBe('http://my-indexer.example/graphql');
    // The trailing /graphql is stripped to find the host root for /ready.
    expect(readyCalls[0]).toBe('http://my-indexer.example/ready');
  });
});

// ── /ready readiness probe ────────────────────────────────────────────────────

describe('/ready readiness probe', () => {
  it('throws DiscoveryUnavailableError from every method when /ready is non-200', async () => {
    const { impl, graphqlCalls } = notReadyFetch(503);
    const client = createHttpDiscoveryAPI({ url: BASE_URL, fetchImpl: impl as unknown as typeof fetch });

    await expect(
      client.findClaimableTasks({
        solverNetManifestCids: ['bafyreiabc123'],
        operatorAddress: '0x1234567890123456789012345678901234567890',
      }),
    ).rejects.toThrow(DiscoveryUnavailableError);
    await expect(client.listLaunchedSolverNets()).rejects.toThrow(DiscoveryUnavailableError);
    await expect(client.getLifecycleStatus('bafyreifoo')).rejects.toThrow(DiscoveryUnavailableError);
    await expect(client.queryEnvelopes({})).rejects.toThrow(DiscoveryUnavailableError);

    // None of the methods should have issued a GraphQL query — they bailed at
    // the readiness gate.
    expect(graphqlCalls).toHaveLength(0);
  });

  it('lets the GraphQL query through once /ready returns 200', async () => {
    const { impl } = mockFetch({ data: { envelopes: { items: [] } } });
    const client = createHttpDiscoveryAPI({ url: BASE_URL, fetchImpl: impl as unknown as typeof fetch });
    await expect(client.queryEnvelopes({})).resolves.toEqual([]);
  });

  it('memoizes the /ready result within the TTL (one probe for multiple calls)', async () => {
    let readyProbes = 0;
    const impl = vi.fn(async (url: string, _init?: RequestInit) => {
      if (isReadyProbe(url)) {
        readyProbes++;
        return new Response(null, { status: 200 });
      }
      return new Response(JSON.stringify({ data: { envelopes: { items: [] } } }), {
        status: 200, headers: { 'content-type': 'application/json' },
      });
    });
    const client = createHttpDiscoveryAPI({
      url: BASE_URL,
      fetchImpl: impl as unknown as typeof fetch,
      readyProbeTtlMs: 60_000,
    });
    await client.queryEnvelopes({});
    await client.queryEnvelopes({});
    await client.queryEnvelopes({});
    expect(readyProbes).toBe(1);
  });

  it('re-probes /ready after the TTL elapses', async () => {
    let readyProbes = 0;
    const impl = vi.fn(async (url: string, _init?: RequestInit) => {
      if (isReadyProbe(url)) {
        readyProbes++;
        return new Response(null, { status: 200 });
      }
      return new Response(JSON.stringify({ data: { envelopes: { items: [] } } }), {
        status: 200, headers: { 'content-type': 'application/json' },
      });
    });
    const client = createHttpDiscoveryAPI({
      url: BASE_URL,
      fetchImpl: impl as unknown as typeof fetch,
      readyProbeTtlMs: 0, // expire immediately
    });
    await client.queryEnvelopes({});
    await client.queryEnvelopes({});
    expect(readyProbes).toBe(2);
  });
});

describe('HttpDiscoveryAPI.getInstanceSuccessCounts (#669)', () => {
  it('aggregates pass counts per instance_id across pages, deduping by (requestId, chainId)', async () => {
    const page1 = {
      data: {
        verdictEnvelopeMetas: {
          items: [
            { requestId: '0xa1', chainId: 84532, instanceId: 'sympy__sympy-27510' },
            { requestId: '0xa2', chainId: 84532, instanceId: 'sympy__sympy-27510' },
            { requestId: '0xa3', chainId: 84532, instanceId: 'django__django-100' },
          ],
          pageInfo: { hasNextPage: true, endCursor: 'cur1' },
        },
      },
    };
    const page2 = {
      data: {
        verdictEnvelopeMetas: {
          items: [
            { requestId: '0xa4', chainId: 84532, instanceId: 'sympy__sympy-27510' },
            // Duplicate of page-1 row — must be deduped.
            { requestId: '0xa1', chainId: 84532, instanceId: 'sympy__sympy-27510' },
          ],
          pageInfo: { hasNextPage: false, endCursor: null },
        },
      },
    };
    let call = 0;
    const fetchImpl = vi.fn(async (url: string) => {
      if (isReadyProbe(url)) return new Response('ok', { status: 200 });
      call += 1;
      return new Response(JSON.stringify(call === 1 ? page1 : page2), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }) as unknown as typeof fetch;

    const api = createHttpDiscoveryAPI({ url: 'http://stub/graphql', fetchImpl });
    const counts = await api.getInstanceSuccessCounts({ manifestCid: 'bafymanifest' });

    expect(counts.get('sympy__sympy-27510')).toBe(3);   // 3 distinct, 1 dedup'd
    expect(counts.get('django__django-100')).toBe(1);
    expect(counts.size).toBe(2);
  });

  it('scopes the GraphQL filter by solverNetManifestCid so multi-SolverNet operators don\'t cross-tenant over-count (#669 Finding 2)', async () => {
    const MANIFEST = 'bafyManifestSolverNetA';
    const requestBodies: unknown[] = [];
    const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
      if (isReadyProbe(url)) return new Response('ok', { status: 200 });
      if (init && typeof init.body === 'string') {
        requestBodies.push(JSON.parse(init.body));
      }
      return new Response(
        JSON.stringify({
          data: {
            verdictEnvelopeMetas: {
              items: [],
              pageInfo: { hasNextPage: false, endCursor: null },
            },
          },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    }) as unknown as typeof fetch;

    const api = createHttpDiscoveryAPI({ url: 'http://stub/graphql', fetchImpl });
    await api.getInstanceSuccessCounts({ manifestCid: MANIFEST });

    expect(requestBodies.length).toBeGreaterThan(0);
    const body = requestBodies[0] as { query: string; variables: Record<string, unknown> };
    expect(body.query).toContain('solverNetManifestCid: $solverNetManifestCid');
    expect(body.variables.solverNetManifestCid).toBe(MANIFEST);
  });

  it('throws DiscoveryUnavailableError when GraphQL returns errors', async () => {
    const fetchImpl = vi.fn(async (url: string) => {
      if (isReadyProbe(url)) return new Response('ok', { status: 200 });
      return new Response(
        JSON.stringify({ errors: [{ message: 'indexer cold' }] }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    }) as unknown as typeof fetch;

    const api = createHttpDiscoveryAPI({ url: 'http://stub/graphql', fetchImpl });
    await expect(api.getInstanceSuccessCounts({ manifestCid: 'bafymanifest' })).rejects.toBeInstanceOf(
      DiscoveryUnavailableError,
    );
  });
});

describe('HttpDiscoveryAPI.getInstanceClaimCounts (#802)', () => {
  it('returns consumed-vs-maxClaims per taskId for the SolverNet', async () => {
    // Leg 1: tasks-for-digest page (id + maxClaims + chainId).
    const tasksPage = {
      data: {
        tasks: {
          items: [
            { id: '100', maxClaims: 5, chainId: 84532 },
            { id: '101', maxClaims: 3, chainId: 84532 },
          ],
          pageInfo: { hasNextPage: false, endCursor: null },
        },
      },
    };
    // Leg 2: attempts for those task ids (5 for task 100 = exhausted; 1 for 101 = live).
    const attemptsPage = {
      data: {
        attempts: {
          items: [
            { taskId: '100' }, { taskId: '100' }, { taskId: '100' },
            { taskId: '100' }, { taskId: '100' },
            { taskId: '101' },
          ],
          pageInfo: { hasNextPage: false, endCursor: null },
        },
      },
    };
    let leg = 0;
    const fetchImpl = vi.fn(async (url: string) => {
      if (isReadyProbe(url)) return new Response('ok', { status: 200 });
      leg += 1;
      return new Response(JSON.stringify(leg === 1 ? tasksPage : attemptsPage), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }) as unknown as typeof fetch;

    const api = createHttpDiscoveryAPI({ url: 'http://stub/graphql', fetchImpl });
    const counts = await api.getInstanceClaimCounts({ manifestCid: 'bafymanifest' });

    expect(counts.get('100')).toEqual({ taskId: '100', consumed: 5, maxClaims: 5 });
    expect(counts.get('101')).toEqual({ taskId: '101', consumed: 1, maxClaims: 3 });
    expect(counts.size).toBe(2);
  });

  it('reports zero consumed for a task with no attempts yet', async () => {
    const tasksPage = {
      data: {
        tasks: {
          items: [{ id: '200', maxClaims: 4, chainId: 84532 }],
          pageInfo: { hasNextPage: false, endCursor: null },
        },
      },
    };
    const attemptsPage = {
      data: { attempts: { items: [], pageInfo: { hasNextPage: false, endCursor: null } } },
    };
    let leg = 0;
    const fetchImpl = vi.fn(async (url: string) => {
      if (isReadyProbe(url)) return new Response('ok', { status: 200 });
      leg += 1;
      return new Response(JSON.stringify(leg === 1 ? tasksPage : attemptsPage), {
        status: 200, headers: { 'content-type': 'application/json' },
      });
    }) as unknown as typeof fetch;

    const api = createHttpDiscoveryAPI({ url: 'http://stub/graphql', fetchImpl });
    const counts = await api.getInstanceClaimCounts({ manifestCid: 'bafymanifest' });
    expect(counts.get('200')).toEqual({ taskId: '200', consumed: 0, maxClaims: 4 });
  });

  it('returns an empty Map when the SolverNet has no tasks', async () => {
    const empty = {
      data: { tasks: { items: [], pageInfo: { hasNextPage: false, endCursor: null } } },
    };
    const fetchImpl = vi.fn(async (url: string) => {
      if (isReadyProbe(url)) return new Response('ok', { status: 200 });
      return new Response(JSON.stringify(empty), {
        status: 200, headers: { 'content-type': 'application/json' },
      });
    }) as unknown as typeof fetch;
    const api = createHttpDiscoveryAPI({ url: 'http://stub/graphql', fetchImpl });
    const counts = await api.getInstanceClaimCounts({ manifestCid: 'bafymanifest' });
    expect(counts.size).toBe(0);
  });

  it('throws DiscoveryUnavailableError when GraphQL returns errors', async () => {
    const fetchImpl = vi.fn(async (url: string) => {
      if (isReadyProbe(url)) return new Response('ok', { status: 200 });
      return new Response(JSON.stringify({ errors: [{ message: 'indexer cold' }] }), {
        status: 200, headers: { 'content-type': 'application/json' },
      });
    }) as unknown as typeof fetch;
    const api = createHttpDiscoveryAPI({ url: 'http://stub/graphql', fetchImpl });
    await expect(api.getInstanceClaimCounts({ manifestCid: 'bafymanifest' }))
      .rejects.toBeInstanceOf(DiscoveryUnavailableError);
  });
});

// ── indexer fetch timeout (regression: wedged discovery loop, #1038) ───────────

describe('indexer fetch timeout', () => {
  // Models a real fetch against an indexer whose socket went half-open during a
  // redeploy: it never settles on its own. A correctly-wired AbortSignal.timeout
  // aborts it and we reject the way undici does (via signal.reason). WITHOUT the
  // timeout the promise hangs forever — exactly how the production discovery,
  // generator, and solvernet-catalog loops wedged with no self-recovery while
  // the indexer-independent jinn-claim loop masked the outage on-chain.
  function hangUntilAborted(opts: { readyHangs?: boolean } = {}) {
    return vi.fn((url: string, init?: RequestInit) => {
      if (isReadyProbe(url) && !opts.readyHangs) {
        return Promise.resolve(new Response(null, { status: 200 }));
      }
      return new Promise<Response>((_resolve, reject) => {
        const signal = init?.signal;
        if (signal) {
          if (signal.aborted) {
            reject(signal.reason);
            return;
          }
          signal.addEventListener('abort', () => reject(signal.reason), { once: true });
        }
        // No signal wired → never settles (the bug this test guards against).
      });
    });
  }

  const OPERATOR = '0xdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef' as const;

  it('rejects (does not hang) when the GraphQL fetch never settles', async () => {
    const impl = hangUntilAborted();
    const client = createHttpDiscoveryAPI({
      url: BASE_URL,
      fetchImpl: impl as unknown as typeof fetch,
      fetchTimeoutMs: 50,
    });
    await expect(
      client.findClaimableTasks({ solverNetManifestCids: ['bafyfakecid'], operatorAddress: OPERATOR }),
    ).rejects.toBeInstanceOf(DiscoveryUnavailableError);
  }, 2000);

  it('rejects (does not hang) when the /ready probe never settles', async () => {
    const impl = hangUntilAborted({ readyHangs: true });
    const client = createHttpDiscoveryAPI({
      url: BASE_URL,
      fetchImpl: impl as unknown as typeof fetch,
      fetchTimeoutMs: 50,
    });
    await expect(
      client.findClaimableTasks({ solverNetManifestCids: ['bafyfakecid'], operatorAddress: OPERATOR }),
    ).rejects.toBeInstanceOf(DiscoveryUnavailableError);
  }, 2000);
});

// ── transparent retry on 502/503/network errors (#782) ─────────────────────────

describe('transparent retry on 502/503/network errors (#782)', () => {
  const EMPTY_ENVELOPES = { data: { envelopes: { items: [] } } };

  /** True for the GraphQL POST (vs the /ready GET probe). */
  function isGqlPost(url: string): boolean {
    return url.endsWith('/graphql');
  }

  /**
   * GraphQL POST returns `failStatus` for the first `failTimes` calls, then a
   * valid 200. `/ready` always 200. Tracks POST call count.
   */
  function failStatusThenSucceed(failTimes: number, failStatus: number) {
    const post = { count: 0 };
    const impl = vi.fn(async (url: string) => {
      if (isReadyProbe(url)) return new Response(null, { status: 200 });
      post.count += 1;
      if (post.count <= failTimes) {
        return new Response('upstream error', { status: failStatus });
      }
      return new Response(JSON.stringify(EMPTY_ENVELOPES), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    });
    return { impl, post };
  }

  /** GraphQL POST always returns `status`. `/ready` always 200. */
  function alwaysFailStatus(status: number) {
    const post = { count: 0 };
    const impl = vi.fn(async (url: string) => {
      if (isReadyProbe(url)) return new Response(null, { status: 200 });
      post.count += 1;
      return new Response('upstream error', { status });
    });
    return { impl, post };
  }

  /**
   * GraphQL POST throws a network error for the first `throwTimes` calls, then
   * succeeds. `/ready` always 200. Tracks POST call count.
   */
  function throwThenSucceed(throwTimes: number) {
    const post = { count: 0 };
    const impl = vi.fn(async (url: string) => {
      if (isReadyProbe(url)) return new Response(null, { status: 200 });
      post.count += 1;
      if (post.count <= throwTimes) {
        throw new TypeError('fetch failed');
      }
      return new Response(JSON.stringify(EMPTY_ENVELOPES), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    });
    return { impl, post };
  }

  /** GraphQL POST always throws a network error. `/ready` always 200. */
  function alwaysThrow() {
    const post = { count: 0 };
    const cause = new TypeError('fetch failed: ECONNRESET');
    const impl = vi.fn(async (url: string) => {
      if (isReadyProbe(url)) return new Response(null, { status: 200 });
      post.count += 1;
      throw cause;
    });
    return { impl, post, cause };
  }

  it('succeeds on first try (no retry needed)', async () => {
    const { impl, post } = failStatusThenSucceed(0, 502);
    const client = createHttpDiscoveryAPI({
      url: BASE_URL,
      fetchImpl: impl as unknown as typeof fetch,
      retryDelaysMs: [0, 0],
    });
    await expect(client.queryEnvelopes({})).resolves.toEqual([]);
    expect(post.count).toBe(1);
  });

  it('retries a 502 then succeeds', async () => {
    const { impl, post } = failStatusThenSucceed(1, 502);
    const client = createHttpDiscoveryAPI({
      url: BASE_URL,
      fetchImpl: impl as unknown as typeof fetch,
      retryDelaysMs: [0, 0],
    });
    await expect(client.queryEnvelopes({})).resolves.toEqual([]);
    expect(post.count).toBe(2);
  });

  it('retries a 503 then succeeds', async () => {
    const { impl, post } = failStatusThenSucceed(1, 503);
    const client = createHttpDiscoveryAPI({
      url: BASE_URL,
      fetchImpl: impl as unknown as typeof fetch,
      retryDelaysMs: [0, 0],
    });
    await expect(client.queryEnvelopes({})).resolves.toEqual([]);
    expect(post.count).toBe(2);
  });

  it('retries a thrown network error then succeeds', async () => {
    const { impl, post } = throwThenSucceed(1);
    const client = createHttpDiscoveryAPI({
      url: BASE_URL,
      fetchImpl: impl as unknown as typeof fetch,
      retryDelaysMs: [0, 0],
    });
    await expect(client.queryEnvelopes({})).resolves.toEqual([]);
    expect(post.count).toBe(2);
  });

  it('throws DiscoveryUnavailableError after retries exhausted on persistent 503', async () => {
    const { impl, post } = alwaysFailStatus(503);
    const client = createHttpDiscoveryAPI({
      url: BASE_URL,
      fetchImpl: impl as unknown as typeof fetch,
      retryDelaysMs: [0, 0],
    });
    await expect(client.queryEnvelopes({})).rejects.toThrow(DiscoveryUnavailableError);
    // 1 initial + 2 retries.
    expect(post.count).toBe(3);
    // Original status preserved in the error message.
    await expect(client.queryEnvelopes({})).rejects.toThrow(/503/);
  });

  it('throws DiscoveryUnavailableError after retries exhausted on persistent network error', async () => {
    const { impl, post, cause } = alwaysThrow();
    const client = createHttpDiscoveryAPI({
      url: BASE_URL,
      fetchImpl: impl as unknown as typeof fetch,
      retryDelaysMs: [0, 0],
    });
    let caught: unknown;
    await client.queryEnvelopes({}).catch((e) => { caught = e; });
    expect(caught).toBeInstanceOf(DiscoveryUnavailableError);
    // Original error preserved as the cause.
    expect((caught as DiscoveryUnavailableError).cause).toBe(cause);
    // 1 initial + 2 retries.
    expect(post.count).toBe(3);
  });

  it('does NOT retry a non-retryable non-2xx (500)', async () => {
    const { impl, post } = alwaysFailStatus(500);
    const client = createHttpDiscoveryAPI({
      url: BASE_URL,
      fetchImpl: impl as unknown as typeof fetch,
      retryDelaysMs: [0, 0],
    });
    await expect(client.queryEnvelopes({})).rejects.toThrow(DiscoveryUnavailableError);
    expect(post.count).toBe(1);
  });

  it('does NOT retry GraphQL errors[] in a 200 response', async () => {
    const post = { count: 0 };
    const impl = vi.fn(async (url: string) => {
      if (isReadyProbe(url)) return new Response(null, { status: 200 });
      post.count += 1;
      return new Response(JSON.stringify({ errors: [{ message: 'x' }] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    });
    const client = createHttpDiscoveryAPI({
      url: BASE_URL,
      fetchImpl: impl as unknown as typeof fetch,
      retryDelaysMs: [0, 0],
    });
    await expect(client.queryEnvelopes({})).rejects.toThrow(DiscoveryUnavailableError);
    expect(post.count).toBe(1);
  });

  it('retries a 503 on the /ready probe then succeeds (probe cache not poisoned, AC#4)', async () => {
    // The /ready GET 503s on its first probe-call, then 200s. The retry happens
    // BEFORE the bad-state cache is written, so the method must resolve.
    const ready = { count: 0 };
    const impl = vi.fn(async (url: string) => {
      if (isReadyProbe(url)) {
        ready.count += 1;
        if (ready.count === 1) return new Response(null, { status: 503 });
        return new Response(null, { status: 200 });
      }
      return new Response(JSON.stringify(EMPTY_ENVELOPES), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    });
    const client = createHttpDiscoveryAPI({
      url: BASE_URL,
      fetchImpl: impl as unknown as typeof fetch,
      retryDelaysMs: [0, 0],
      readyProbeTtlMs: 60_000,
    });
    await expect(client.queryEnvelopes({})).resolves.toEqual([]);
    expect(ready.count).toBe(2);
  });

  it('re-probes successfully after a sustained-outage TTL window (AC#5)', async () => {
    // First call: /ready is persistently 503 (rejects after retries exhausted).
    // Second call (TTL=0 so the bad cache is expired immediately): /ready 200,
    // GraphQL valid → resolves. Proves the next probe overwrites the bad cache.
    let readyOutage = true;
    const impl = vi.fn(async (url: string) => {
      if (isReadyProbe(url)) {
        return new Response(null, { status: readyOutage ? 503 : 200 });
      }
      return new Response(JSON.stringify(EMPTY_ENVELOPES), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    });
    const client = createHttpDiscoveryAPI({
      url: BASE_URL,
      fetchImpl: impl as unknown as typeof fetch,
      retryDelaysMs: [0, 0],
      readyProbeTtlMs: 0,
    });
    await expect(client.queryEnvelopes({})).rejects.toThrow(DiscoveryUnavailableError);
    readyOutage = false;
    await expect(client.queryEnvelopes({})).resolves.toEqual([]);
  });
});
