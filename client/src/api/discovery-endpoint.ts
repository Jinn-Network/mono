/**
 * GET /v1/discovery/* — daemon-side proxies onto the daemon's `DiscoveryAPI`
 * instance so the SPA does not need direct GraphQL or RPC access.
 *
 * Routes:
 *   GET /v1/discovery/plugin-publications?solverType&builderAgentId&includeRevoked
 *   GET /v1/discovery/builder-artifacts?builderAgentId&limit
 *   GET /v1/discovery/plugin-scores?cid&limit
 *
 * Used by the /build SPA route (hfmf) to render published plug-ins, the
 * local operator's published plug-ins, and per-plug-in score history.
 */
import type { Hono } from 'hono';
import { DiscoveryUnavailableError } from '../discovery/types.js';
import type { DiscoveryAPI } from '../discovery/types.js';

export interface DiscoveryEndpointConfig {
  discovery: () => DiscoveryAPI;
}

export function addDiscoveryRoutes(app: Hono, config: DiscoveryEndpointConfig): void {
  app.get('/v1/discovery/plugin-publications', async (c) => {
    const solverType = c.req.query('solverType');
    const builderAgentId = c.req.query('builderAgentId');
    const includeRevokedRaw = c.req.query('includeRevoked');
    const includeRevoked = includeRevokedRaw === undefined ? undefined : includeRevokedRaw !== 'false';
    try {
      const publications = await config.discovery().listPluginPublications({
        ...(solverType !== undefined ? { solverType } : {}),
        ...(builderAgentId !== undefined ? { builderAgentId } : {}),
        ...(includeRevoked !== undefined ? { includeRevoked } : {}),
      });
      return c.json({ publications });
    } catch (err) {
      if (err instanceof DiscoveryUnavailableError) {
        return c.json({ error: 'discovery_unavailable' }, 503);
      }
      return c.json({ error: 'internal_error', detail: (err as Error).message }, 503);
    }
  });

  app.get('/v1/discovery/builder-artifacts', async (c) => {
    const builderAgentId = c.req.query('builderAgentId');
    if (!builderAgentId) {
      return c.json({ error: 'builderAgentId is required' }, 400);
    }
    const limitRaw = c.req.query('limit');
    const limit = limitRaw === undefined ? undefined : Number(limitRaw);
    try {
      const artifacts = await config.discovery().listBuilderArtifacts({
        builderAgentId,
        ...(limit !== undefined && Number.isFinite(limit) ? { limit } : {}),
      });
      return c.json({ artifacts });
    } catch (err) {
      if (err instanceof DiscoveryUnavailableError) {
        return c.json({ error: 'discovery_unavailable' }, 503);
      }
      return c.json({ error: 'internal_error', detail: (err as Error).message }, 503);
    }
  });

  app.get('/v1/discovery/plugin-scores', async (c) => {
    const cid = c.req.query('cid');
    if (!cid) return c.json({ error: 'cid is required' }, 400);
    const limitRaw = c.req.query('limit');
    const limit = limitRaw === undefined ? undefined : Number(limitRaw);
    try {
      const scores = await config.discovery().getPluginScores({
        pluginCid: cid,
        ...(limit !== undefined && Number.isFinite(limit) ? { limit } : {}),
      });
      return c.json({ scores });
    } catch (err) {
      if (err instanceof DiscoveryUnavailableError) {
        return c.json({ error: 'discovery_unavailable' }, 503);
      }
      return c.json({ error: 'internal_error', detail: (err as Error).message }, 503);
    }
  });
}
