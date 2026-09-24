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

  it('carries the incomplete-manifest marker through decoding', async () => {
    // The marker is how a caller learns that `classes` may be SHORT. Dropping
    // it in the decoder would silently restore the "absent class means absent
    // supply" reading the field exists to prevent.
    const body = { ...available, incompleteManifestRows: 2 };
    await expect(clientFor(body).client.getCurrentSupply({ chainId: 84532 })).resolves.toEqual(body);
  });

  it('rejects a non-positive incomplete-manifest marker', async () => {
    // Absence, not zero, is how "nothing was excluded" is spelled.
    await expect(
      clientFor({ ...available, incompleteManifestRows: 0 }).client.getCurrentSupply({ chainId: 84532 }),
    ).rejects.toThrow(DiscoveryUnavailableError);
  });

  it('carries the incomplete-activity marker through decoding', async () => {
    const body = { ...available, incompleteActivityRows: 3 };
    await expect(clientFor(body).client.getCurrentSupply({ chainId: 84532 })).resolves.toEqual(body);
  });

  it('rejects a non-positive incomplete-activity marker', async () => {
    await expect(
      clientFor({ ...available, incompleteActivityRows: 0 }).client.getCurrentSupply({ chainId: 84532 }),
    ).rejects.toThrow(DiscoveryUnavailableError);
  });

  it('rejects a class identifier longer than 128 characters', async () => {
    const contractId = 'c'.repeat(129);
    await expect(
      clientFor({
        ...available,
        classes: [{
          ...available.classes[0],
          contractId,
          workClass: `${contractId}.v1`,
        }],
      }).client.getCurrentSupply({ chainId: 84532 }),
    ).rejects.toThrow(DiscoveryUnavailableError);
  });

  it('accepts a 128-character class identifier', async () => {
    // workClass is `${contractId}.${contractVersion}`, so a 128-char workClass
    // is the longest identifier the schema can accept while keeping the tuple
    // identity check.
    const contractId = 'c'.repeat(125);
    const contractVersion = 'v1';
    const body = {
      ...available,
      classes: [{
        ...available.classes[0],
        contractId,
        contractVersion,
        workClass: `${contractId}.${contractVersion}`,
      }],
    };
    await expect(clientFor(body).client.getCurrentSupply({ chainId: 84532 })).resolves.toEqual(body);
  });

  // The indexer drops an over-cap class into incompleteManifestRows (#4234),
  // so a healthy response carries only in-cap identifiers. The decoder keeps
  // its own cap as defense in depth against an indexer that does not.
  function withSecondClass(contractId: string, contractVersion: string) {
    const second = {
      ...available.classes[0],
      contractId,
      contractVersion,
      workClass: `${contractId}.${contractVersion}`,
    };
    return {
      ...available,
      classes: [available.classes[0], second].sort((a, b) => (a.workClass < b.workClass ? -1 : 1)),
    };
  }

  it('passes a multi-class response whose identifiers are all within the cap', async () => {
    const body = withSecondClass('c'.repeat(125), 'v1');
    await expect(clientFor(body).client.getCurrentSupply({ chainId: 84532 })).resolves.toEqual(body);
  });

  it.each([
    ['contractId', 'c'.repeat(200), 'v1'],
    ['contractVersion', 'prediction', 'v'.repeat(200)],
    // Each part fits the cap on its own; only the joined workClass is over it.
    ['joined workClass', 'c'.repeat(126), 'v1'],
  ])('fails closed with invalid_response when a class next to a healthy one has an over-cap %s', async (
    _label,
    contractId,
    contractVersion,
  ) => {
    await expect(
      clientFor(withSecondClass(contractId, contractVersion)).client.getCurrentSupply({ chainId: 84532 }),
    ).rejects.toMatchObject({ code: 'invalid_response' });
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

  it('tags indexer 4xx as invalid_request and keeps the served-chain detail', async () => {
    const { client } = clientFor(
      { error: 'unsupported chainId', detail: 'this indexer serves 84532; it has no evidence about 8453' },
      400,
    );
    await expect(client.getCurrentSupply({ chainId: 8453 })).rejects.toMatchObject({
      code: 'invalid_request',
    });
    await expect(client.getCurrentSupply({ chainId: 8453 })).rejects.toThrow(/serves 84532.*8453/u);
  });

  it('rejects an unavailable route instead of falling back to GraphQL or chain reads', async () => {
    const { client, fetchImpl } = clientFor({ error: 'unavailable' }, 503);
    await expect(client.getCurrentSupply({ chainId: 84532 }))
      .rejects.toBeInstanceOf(DiscoveryUnavailableError);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('tags a non-positive chainId as invalid_request', async () => {
    const { client } = clientFor(available);
    await expect(client.getCurrentSupply({ chainId: 0 })).rejects.toMatchObject({
      name: 'DiscoveryUnavailableError',
      code: 'invalid_request',
    });
  });

  it('tags a Zod decoder rejection as invalid_response, distinct from invalid_request', async () => {
    // The indexer answered; the body just doesn't decode against this
    // client's schema — usually version skew (#4235), not a caller/config
    // mistake like a malformed
    // discovery.url or the indexer's own 4xx refusal.
    await expect(
      clientFor({ ...available, schemaVersion: 0 }).client.getCurrentSupply({ chainId: 84532 }),
    ).rejects.toMatchObject({ code: 'invalid_response' });
  });

  it('tags a response chainId mismatch as invalid_request, not invalid_response', async () => {
    await expect(
      clientFor({ ...available, chainId: 999 }).client.getCurrentSupply({ chainId: 84532 }),
    ).rejects.toMatchObject({ code: 'invalid_request' });
  });

  it('tags a malformed discovery.url as invalid_request', async () => {
    // Real fetch throws TypeError on an unparseable URL. A stub that returns
    // 200 for any string lets /ready succeed and hides the misclassification.
    const fetchImpl = vi.fn(async (input: string | URL | Request) => {
      void new URL(String(input));
      return new Response('ok', { status: 200 });
    });
    const client = createHttpDiscoveryClient({
      url: 'not a url',
      fetchImpl: fetchImpl as typeof fetch,
      retryDelaysMs: [],
    });
    await expect(client.getCurrentSupply({ chainId: 84532 })).rejects.toMatchObject({
      name: 'DiscoveryUnavailableError',
      code: 'invalid_request',
    });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('leaves 5xx and transport failures untagged so they stay transient', async () => {
    await expect(
      clientFor({ error: 'unavailable' }, 503).client.getCurrentSupply({ chainId: 84532 }),
    ).rejects.toMatchObject({ code: undefined });

    const fetchImpl = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.endsWith('/ready')) return new Response('ok', { status: 200 });
      throw new TypeError('network down');
    });
    const client = createHttpDiscoveryClient({
      url: 'https://indexer.example/graphql',
      fetchImpl: fetchImpl as typeof fetch,
      retryDelaysMs: [],
    });
    await expect(client.getCurrentSupply({ chainId: 84532 })).rejects.toMatchObject({
      code: undefined,
    });
  });
});
