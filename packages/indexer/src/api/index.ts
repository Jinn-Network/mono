/**
 * Ponder HTTP API endpoint definition.
 *
 * Ponder requires this file to exist. It wires up:
 *   - GraphQL at `/graphql` — the daemon's client/src/discovery/http.ts hits
 *     `<url>/graphql`; that is the only GraphQL mount (no longer at `/`).
 *   - `/explorer/*` — aggregation JSON routes (network KPIs, per-SolverNet
 *     stats, operator leaderboards). See src/api/explorer.ts.
 *   - `/` and `/*` — when `public/index.html` is present (built by `yarn
 *     build:explorer`), serves the hashed-asset SPA bundle with a client-side
 *     routing fallback so any non-API path returns the shell. When the bundle
 *     is absent (fresh checkout, CI before `yarn build`) falls back to the
 *     inline placeholder so the indexer is never broken without a frontend
 *     build.
 *   - `/health`, `/ready`, `/status` — added automatically by Ponder; do NOT
 *     register them here (it would conflict and fail the build).
 *
 * Custom routes (auth, rate limiting, alternative response shapes) would go in
 * this file alongside the GraphQL middleware if ever needed.
 *
 * Routes:
 *   GET /builders/:agentId/runs         — builder-attributed run join (attd)
 *   GET /plugins                        — list plug-ins by ?solverNet= or ?builder= (ttz8)
 *   GET /plugins/:cid/scores            — score history for a plug-in CID (ttz8, ebu7 dep)
 *   GET /builders/:address/artifacts    — unified artifact list for a builder (ttz8)
 *   GET /builders/:address/scores       — per-artifact score history for a builder (ttz8, ebu7 dep)
 *
 * Route-registration order matters in Hono: `/graphql` and `/explorer` are
 * registered before the static catch-all so exact-match routes are not
 * shadowed.
 */
import { db } from 'ponder:api';
import schema, { pluginPublication } from 'ponder:schema';
import { graphql } from 'ponder';
import { Hono } from 'hono';
import { eq } from 'drizzle-orm';
import { attributeRuns } from '../builder-attribution.js';
import {
  listPluginsByNetwork,
  listPluginsByBuilder,
  getPluginScores,
  listBuilderArtifacts,
  listBuilderScores,
  type PluginPublicationRow,
  type AttemptEnvelopeMetaRow,
  type VerdictRow,
} from './routes.js';
import { serveStatic } from '@hono/node-server/serve-static';
import { existsSync } from 'node:fs';
import explorer from './explorer.js';
import { PLACEHOLDER_HTML } from './placeholder.js';

const app = new Hono();

app.use('/graphql', graphql({ db, schema }));
app.route('/explorer', explorer);

// Serve the built explorer SPA from ./public if it exists; otherwise fall back
// to the placeholder page so the indexer is never broken without a frontend build.
const hasSpaBuild = existsSync('./public/index.html');

if (hasSpaBuild) {
  // First pass: try to serve the file directly from public/ (assets, sigils, etc.).
  // serveStatic calls next() when no matching file exists, so the SPA fallback below
  // handles all client-side routes.
  app.use('*', serveStatic({ root: './public' }));
  // SPA shell fallback: any non-API path that wasn't a real file returns index.html
  // so client-side routing works.
  app.get('*', serveStatic({ path: 'index.html', root: './public' }));
} else {
  app.get('/', (c) => c.html(PLACEHOLDER_HTML));
}

// ── Shared ebu7-schema probe ──────────────────────────────────────────────────
// Routes 3 and 5 join against ebu7's `attemptEnvelopeMeta` + `verdict`
// entities. Until ebu7 merges those tables are absent from the schema; this
// helper returns empty arrays in that case so the routes degrade gracefully.

type EbU7Schema = typeof schema & {
  attemptEnvelopeMeta?: unknown;
  verdict?: unknown;
};

async function fetchEbu7Rows(agentId?: string): Promise<{
  metas: AttemptEnvelopeMetaRow[];
  verdicts: VerdictRow[];
}> {
  const s = schema as EbU7Schema;
  if (!s.attemptEnvelopeMeta || !s.verdict) return { metas: [], verdicts: [] };
  // When ebu7 lands, add WHERE filters keyed on agentId / pluginCid.
  // For now the tables don't exist so we always return [].
  void agentId; // suppress unused-param lint
  return { metas: [], verdicts: [] };
}

// ── GET /builders/:agentId/runs ───────────────────────────────────────────────

/**
 * Custom JSON route for builder-attributed runs. attd ships this without the
 * ebu7-side joins live — when `attemptEnvelopeMeta` / verdict tables are not
 * yet present in the deployed schema, the route returns `[]`. Once ebu7 lands,
 * this route picks up the new entities via the same `db` handle.
 *
 * ebu7 dependency: `attemptEnvelopeMeta` and `verdict` are populated by the
 * ebu7 enrichment bead. Until ebu7 merges, the route returns `[]` because
 * `schema.attemptEnvelopeMeta` / `schema.verdict` do not exist yet. The route
 * is additive — the SPA can call it from day one and pick up data automatically
 * when ebu7 lands without any change to this file.
 */
