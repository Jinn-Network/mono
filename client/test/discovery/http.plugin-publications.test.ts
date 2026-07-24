import { describe, it, expect, vi } from 'vitest';
import { createHttpDiscoveryAPI } from '../../src/discovery/http.js';

function mockFetch(handlers: Record<string, unknown>) {
  return vi.fn(async (url: string, init?: RequestInit) => {
    if (typeof url === 'string' && url.endsWith('/ready')) {
      return new Response('ok', { status: 200 });
    }
    const body = init?.body ? JSON.parse(String(init.body)) : {};
    const key = (body as { query?: string }).query?.match(/query (\w+)/)?.[1] ?? '';
    const data = handlers[key];
    if (!data) throw new Error(`mock fetch: unhandled query ${key}`);
    return new Response(JSON.stringify({ data }), { status: 200 });
  });
}

describe('HttpDiscoveryAPI.listPluginPublications (attd)', () => {
  it('returns published plug-ins filtered by supports[]', async () => {
    const fetchImpl = mockFetch({
      ListPluginPublications: {
        pluginPublications: {
          items: [
            {
              id: '42:bafyplugincid',
              builderAgentId: '42',
              pluginCid: 'bafyplugincid',
              pluginName: '@builder/swe-skill',
              pluginVersion: '0.1.0',
              pluginSha256: `0x${'aa'.repeat(32)}`,
              supports: ['swe-rebench-v2.v1'],
              publishedAt: '1715700000',
              revoked: false,
              revokedReason: null,
            },
          ],
        },
      },
    });
    const api = createHttpDiscoveryAPI({
      url: 'http://indexer.test/graphql',
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    const rows = await api.listPluginPublications({ solverType: 'swe-rebench-v2.v1' });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      artifactType: 'plugin',
      builderAgentId: '42',
      cid: 'bafyplugincid',
      name: '@builder/swe-skill',
      version: '0.1.0',
      supports: ['swe-rebench-v2.v1'],
      publishedAt: 1_715_700_000,
      revoked: false,
      pluginSha256: `0x${'aa'.repeat(32)}`,
    });
  });

  it('excludes revoked rows when includeRevoked=false', async () => {
    const fetchImpl = mockFetch({
      ListPluginPublications: { pluginPublications: { items: [] } },
    });
    const api = createHttpDiscoveryAPI({
      url: 'http://indexer.test/graphql',
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    await api.listPluginPublications({ includeRevoked: false });
    // Assert the mock saw a `revoked: false` filter.
    const callBody = JSON.parse(String((fetchImpl.mock.calls.find((c) => String(c[0]).endsWith('/graphql'))?.[1] as RequestInit)?.body));
    expect(callBody.variables.where).toMatchObject({ revoked: false });
  });
});

describe('HttpDiscoveryAPI.getPluginScores (attd)', () => {
  it('fails closed without querying permissionless attempt projections', async () => {
    const fetchImpl = vi.fn();
    const api = createHttpDiscoveryAPI({
      url: 'http://indexer.test/graphql',
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    await expect(api.getPluginScores({ pluginCid: 'bafyplugincid' }))
      .resolves.toEqual([]);
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
