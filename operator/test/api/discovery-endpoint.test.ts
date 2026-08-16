import { describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import { addDiscoveryRoutes } from '../../src/api/discovery-endpoint.js';
import { requireUiToken } from '../../src/api/handshake.js';
import type { ArchiveReads } from '../../src/archive/reads.js';
import { ArchiveReadUnavailableError } from '../../src/archive/reads.js';
import type {
  PluginPublication,
  PluginPublicationReader,
  PublishedArtifact,
} from '../../src/plugin-registry/publication-reader.js';

function stubPluginReader(
  partial: Partial<PluginPublicationReader> = {},
): PluginPublicationReader {
  return {
    listPluginPublications: vi.fn().mockResolvedValue([]),
    getPluginScores: vi.fn().mockResolvedValue([]),
    listBuilderArtifacts: vi.fn().mockResolvedValue([]),
    ...partial,
  };
}

function stubArchiveReads(partial: Partial<ArchiveReads> = {}): ArchiveReads {
  return {
    getTaskPostCounts: vi.fn().mockResolvedValue({
      windowEndBlock: 0,
      windowEndTs: 0,
      chain: { h1: 0, h6: 0, h24: 0, windowEndBlock: 0, windowEndTs: 0 },
      byCid: {},
    }),
    getTaskStatuses: vi.fn().mockResolvedValue(new Map()),
    ...partial,
  };
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
        pluginSha256: '0xabc' as `0x${string}`,
      },
    ];
    const pluginReader = stubPluginReader({
      listPluginPublications: vi.fn().mockResolvedValue(pubs),
    });
    const app = new Hono();
    addDiscoveryRoutes(app, { pluginReader: () => pluginReader });
    const res = await app.request('/v1/discovery/plugin-publications?solverType=swe-rebench-v2.v1');
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.publications).toHaveLength(1);
    expect(body.publications[0].cid).toBe('bafyplugincid');
    expect(pluginReader.listPluginPublications).toHaveBeenCalledWith({
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
    const pluginReader = stubPluginReader({
      listBuilderArtifacts: vi.fn().mockResolvedValue(arts),
    });
    const app = new Hono();
    addDiscoveryRoutes(app, { pluginReader: () => pluginReader });
    const res = await app.request('/v1/discovery/builder-artifacts?builderAgentId=42');
    const body = await res.json();
    expect(body.artifacts).toHaveLength(1);
  });

  it('GET /v1/discovery/builder-artifacts without builderAgentId returns 400', async () => {
    const app = new Hono();
    addDiscoveryRoutes(app, { pluginReader: () => stubPluginReader() });
    const res = await app.request('/v1/discovery/builder-artifacts');
    expect(res.status).toBe(400);
  });

  it('GET /v1/discovery/plugin-scores?cid= returns score history', async () => {
    const pluginReader = stubPluginReader({
      getPluginScores: vi.fn().mockResolvedValue([]),
    });
    const app = new Hono();
    addDiscoveryRoutes(app, { pluginReader: () => pluginReader });
    const res = await app.request('/v1/discovery/plugin-scores?cid=bafy1');
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(Array.isArray(body.scores)).toBe(true);
    expect(pluginReader.getPluginScores).toHaveBeenCalledWith({ pluginCid: 'bafy1' });
  });

  it('503s when the plugin reader throws', async () => {
    const pluginReader = stubPluginReader({
      listPluginPublications: vi.fn().mockRejectedValue(new Error('indexer down')),
    });
    const app = new Hono();
    addDiscoveryRoutes(app, { pluginReader: () => pluginReader });
    const res = await app.request('/v1/discovery/plugin-publications');
    expect(res.status).toBe(503);
  });

  it('GET /v1/discovery/plugin-publications 503s subsystem_not_ready when pluginReader is null', async () => {
    const app = new Hono();
    addDiscoveryRoutes(app, { pluginReader: () => null });
    const res = await app.request('/v1/discovery/plugin-publications');
    expect(res.status).toBe(503);
    const body = await res.json();
    expect(body.error).toBe('subsystem_not_ready');
  });

  it('GET /v1/discovery/task-post-counts with no cid returns chain counts (#918)', async () => {
    const archiveReads = stubArchiveReads({
      getTaskPostCounts: vi.fn().mockResolvedValue({
        windowEndBlock: 100,
        windowEndTs: 1_715_600_000,
        chain: { h1: 1, h6: 2, h24: 3, windowEndBlock: 100, windowEndTs: 1_715_600_000 },
        byCid: {},
      }),
    });
    const app = new Hono();
    addDiscoveryRoutes(app, {
      pluginReader: () => stubPluginReader(),
      archiveReads: () => archiveReads,
    });
    const res = await app.request('/v1/discovery/task-post-counts');
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.chain.h24).toBe(3);
  });

  it('GET /v1/discovery/task-post-counts?cid=a&cid=b returns byCid map (#918)', async () => {
    const archiveReads = stubArchiveReads({
      getTaskPostCounts: vi.fn().mockResolvedValue({
        windowEndBlock: 100,
        windowEndTs: 0,
        chain: { h1: 0, h6: 0, h24: 0, windowEndBlock: 100, windowEndTs: 0 },
        byCid: {
          a: { h1: 0, h6: 0, h24: 0, windowEndBlock: 100, windowEndTs: 0 },
          b: { h1: 0, h6: 0, h24: 0, windowEndBlock: 100, windowEndTs: 0 },
        },
      }),
    });
    const app = new Hono();
    addDiscoveryRoutes(app, {
      pluginReader: () => stubPluginReader(),
      archiveReads: () => archiveReads,
    });
    const res = await app.request('/v1/discovery/task-post-counts?cid=a&cid=b');
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.byCid).toHaveProperty('a');
    expect(body.byCid).toHaveProperty('b');
    expect(archiveReads.getTaskPostCounts).toHaveBeenCalledWith({ manifestCids: ['a', 'b'] });
  });

  it('GET /v1/discovery/task-post-counts 503s on an archive outage (#918)', async () => {
    const archiveReads = stubArchiveReads({
      getTaskPostCounts: vi.fn().mockRejectedValue(new ArchiveReadUnavailableError('projector down')),
    });
    const app = new Hono();
    addDiscoveryRoutes(app, {
      pluginReader: () => stubPluginReader(),
      archiveReads: () => archiveReads,
    });
    const res = await app.request('/v1/discovery/task-post-counts');
    expect(res.status).toBe(503);
    expect((await res.json()).error).toBe('discovery_unavailable');
  });

  it('GET /v1/discovery/task-post-counts 503s subsystem_not_ready when archiveReads is null (#918)', async () => {
    const app = new Hono();
    addDiscoveryRoutes(app, { pluginReader: () => stubPluginReader() });
    const res = await app.request('/v1/discovery/task-post-counts');
    expect(res.status).toBe(503);
    const body = await res.json();
    expect(body.error).toBe('subsystem_not_ready');
  });
});

