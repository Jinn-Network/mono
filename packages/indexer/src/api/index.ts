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

    // attemptEnvelopeMeta + verdict are owned by ebu7. If they exist on the
    // schema import they're queryable; if not, return []. The Hono route is
    // additive — adding it now means the SPA can call it from day one and pick
    // up data automatically when ebu7 lands.
    type EbU7Schema = typeof schema & {
      attemptEnvelopeMeta?: unknown;
      verdict?: unknown;
    };
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

export default app;
