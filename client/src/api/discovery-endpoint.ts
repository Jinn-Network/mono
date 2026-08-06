/**
 * GET /v1/discovery/* — daemon-side proxies onto the daemon's `DiscoveryAPI`
 * instance so the SPA does not need direct GraphQL or RPC access.
 *
 * Routes:
 *   GET /v1/discovery/plugin-publications?solverType&builderAgentId&includeRevoked
 *   GET /v1/discovery/builder-artifacts?builderAgentId&limit
 *   GET /v1/discovery/plugin-scores?cid&limit
 *   GET /v1/discovery/solvernet-operator-count?cid
 *   GET /v1/discovery/task-post-counts?cid (repeatable)
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
import {
  PluginPublicationUnavailableError,
  type PluginPublicationReader,
} from '../plugin-registry/publication-reader.js';

/**
 * One-swap R3 (#2461): the three plugin-publication routes read through the
 * neutral `PluginPublicationReader` (the carved-out host over the
 * IdentityRegistry log source), injected as `pluginReader`. This decouples them
 * from `discovery/` so the Build page's plug-in panels survive the D-wave
 * deletion. When `pluginReader` is absent the routes fall back to the injected
 * `DiscoveryAPI` (which structurally satisfies the port), so legacy wiring is
 * unchanged. The `solvernet-operator-count` and `task-post-counts` routes still
 * read `DiscoveryAPI` directly — their repoint is a separate D-wave concern.
 */
export type DiscoveryEndpointConfig = (
  | { discovery: () => DiscoveryAPI }
  | { getDiscovery: () => DiscoveryAPI | null }
) & {
  pluginReader?: () => PluginPublicationReader | null;
};

export function addDiscoveryRoutes(app: Hono, config: DiscoveryEndpointConfig): void {
  const getDiscovery: () => DiscoveryAPI | null =
    'getDiscovery' in config ? config.getDiscovery : () => config.discovery();
  // Prefer the injected plugin-publication reader; fall back to the DiscoveryAPI
  // (structural `PluginPublicationReader`) so legacy boots are byte-unchanged.
  const getPluginReader: () => PluginPublicationReader | null = () =>
    config.pluginReader?.() ?? getDiscovery();

  app.get('/v1/discovery/plugin-publications', async (c) => {
    const reader = getPluginReader();
    if (!reader) {
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
      const publications = await reader.listPluginPublications({
        ...(solverType !== undefined ? { solverType } : {}),
        ...(builderAgentId !== undefined ? { builderAgentId } : {}),
        ...(includeRevoked !== undefined ? { includeRevoked } : {}),
      });
      return c.json({ publications });
    } catch (err) {
      if (
        err instanceof PluginPublicationUnavailableError ||
        err instanceof DiscoveryUnavailableError
      ) {
        return c.json({ error: 'discovery_unavailable' }, 503);
      }
      return c.json({ error: 'internal_error', detail: (err as Error).message }, 503);
    }
  });

  app.get('/v1/discovery/builder-artifacts', async (c) => {
    const reader = getPluginReader();
    if (!reader) {
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
      const artifacts = await reader.listBuilderArtifacts({
        builderAgentId,
        ...(limit !== undefined && Number.isFinite(limit) ? { limit } : {}),
      });
      return c.json({ artifacts });
    } catch (err) {
      if (
        err instanceof PluginPublicationUnavailableError ||
        err instanceof DiscoveryUnavailableError
      ) {
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

  // GET /v1/discovery/task-post-counts?cid=<manifestCid>&cid=<...>
  //
  // Windowed on-chain task-post counts (last 1h / 6h / 24h) from TaskCreated
  // events on the active chain. Always returns chain-wide `chain` totals; when
  // one or more `cid` params are present, also returns per-SolverNet totals in
  // `byCid`. Backs the Network "Task posts" panel and the SolverNets index
  // "Recent posts" column (issue #918). See `DiscoveryAPI.getTaskPostCounts`.
  app.get('/v1/discovery/task-post-counts', async (c) => {
    const discovery = getDiscovery();
    if (!discovery) {
      return c.json(
        { error: 'subsystem_not_ready', message: 'DiscoveryAPI still initialising' },
        503,
      );
    }
    const cids = c.req.queries('cid')?.filter((v) => v.length > 0) ?? [];
    try {
      const result = await discovery.getTaskPostCounts(
        cids.length > 0 ? { manifestCids: cids } : undefined,
      );
      return c.json(result);
    } catch (err) {
      if (err instanceof DiscoveryUnavailableError) {
        return c.json({ error: 'discovery_unavailable' }, 503);
      }
      return c.json({ error: 'internal_error', detail: (err as Error).message }, 503);
    }
  });

  app.get('/v1/discovery/plugin-scores', async (c) => {
    const reader = getPluginReader();
    if (!reader) {
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
      const scores = await reader.getPluginScores({
        pluginCid: cid,
        ...(limit !== undefined && Number.isFinite(limit) ? { limit } : {}),
      });
      return c.json({ scores });
    } catch (err) {
      if (
        err instanceof PluginPublicationUnavailableError ||
        err instanceof DiscoveryUnavailableError
      ) {
        return c.json({ error: 'discovery_unavailable' }, 503);
      }
      return c.json({ error: 'internal_error', detail: (err as Error).message }, 503);
    }
  });
}