describe('discovery-endpoint — auth gating (jinn-mono-0nih)', () => {
  const UI_TOKEN = 'ui-token-test';

  function gatedApp(): Hono {
    const app = new Hono();
    app.use('/v1/discovery', requireUiToken(UI_TOKEN));
    app.use('/v1/discovery/*', requireUiToken(UI_TOKEN));
    addDiscoveryRoutes(app, {
      pluginReader: () => stubPluginReader(),
      archiveReads: () => stubArchiveReads(),
    });
    return app;
  }

  it('rejects unauthenticated requests with 401', async () => {
    const app = gatedApp();
    const res = await app.request(
      '/v1/discovery/plugin-publications?solverType=swe-rebench-v2.v1',
    );
    expect(res.status).toBe(401);
  });

  it('accepts requests bearing the UI token in the header', async () => {
    const app = gatedApp();
    const res = await app.request(
      '/v1/discovery/plugin-publications?solverType=swe-rebench-v2.v1',
      { headers: { 'x-jinn-ui-token': UI_TOKEN } },
    );
    expect(res.status).toBe(200);
  });

  it('gates every remaining discovery sub-path', async () => {
    const app = gatedApp();
    for (const path of [
      '/v1/discovery/plugin-publications?solverType=foo',
      '/v1/discovery/builder-artifacts?builderAgentId=1',
      '/v1/discovery/plugin-scores?cid=bafy',
      '/v1/discovery/task-post-counts?cid=bafytest',
    ]) {
      const res = await app.request(path);
      expect(res.status, `${path} should require auth`).toBe(401);
    }
  });
});

describe('discovery-endpoint plugin-reader injection (R3, #2461)', () => {
  it('maps PluginPublicationUnavailableError to 503 discovery_unavailable', async () => {
    const { PluginPublicationUnavailableError } = await import(
      '../../src/plugin-registry/publication-reader.js'
    );
    const pluginReader = stubPluginReader({
      listPluginPublications: vi.fn().mockRejectedValue(
        new PluginPublicationUnavailableError('rpc down'),
      ),
    });
    const app = new Hono();
    addDiscoveryRoutes(app, { pluginReader: () => pluginReader });
    const res = await app.request('/v1/discovery/plugin-publications');
    expect(res.status).toBe(503);
    expect((await res.json()).error).toBe('discovery_unavailable');
  });

  it('serves plugin routes with pluginReader-only wiring (retired operator-count 404s)', async () => {
    const pluginReader = stubPluginReader();
    const app = new Hono();
    addDiscoveryRoutes(app, { pluginReader: () => pluginReader });
    expect((await app.request('/v1/discovery/plugin-publications')).status).toBe(200);
    expect((await app.request('/v1/discovery/solvernet-operator-count?cid=x')).status).toBe(404);
  });
});
