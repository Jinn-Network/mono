import { describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import { addDiscoveryRoutes } from '../../src/api/discovery-endpoint.js';
import { requireUiToken } from '../../src/api/handshake.js';
import type { DiscoveryAPI, PluginPublication, PublishedArtifact } from '../../src/discovery/types.js';

function stubDiscovery(partial: Partial<DiscoveryAPI>): DiscoveryAPI {
  return {
    findClaimableTasks: vi.fn(),
    listLaunchedSolverNets: vi.fn(),
    getLifecycleStatus: vi.fn(),
    getSolverNetOperatorCount: vi.fn().mockResolvedValue(0),
    queryEnvelopes: vi.fn(),
    listPluginPublications: vi.fn().mockResolvedValue([]),
    getPluginScores: vi.fn().mockResolvedValue([]),
    listBuilderArtifacts: vi.fn().mockResolvedValue([]),
    getTaskPostCounts: vi.fn().mockResolvedValue({
      windowEndBlock: 0,
      windowEndTs: 0,
      chain: { h1: 0, h6: 0, h24: 0, windowEndBlock: 0, windowEndTs: 0 },
      byCid: {},
    }),
    ...partial,
  } as DiscoveryAPI;
}

describe('discovery-endpoint (hfmf)', () => {
  it('GET /v1/discovery/plugin-publications?solverType= returns publications', async () => {
    const pubs: PluginPublication[] = [
      {
        builderAgentId: '42',
        cid: 'bafyplugincid',
        name: '@you/x',
        version: '0.1.0',
        supports: ['swe-rebench-v2.v1'],
        publishedAt: 1715600000,
        artifactType: 'plugin',
        revoked: false,
        pluginSha256: '0xabc',
      } as PluginPublication,
    ];
    const discovery = stubDiscovery({
      listPluginPublications: vi.fn().mockResolvedValue(pubs),
    });
    const app = new Hono();
    addDiscoveryRoutes(app, { discovery: () => discovery });
    const res = await app.request('/v1/discovery/plugin-publications?solverType=swe-rebench-v2.v1');
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.publications).toHaveLength(1);
    expect(body.publications[0].cid).toBe('bafyplugincid');
    expect(discovery.listPluginPublications).toHaveBeenCalledWith({
      solverType: 'swe-rebench-v2.v1',
    });
  });

  it('GET /v1/discovery/builder-artifacts?builderAgentId= proxies through', async () => {
    const arts: PublishedArtifact[] = [
      {
        builderAgentId: '42',
        cid: 'bafy1',
        name: '@you/x',
        version: '0.1.0',
        supports: ['swe-rebench-v2.v1'],
        publishedAt: 1715600000,
        artifactType: 'plugin',
        revoked: false,
      },
    ];
    const discovery = stubDiscovery({
      listBuilderArtifacts: vi.fn().mockResolvedValue(arts),
    });
    const app = new Hono();
    addDiscoveryRoutes(app, { discovery: () => discovery });
    const res = await app.request('/v1/discovery/builder-artifacts?builderAgentId=42');
    const body = await res.json();
    expect(body.artifacts).toHaveLength(1);
  });

  it('GET /v1/discovery/builder-artifacts without builderAgentId returns 400', async () => {
    const discovery = stubDiscovery({});
    const app = new Hono();
    addDiscoveryRoutes(app, { discovery: () => discovery });
    const res = await app.request('/v1/discovery/builder-artifacts');
    expect(res.status).toBe(400);
  });

  it('GET /v1/discovery/plugin-scores?cid= returns score history', async () => {
    const discovery = stubDiscovery({
      getPluginScores: vi.fn().mockResolvedValue([]),
    });
    const app = new Hono();
    addDiscoveryRoutes(app, { discovery: () => discovery });
    const res = await app.request('/v1/discovery/plugin-scores?cid=bafy1');
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(Array.isArray(body.scores)).toBe(true);
    expect(discovery.getPluginScores).toHaveBeenCalledWith({ pluginCid: 'bafy1' });
  });

  it('500s when discovery is unavailable', async () => {
    const discovery = stubDiscovery({
      listPluginPublications: vi.fn().mockRejectedValue(new Error('indexer down')),
    });
    const app = new Hono();
    addDiscoveryRoutes(app, { discovery: () => discovery });
    const res = await app.request('/v1/discovery/plugin-publications');
    expect(res.status).toBe(503);
  });

  it('GET /v1/discovery/solvernet-operator-count?cid= returns the count (#351)', async () => {
    const discovery = stubDiscovery({
      getSolverNetOperatorCount: vi.fn().mockResolvedValue(3),
    });
    const app = new Hono();
    addDiscoveryRoutes(app, { discovery: () => discovery });
    const res = await app.request(
      '/v1/discovery/solvernet-operator-count?cid=bafkreitest',
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.manifestCid).toBe('bafkreitest');
    expect(body.operatorCount).toBe(3);
    expect(discovery.getSolverNetOperatorCount).toHaveBeenCalledWith('bafkreitest');
  });

  it('GET /v1/discovery/task-post-counts with no cid returns chain counts (#918)', async () => {
    const chainCounts = {
      windowEndBlock: 1000,
      windowEndTs: 1715600000,
      chain: { h1: 1, h6: 4, h24: 9, windowEndBlock: 1000, windowEndTs: 1715600000 },
      byCid: {},
    };
    const getTaskPostCounts = vi.fn().mockResolvedValue(chainCounts);
    const discovery = stubDiscovery({ getTaskPostCounts });
    const app = new Hono();
    addDiscoveryRoutes(app, { discovery: () => discovery });
    const res = await app.request('/v1/discovery/task-post-counts');
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.chain).toEqual(chainCounts.chain);
    expect(body.byCid).toEqual({});
    // No cid params → called with no manifestCids filter.
    expect(getTaskPostCounts).toHaveBeenCalledWith(undefined);
  });

  it('GET /v1/discovery/task-post-counts?cid=a&cid=b returns byCid map (#918)', async () => {
    const result = {
      windowEndBlock: 1000,
      windowEndTs: 1715600000,
      chain: { h1: 2, h6: 5, h24: 12, windowEndBlock: 1000, windowEndTs: 1715600000 },
      byCid: {
        a: { h1: 1, h6: 2, h24: 3, windowEndBlock: 1000, windowEndTs: 1715600000 },
        b: { h1: 0, h6: 1, h24: 4, windowEndBlock: 1000, windowEndTs: 1715600000 },
      },
    };
    const getTaskPostCounts = vi.fn().mockResolvedValue(result);
    const discovery = stubDiscovery({ getTaskPostCounts });
    const app = new Hono();
    addDiscoveryRoutes(app, { discovery: () => discovery });
    const res = await app.request('/v1/discovery/task-post-counts?cid=a&cid=b');
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.byCid.a.h24).toBe(3);
    expect(body.byCid.b.h24).toBe(4);
    expect(getTaskPostCounts).toHaveBeenCalledWith({ manifestCids: ['a', 'b'] });
  });

  it('GET /v1/discovery/task-post-counts 503s on a discovery outage (#918)', async () => {
    const { DiscoveryUnavailableError } = await import('../../src/discovery/types.js');
    const discovery = stubDiscovery({
      getTaskPostCounts: vi.fn().mockRejectedValue(new DiscoveryUnavailableError('indexer down')),
    });
    const app = new Hono();
    addDiscoveryRoutes(app, { discovery: () => discovery });
    const res = await app.request('/v1/discovery/task-post-counts');
    expect(res.status).toBe(503);
    const body = await res.json();
    expect(body.error).toBe('discovery_unavailable');
  });

  it('GET /v1/discovery/task-post-counts 503s subsystem_not_ready when discovery is null (#918)', async () => {
    const app = new Hono();
    addDiscoveryRoutes(app, { getDiscovery: () => null });
    const res = await app.request('/v1/discovery/task-post-counts');
    expect(res.status).toBe(503);
    const body = await res.json();
    expect(body.error).toBe('subsystem_not_ready');
  });

  it('GET /v1/discovery/solvernet-operator-count without cid returns 400', async () => {
    const discovery = stubDiscovery({});
    const app = new Hono();
    addDiscoveryRoutes(app, { discovery: () => discovery });
    const res = await app.request('/v1/discovery/solvernet-operator-count');
    expect(res.status).toBe(400);
  });

  it('GET /v1/discovery/solvernet-operator-count 503s on discovery outage', async () => {
    const discovery = stubDiscovery({
      getSolverNetOperatorCount: vi.fn().mockRejectedValue(new Error('indexer down')),
    });
    const app = new Hono();
    addDiscoveryRoutes(app, { discovery: () => discovery });
    const res = await app.request(
      '/v1/discovery/solvernet-operator-count?cid=bafkreitest',
    );
    expect(res.status).toBe(503);
  });
});

