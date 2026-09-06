import { describe, expect, it, vi } from 'vitest';
import { createHttpDiscoveryClient } from '../../src/discovery-client/http.js';
import { DiscoveryUnavailableError } from '../../src/discovery-client/types.js';

const available = {
  schemaVersion: 1,
  status: 'available',
  chainId: 84532,
  generatedAt: '2026-09-06T13:47:00.000Z',
  window: {
    start: '2026-09-04T12:00:00.000Z',
    end: '2026-09-06T12:00:00.000Z',
    bucketHours: 6,
    buckets: Array.from({ length: 8 }, (_, index) => ({
      start: new Date(Date.parse('2026-09-04T12:00:00.000Z') + index * 6 * 3_600_000).toISOString(),
      end: new Date(Date.parse('2026-09-04T18:00:00.000Z') + index * 6 * 3_600_000).toISOString(),
    })),
  },
  classes: [{
    workClass: 'prediction.v1',
    contractId: 'prediction',
    contractVersion: 'v1',
    acceptingSolverNets: 1,
    claimingOperators: 2,
    verdictDeliveries: 3,
    latestAttemptAt: '2026-09-06T10:00:00.000Z',
    latestVerdictAt: '2026-09-06T11:00:00.000Z',
  }],
};

function clientFor(body: unknown, status = 200) {
  const fetchImpl = vi.fn(async (input: string | URL | Request) => {
    const url = String(input);
    if (url.endsWith('/ready')) return new Response('ok', { status: 200 });
    return new Response(JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json' },
    });
  });
  return {
    fetchImpl,
    client: createHttpDiscoveryClient({
      url: 'https://indexer.example/graphql',
      fetchImpl: fetchImpl as typeof fetch,
      retryDelaysMs: [],
    }),
  };
}

describe('DiscoveryClient.getCurrentSupply', () => {
  it('uses the ready-gated REST route and strictly decodes a supply response', async () => {
    const { client, fetchImpl } = clientFor(available);
    await expect(client.getCurrentSupply({ chainId: 84532 })).resolves.toEqual(available);
    expect(fetchImpl.mock.calls.map(([url]) => String(url))).toEqual([
      'https://indexer.example/ready',
      'https://indexer.example/supply?chainId=84532',
    ]);
  });

  it('preserves a server unknown response', async () => {
    const unknown = {
      ...available,
      status: 'unknown',
      reason: 'incomplete_indexer_evidence',
      classes: [],
    };
    await expect(clientFor(unknown).client.getCurrentSupply({ chainId: 84532 }))
      .resolves.toEqual(unknown);
  });

  it.each([
    ['outdated schema', { ...available, schemaVersion: 0 }],
    ['bad status', { ...available, status: 'maybe' }],
    ['missing buckets', { ...available, window: { ...available.window, buckets: [] } }],
    ['unsafe count', { ...available, classes: [{ ...available.classes[0], verdictDeliveries: -1 }] }],
    ['stale window', { ...available, generatedAt: '2026-09-07T13:47:00.000Z' }],
    ['out-of-window activity', {
      ...available,
      classes: [{ ...available.classes[0], latestAttemptAt: available.window.end }],
    }],
    ['non-deterministic class order', {
      ...available,
      classes: [
        { ...available.classes[0], workClass: 'z.v1', contractId: 'z' },
        { ...available.classes[0], workClass: 'a.v1', contractId: 'a' },
      ],
    }],
  ])('rejects %s instead of treating it as no supply', async (_label, body) => {
    await expect(clientFor(body).client.getCurrentSupply({ chainId: 84532 }))
      .rejects.toBeInstanceOf(DiscoveryUnavailableError);
  });

  it('carries the indexer\'s own refusal through so an unserved chain is actionable', async () => {
    const { client } = clientFor(
      { error: 'unsupported chainId', detail: 'this indexer serves 84532; it has no evidence about 8453' },
      400,
    );
    await expect(client.getCurrentSupply({ chainId: 8453 }))
      .rejects.toThrow(/no evidence about 8453/u);
  });

  it('rejects an unavailable route instead of falling back to GraphQL or chain reads', async () => {
    const { client, fetchImpl } = clientFor({ error: 'unavailable' }, 503);
    await expect(client.getCurrentSupply({ chainId: 84532 }))
      .rejects.toBeInstanceOf(DiscoveryUnavailableError);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });
});
