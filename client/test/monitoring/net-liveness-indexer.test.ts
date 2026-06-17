/**
 * Tests for the indexer readers used by the net-liveness probe. Both read
 * on-chain truth through the Ponder indexer. `/status` failures return null so
 * the probe classifies them as indexer-down; GraphQL activity read failures
 * throw so they cannot be confused with clean empty result sets.
 *
 * Request shapes are mocked the same way as test/discovery/http.test.ts: a
 * vi.fn fetchImpl returning Response stubs.
 */
import { describe, it, expect, vi } from 'vitest';
import {
  fetchIndexerHeadBlock,
  fetchLatestActivityBlock,
  postNetLivenessWebhook,
} from '../../src/monitoring/net-liveness.js';

const BASE_URL = 'http://localhost:42069';

describe('fetchIndexerHeadBlock', () => {
  it('parses the per-chain block.number from /status into a bigint', async () => {
    const fetchImpl = vi.fn(async (_url: string) =>
      new Response(
        JSON.stringify({ 'base-sepolia': { id: 84532, block: { number: 12345, timestamp: 1 } } }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      ),
    ) as unknown as typeof fetch;

    const head = await fetchIndexerHeadBlock({
      baseUrl: BASE_URL,
      chainName: 'base-sepolia',
      chainId: 84532,
      fetchImpl,
    });
    expect(head).toBe(12345n);
    // /status is served at the host root
    expect((fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls[0][0]).toBe(
      `${BASE_URL}/status`,
    );
  });

  it('selects the expected chain when /status includes multiple chains', async () => {
    const fetchImpl = vi.fn(async (_url: string) =>
      new Response(
        JSON.stringify({
          base: { id: 8453, block: { number: 999, timestamp: 1 } },
          'base-sepolia': { id: 84532, block: { number: 12345, timestamp: 1 } },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      ),
    ) as unknown as typeof fetch;

    const head = await fetchIndexerHeadBlock({
      baseUrl: BASE_URL,
      chainName: 'base-sepolia',
      chainId: 84532,
      fetchImpl,
    });

    expect(head).toBe(12345n);
  });

  it('returns null when /status responds 503', async () => {
    const fetchImpl = vi.fn(async () => new Response(null, { status: 503 })) as unknown as typeof fetch;
    const head = await fetchIndexerHeadBlock({
      baseUrl: BASE_URL,
      chainName: 'base-sepolia',
      chainId: 84532,
      fetchImpl,
    });
    expect(head).toBeNull();
  });

  it('returns null when the shape is unexpected', async () => {
    const fetchImpl = vi.fn(async () =>
      new Response(JSON.stringify({ unexpected: true }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    ) as unknown as typeof fetch;
    const head = await fetchIndexerHeadBlock({
      baseUrl: BASE_URL,
      chainName: 'base-sepolia',
      chainId: 84532,
      fetchImpl,
    });
    expect(head).toBeNull();
  });

  it('returns null when the fetch throws', async () => {
    const fetchImpl = vi.fn(async () => {
      throw new TypeError('connection refused');
    }) as unknown as typeof fetch;
    const head = await fetchIndexerHeadBlock({
      baseUrl: BASE_URL,
      chainName: 'base-sepolia',
      chainId: 84532,
      fetchImpl,
    });
    expect(head).toBeNull();
  });
});

describe('fetchLatestActivityBlock', () => {
  /** Build a mock that returns distinct verdict/attempt blocks based on the query body. */
  function gqlMock(verdictBlock: number | null, attemptBlock: number | null) {
    return vi.fn(async (_url: string, init?: RequestInit) => {
      const body = JSON.parse(init?.body as string) as { query: string };
      const isVerdict = body.query.includes('verdicts');
      const block = isVerdict ? verdictBlock : attemptBlock;
      const items = block === null ? [] : [{ createdAtBlock: String(block) }];
      const key = isVerdict ? 'verdicts' : 'attempts';
      return new Response(JSON.stringify({ data: { [key]: { items } } }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }) as unknown as typeof fetch;
  }

  it('returns the verdict block when it is newer than the attempt block', async () => {
    const fetchImpl = gqlMock(9_000, 8_000);
    const block = await fetchLatestActivityBlock({
      gqlUrl: `${BASE_URL}/graphql`,
      chainId: 84532,
      fetchImpl,
    });
    expect(block).toBe(9_000n);
  });

  it('returns the attempt block when it is newer than the verdict block', async () => {
    const fetchImpl = gqlMock(7_000, 8_500);
    const block = await fetchLatestActivityBlock({
      gqlUrl: `${BASE_URL}/graphql`,
      chainId: 84532,
      fetchImpl,
    });
    expect(block).toBe(8_500n);
  });

  it('returns null when both verdicts and attempts are empty', async () => {
    const fetchImpl = gqlMock(null, null);
    const block = await fetchLatestActivityBlock({
      gqlUrl: `${BASE_URL}/graphql`,
      chainId: 84532,
      fetchImpl,
    });
    expect(block).toBeNull();
  });

  it('returns the present leg when only one of the two has rows', async () => {
    const fetchImpl = gqlMock(null, 4_242);
    const block = await fetchLatestActivityBlock({
      gqlUrl: `${BASE_URL}/graphql`,
      chainId: 84532,
      fetchImpl,
    });
    expect(block).toBe(4_242n);
  });

  it('scopes both latest activity GraphQL legs to the monitored chain', async () => {
    const requests: Array<{ query: string; variables?: Record<string, unknown> }> = [];
    const fetchImpl = vi.fn(async (_url: string, init?: RequestInit) => {
      const body = JSON.parse(init?.body as string) as {
        query: string;
        variables?: Record<string, unknown>;
      };
      requests.push(body);
      const key = body.query.includes('verdicts') ? 'verdicts' : 'attempts';
      return new Response(
        JSON.stringify({ data: { [key]: { items: [{ createdAtBlock: '12345' }] } } }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    }) as unknown as typeof fetch;

    const block = await fetchLatestActivityBlock({
      gqlUrl: `${BASE_URL}/graphql`,
      chainId: 84532,
      fetchImpl,
    });

    expect(block).toBe(12345n);
    expect(requests).toHaveLength(2);
    for (const request of requests) {
      expect(request.query).toContain('query LatestActivity($chainId: Int!)');
      expect(request.query).toContain('where: { chainId: $chainId }');
      expect(request.variables).toEqual({ chainId: 84532 });
    }
  });

  it('throws when GraphQL responds non-2xx', async () => {
    const fetchImpl = vi.fn(async () =>
      new Response(JSON.stringify({ errors: [{ message: 'boom' }] }), {
        status: 500,
        headers: { 'content-type': 'application/json' },
      }),
    ) as unknown as typeof fetch;

    await expect(
      fetchLatestActivityBlock({ gqlUrl: `${BASE_URL}/graphql`, chainId: 84532, fetchImpl }),
    ).rejects.toThrow(/GraphQL latest activity read failed/);
  });

  it('throws when the GraphQL response is an error envelope', async () => {
    const fetchImpl = vi.fn(async () =>
      new Response(JSON.stringify({ errors: [{ message: 'boom' }] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    ) as unknown as typeof fetch;
    await expect(
      fetchLatestActivityBlock({ gqlUrl: `${BASE_URL}/graphql`, chainId: 84532, fetchImpl }),
    ).rejects.toThrow(/GraphQL latest activity read failed/);
  });

  it('throws when GraphQL returns malformed JSON', async () => {
    const fetchImpl = vi.fn(async () =>
      new Response('{not json', {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    ) as unknown as typeof fetch;

    await expect(
      fetchLatestActivityBlock({ gqlUrl: `${BASE_URL}/graphql`, chainId: 84532, fetchImpl }),
    ).rejects.toThrow(/GraphQL latest activity read failed/);
  });

  it('throws when the fetch throws', async () => {
    const fetchImpl = vi.fn(async () => {
      throw new TypeError('connection refused');
    }) as unknown as typeof fetch;
    await expect(
      fetchLatestActivityBlock({ gqlUrl: `${BASE_URL}/graphql`, chainId: 84532, fetchImpl }),
    ).rejects.toThrow(/GraphQL latest activity read failed/);
  });
});

describe('postNetLivenessWebhook', () => {
  const payload = {
    text: 'stale',
    state: 'stale' as const,
    staleForBlocks: '9000',
    staleForMinutes: 300,
    chainHeadBlock: '10000',
    latestActivityBlock: '1000',
    runAt: '2026-06-14T00:00:00.000Z',
  };

  it('throws a sanitized delivery error when the webhook responds non-2xx', async () => {
    const secretUrl = 'https://hooks.example/services/TOKEN/SECRET';
    const fetchImpl = vi.fn(async () => new Response('forbidden', { status: 403 })) as unknown as typeof fetch;

    const post = postNetLivenessWebhook(secretUrl, fetchImpl);

    await expect(post?.(payload)).rejects.toThrow(/webhook delivery failed: HTTP 403/);
    await expect(post?.(payload)).rejects.not.toThrow(secretUrl);
  });

  it('throws a sanitized setup error for invalid webhook URLs', () => {
    expect(() => postNetLivenessWebhook('not a url')).toThrow(/invalid webhook URL/);
  });
});