describe('discovery-endpoint — auth gating (jinn-mono-0nih)', () => {
  const UI_TOKEN = 'ui-token-test';

  function gatedApp(discovery: DiscoveryAPI): Hono {
    const app = new Hono();
    app.use('/v1/discovery', requireUiToken(UI_TOKEN));
    app.use('/v1/discovery/*', requireUiToken(UI_TOKEN));
    addDiscoveryRoutes(app, { discovery: () => discovery });
    return app;
  }

  it('rejects unauthenticated requests with 401', async () => {
    const app = gatedApp(stubDiscovery({}));
    const res = await app.request(
      '/v1/discovery/plugin-publications?solverType=swe-rebench-v2.v1',
    );
    expect(res.status).toBe(401);
  });

  it('accepts requests bearing the UI token in the header', async () => {
    const app = gatedApp(stubDiscovery({}));
    const res = await app.request(
      '/v1/discovery/plugin-publications?solverType=swe-rebench-v2.v1',
      { headers: { 'x-jinn-ui-token': UI_TOKEN } },
    );
    expect(res.status).toBe(200);
  });

  it('gates every discovery sub-path', async () => {
    const app = gatedApp(stubDiscovery({}));
    for (const path of [
      '/v1/discovery/plugin-publications?solverType=foo',
      '/v1/discovery/builder-artifacts?builderAgentId=1',
      '/v1/discovery/plugin-scores?cid=bafy',
      '/v1/discovery/solvernet-operator-count?cid=bafytest',
      '/v1/discovery/task-post-counts?cid=bafytest',
    ]) {
      const res = await app.request(path);
      expect(res.status, `${path} should require auth`).toBe(401);
    }
  });
});

