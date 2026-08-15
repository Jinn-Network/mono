/**
 * GET /v1/discovery/* — operator-API proxies for plugin publications and
 * archive-backed task-post counts.
 *
 * Routes:
 *   GET /v1/discovery/plugin-publications?solverType&builderAgentId&includeRevoked
 *   GET /v1/discovery/builder-artifacts?builderAgentId&limit
 *   GET /v1/discovery/plugin-scores?cid&limit
 *   GET /v1/discovery/task-post-counts?cid (repeatable)
 *
 * Wave-4 D4: plugin routes require `pluginReader` (no DiscoveryAPI fallback).
 * `GET /v1/discovery/solvernet-operator-count` retired with the ERC-8004
 * registry client. Task-post counts read the projector via ArchiveReads.
 */
import type { Hono } from 'hono';
import {
  ArchiveReadUnavailableError,
  type ArchiveReads,
} from '../archive/reads.js';
import {
  PluginPublicationUnavailableError,
  type PluginPublicationReader,
} from '../plugin-registry/publication-reader.js';

export type DiscoveryEndpointConfig = {
  pluginReader: () => PluginPublicationReader | null;
  archiveReads?: () => ArchiveReads | null;
};

export function addDiscoveryRoutes(app: Hono, config: DiscoveryEndpointConfig): void {
  const getPluginReader = (): PluginPublicationReader | null => config.pluginReader();
  const getArchiveReads = (): ArchiveReads | null => config.archiveReads?.() ?? null;

  app.get('/v1/discovery/plugin-publications', async (c) => {
    const reader = getPluginReader();
    if (!reader) {
      return c.json(
        { error: 'subsystem_not_ready', message: 'plugin publication reader still initialising' },
        503,
      );
    }
    const solverType = c.req.query('solverType');
    const builderAgentId = c.req.query('builderAgentId');
    const includeRevokedRaw = c.req.query('includeRevoked');
    const includeRevoked = includeRevokedRaw === undefined ? undefined : includeRevokedRaw !== 'false';
    try {
      const publications = await reader.listPluginPublications({
        ...(solverType !== undefined ? { solverType } : {}),
        ...(builderAgentId !== undefined ? { builderAgentId } : {}),
        ...(includeRevoked !== undefined ? { includeRevoked } : {}),
      });
      return c.json({ publications });
    } catch (err) {
      if (err instanceof PluginPublicationUnavailableError) {
        return c.json({ error: 'discovery_unavailable' }, 503);
      }
      return c.json({ error: 'internal_error', detail: (err as Error).message }, 503);
    }
  });

  app.get('/v1/discovery/builder-artifacts', async (c) => {
    const reader = getPluginReader();
    if (!reader) {
      return c.json(
        { error: 'subsystem_not_ready', message: 'plugin publication reader still initialising' },
        503,
      );
    }
    const builderAgentId = c.req.query('builderAgentId');
    if (!builderAgentId) {
      return c.json({ error: 'builderAgentId is required' }, 400);
    }
    const limitRaw = c.req.query('limit');
    const limit = limitRaw === undefined ? undefined : Number(limitRaw);
    try {
      const artifacts = await reader.listBuilderArtifacts({
        builderAgentId,
        ...(limit !== undefined && Number.isFinite(limit) ? { limit } : {}),
      });
      return c.json({ artifacts });
    } catch (err) {
      if (err instanceof PluginPublicationUnavailableError) {
        return c.json({ error: 'discovery_unavailable' }, 503);
      }
      return c.json({ error: 'internal_error', detail: (err as Error).message }, 503);
    }
  });

  // GET /v1/discovery/task-post-counts?cid=<manifestCid>&cid=<...>
  //
  // Windowed on-chain task-post counts (last 1h / 6h / 24h) from projector
  // TaskCreated observations. Always returns chain-wide `chain` totals; when
  // one or more `cid` params are present, also returns per-SolverNet totals in
  // `byCid` (zeros — native TaskCreated has no manifestDigest).
  app.get('/v1/discovery/task-post-counts', async (c) => {
    const reads = getArchiveReads();
    if (!reads) {
      return c.json(
        { error: 'subsystem_not_ready', message: 'archive reads still initialising' },
        503,
      );
    }
    const cids = c.req.queries('cid')?.filter((v) => v.length > 0) ?? [];
    try {
      const result = await reads.getTaskPostCounts(
        cids.length > 0 ? { manifestCids: cids } : undefined,
      );
      return c.json(result);
    } catch (err) {
      if (err instanceof ArchiveReadUnavailableError) {
        return c.json({ error: 'discovery_unavailable' }, 503);
      }
      return c.json({ error: 'internal_error', detail: (err as Error).message }, 503);
    }
  });

  app.get('/v1/discovery/plugin-scores', async (c) => {
    const reader = getPluginReader();
    if (!reader) {
      return c.json(
        { error: 'subsystem_not_ready', message: 'plugin publication reader still initialising' },
        503,
      );
    }
    const cid = c.req.query('cid');
    if (!cid) return c.json({ error: 'cid is required' }, 400);
    const limitRaw = c.req.query('limit');
    const limit = limitRaw === undefined ? undefined : Number(limitRaw);
    try {
      const scores = await reader.getPluginScores({
        pluginCid: cid,
        ...(limit !== undefined && Number.isFinite(limit) ? { limit } : {}),
      });
      return c.json({ scores });
    } catch (err) {
      if (err instanceof PluginPublicationUnavailableError) {
        return c.json({ error: 'discovery_unavailable' }, 503);
      }
      return c.json({ error: 'internal_error', detail: (err as Error).message }, 503);
    }
  });
}