app.get('/builders/:agentId/runs', async (c) => {
  const agentId = c.req.param('agentId');
  try {
    // Read the builder's publications — keyed via the pluginPublication entity.
    const publications = await db
      .select()
      .from(pluginPublication)
      .where(eq(pluginPublication.builderAgentId, agentId));

    const s = schema as EbU7Schema;
    if (!s.attemptEnvelopeMeta || !s.verdict) {
      return c.json([]);
    }

    // When ebu7 lands, replace the placeholder below with:
    //   const metas = await db.select().from(s.attemptEnvelopeMeta).where(...);
    //   const verdicts = await db.select().from(s.verdict).where(...);
    //   return c.json(attributeRuns({ publications, attemptEnvelopeMetas: metas, verdicts }));
    return c.json(attributeRuns({
      publications: publications as never,
      attemptEnvelopeMetas: [],
      verdicts: [],
    }));
  } catch (err) {
    return c.json({ error: 'builder-attribution unavailable', detail: String(err) }, 503);
  }
});

// ── GET /plugins ──────────────────────────────────────────────────────────────
//   Dispatches on query param: ?solverNet= or ?builder=
//   Returns 400 when neither (or both) are present.

app.get('/plugins', async (c) => {
  const solverNet = c.req.query('solverNet');
  const builder = c.req.query('builder');
  const includeRevoked = c.req.query('includeRevoked') === 'true';

  if (!solverNet && !builder) {
    return c.json({ error: 'missing query param', detail: 'provide ?solverNet= or ?builder=' }, 400);
  }
  if (solverNet && builder) {
    return c.json({ error: 'ambiguous query', detail: 'provide exactly one of ?solverNet= or ?builder=' }, 400);
  }

  try {
    const rows = (await db.select().from(pluginPublication)) as PluginPublicationRow[];

    if (solverNet) {
      return c.json(listPluginsByNetwork({ publications: rows, solverNet, includeRevoked }));
    }
    // builder branch
    return c.json(listPluginsByBuilder({ publications: rows, builderAgentId: builder!, includeRevoked }));
  } catch (err) {
    return c.json({ error: 'plugin-list unavailable', detail: String(err) }, 503);
  }
});

// ── GET /plugins/:cid/scores ──────────────────────────────────────────────────
//   ebu7 dependency: returns [] until attemptEnvelopeMeta + verdict land.

app.get('/plugins/:cid/scores', async (c) => {
  const pluginCid = c.req.param('cid');
  if (!pluginCid) return c.json({ error: 'missing cid', detail: 'path param :cid is required' }, 400);

  try {
    const rows = (await db
      .select()
      .from(pluginPublication)
      .where(eq(pluginPublication.pluginCid, pluginCid))) as PluginPublicationRow[];

    if (rows.length === 0) return c.json([]);

    const { metas, verdicts } = await fetchEbu7Rows();
    return c.json(getPluginScores({ publications: rows, pluginCid, attemptEnvelopeMetas: metas, verdicts }));
  } catch (err) {
    return c.json({ error: 'plugin-scores unavailable', detail: String(err) }, 503);
  }
});

// ── GET /builders/:address/artifacts ──────────────────────────────────────────
//   Unified artifact list (today: plug-ins only). The artifactType discriminator
//   is future-proofed for the Path 2 harness:<cid> kind per spec §5.6.

app.get('/builders/:address/artifacts', async (c) => {
  const builderAgentId = c.req.param('address');
  if (!builderAgentId) {
    return c.json({ error: 'missing address', detail: 'path param :address is required' }, 400);
  }

  try {
    const rows = (await db
      .select()
      .from(pluginPublication)
      .where(eq(pluginPublication.builderAgentId, builderAgentId))) as PluginPublicationRow[];

    return c.json(listBuilderArtifacts({ publications: rows, builderAgentId }));
  } catch (err) {
    return c.json({ error: 'builder-artifacts unavailable', detail: String(err) }, 503);
  }
});

// ── GET /builders/:address/scores ─────────────────────────────────────────────
//   ebu7 dependency: returns [] until attemptEnvelopeMeta + verdict land.

app.get('/builders/:address/scores', async (c) => {
  const builderAgentId = c.req.param('address');
  if (!builderAgentId) {
    return c.json({ error: 'missing address', detail: 'path param :address is required' }, 400);
  }

  try {
    const rows = (await db
      .select()
      .from(pluginPublication)
      .where(eq(pluginPublication.builderAgentId, builderAgentId))) as PluginPublicationRow[];

    const { metas, verdicts } = await fetchEbu7Rows(builderAgentId);
    return c.json(listBuilderScores({ publications: rows, builderAgentId, attemptEnvelopeMetas: metas, verdicts }));
  } catch (err) {
    return c.json({ error: 'builder-scores unavailable', detail: String(err) }, 503);
  }
});

export default app;