// ── One-swap R3 (#2461): plugin-publication reader injection ──────────────────

describe('discovery-endpoint plugin-reader injection (R3, #2461)', () => {
  it('prefers the injected pluginReader over discovery for plugin routes', async () => {
    const discovery = stubDiscovery({
      listPluginPublications: vi.fn().mockResolvedValue([]),
    });
    const readerPub: PluginPublication = {
      builderAgentId: '9',
      cid: 'bafyFromReader',
      name: '@you/host',
      version: '2.0.0',
      supports: ['swe-rebench-v2.v1'],
      publishedAt: 1_715_600_001,
      artifactType: 'plugin',
      revoked: false,
      pluginSha256: '0xdef',
    };
    const pluginReader = {
      listPluginPublications: vi.fn().mockResolvedValue([readerPub]),
      getPluginScores: vi.fn().mockResolvedValue([]),
      listBuilderArtifacts: vi.fn().mockResolvedValue([readerPub]),
    };
    const app = new Hono();
    addDiscoveryRoutes(app, { discovery: () => discovery, pluginReader: () => pluginReader });
    const res = await app.request('/v1/discovery/plugin-publications');
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.publications[0].cid).toBe('bafyFromReader');
    // The reader was used; the DiscoveryAPI plugin method was not.
    expect(pluginReader.listPluginPublications).toHaveBeenCalledOnce();
    expect(discovery.listPluginPublications).not.toHaveBeenCalled();
  });

  it('maps PluginPublicationUnavailableError to 503 discovery_unavailable', async () => {
    const { PluginPublicationUnavailableError } = await import(
      '../../src/plugin-registry/publication-reader.js'
    );
    const pluginReader = {
      listPluginPublications: vi.fn().mockRejectedValue(
        new PluginPublicationUnavailableError('rpc down'),
      ),
      getPluginScores: vi.fn(),
      listBuilderArtifacts: vi.fn(),
    };
    const app = new Hono();
    addDiscoveryRoutes(app, { getDiscovery: () => null, pluginReader: () => pluginReader });
    const res = await app.request('/v1/discovery/plugin-publications');
    expect(res.status).toBe(503);
    expect((await res.json()).error).toBe('discovery_unavailable');
  });

  it('serves plugin routes with pluginReader-only wiring (no DiscoveryAPI)', async () => {
    const pluginReader = {
      listPluginPublications: vi.fn().mockResolvedValue([]),
      getPluginScores: vi.fn().mockResolvedValue([]),
      listBuilderArtifacts: vi.fn().mockResolvedValue([]),
    };
    const app = new Hono();
    addDiscoveryRoutes(app, { getDiscovery: () => null, pluginReader: () => pluginReader });
    // plugin route works…
    expect((await app.request('/v1/discovery/plugin-publications')).status).toBe(200);
    // …while the non-plugin discovery route 503s (no DiscoveryAPI).
    expect((await app.request('/v1/discovery/solvernet-operator-count?cid=x')).status).toBe(503);
  });
});
