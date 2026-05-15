import { describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import { addDiscoveryRoutes } from '../../src/api/discovery-endpoint.js';
import type { DiscoveryAPI, PluginPublication, PublishedArtifact } from '../../src/discovery/types.js';

function stubDiscovery(partial: Partial<DiscoveryAPI>): DiscoveryAPI {
  return {
    findClaimableTasks: vi.fn(),
    listLaunchedSolverNets: vi.fn(),
    getLifecycleStatus: vi.fn(),
    queryEnvelopes: vi.fn(),
    listPluginPublications: vi.fn().mockResolvedValue([]),
    getPluginScores: vi.fn().mockResolvedValue([]),
    listBuilderArtifacts: vi.fn().mockResolvedValue([]),
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
});
