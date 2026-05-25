/**
 * GET /v1/discovery/* — daemon-side proxies onto the daemon's `DiscoveryAPI`
 * instance so the SPA does not need direct GraphQL or RPC access.
 *
 * Routes:
 *   GET /v1/discovery/plugin-publications?solverType&builderAgentId&includeRevoked
 *   GET /v1/discovery/builder-artifacts?builderAgentId&limit
 *   GET /v1/discovery/plugin-scores?cid&limit
 *   GET /v1/discovery/solvernet-operator-count?cid
 *
 * Used by the /build SPA route (hfmf) to render published plug-ins, the
 * local operator's published plug-ins, and per-plug-in score history.
 *
 * Accepts two config shapes:
 *   - `{ discovery: () => DiscoveryAPI }` — direct getter (legacy).
 *   - `{ getDiscovery: () => DiscoveryAPI | null }` — lazy holder access; returns
 *     503 subsystem_not_ready until the daemon populates it post-bootstrap.
 *
 * The lazy form lets server.ts register the routes eagerly at server-start
 * (before the daemon has built its DiscoveryAPI), so Hono's matcher includes
 * the paths and the SPA gets a 503 (not a 404) while waiting for bootstrap to
 * finish. Same eager-register / late-populate pattern as solverNetsLauncher
 * and harnessReadinessRegistry. See jinn-mono-u34i.
 */
import type { Hono } from 'hono';
import { DiscoveryUnavailableError } from '../discovery/types.js';
import type { DiscoveryAPI } from '../discovery/types.js';

export type DiscoveryEndpointConfig =
  | { discovery: () => DiscoveryAPI }
  | { getDiscovery: () => DiscoveryAPI | null };

export function addDiscoveryRoutes(app: Hono, config: DiscoveryEndpointConfig): void {
  const getDiscovery: () => DiscoveryAPI | null =
    'getDiscovery' in config ? config.getDiscovery : () => config.discovery();

  app.get('/v1/discovery/plugin-publications', async (c) => {
    const discovery = getDiscovery();
    if (!discovery) {
      return c.json(
        { error: 'subsystem_not_ready', message: 'DiscoveryAPI still initialising' },
        503,
      );
    }
    const solverType = c.req.query('solverType');
    const builderAgentId = c.req.query('builderAgentId');
    const includeRevokedRaw = c.req.query('includeRevoked');
    const includeRevoked = includeRevokedRaw === undefined ? undefined : includeRevokedRaw !== 'false';
    try {
      const publications = await discovery.listPluginPublications({
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
    const discovery = getDiscovery();
    if (!discovery) {
      return c.json(
        { error: 'subsystem_not_ready', message: 'DiscoveryAPI still initialising' },
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
      const artifacts = await discovery.listBuilderArtifacts({
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

  // GET /v1/discovery/solvernet-operator-count?cid=<manifestCid>
  //
  // Returns the count of distinct operators with on-chain activity (claimed
  // tasks) on the SolverNet identified by `cid`. Backs the operator-count
  // surface on the launched-SolverNet dashboard (issue #351). See
  // `DiscoveryAPI.getSolverNetOperatorCount` for why this counts
  // *participating* operators rather than config-level "joins".
  app.get('/v1/discovery/solvernet-operator-count', async (c) => {
    const discovery = getDiscovery();
    if (!discovery) {
      return c.json(
        { error: 'subsystem_not_ready', message: 'DiscoveryAPI still initialising' },
        503,
      );
    }
    const cid = c.req.query('cid');
    if (!cid) return c.json({ error: 'cid is required' }, 400);
    try {
      const operatorCount = await discovery.getSolverNetOperatorCount(cid);
      return c.json({ manifestCid: cid, operatorCount });
    } catch (err) {
      if (err instanceof DiscoveryUnavailableError) {
        return c.json({ error: 'discovery_unavailable' }, 503);
      }
      return c.json({ error: 'internal_error', detail: (err as Error).message }, 503);
    }
  });

  app.get('/v1/discovery/plugin-scores', async (c) => {
    const discovery = getDiscovery();
    if (!discovery) {
      return c.json(
        { error: 'subsystem_not_ready', message: 'DiscoveryAPI still initialising' },
        503,
      );
    }
    const cid = c.req.query('cid');
    if (!cid) return c.json({ error: 'cid is required' }, 400);
    const limitRaw = c.req.query('limit');
    const limit = limitRaw === undefined ? undefined : Number(limitRaw);
    try {
      const scores = await discovery.getPluginScores({
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
