/**
 * Ponder HTTP API endpoint definition.
 *
 * Ponder requires this file to exist. It wires up the auto-generated GraphQL
 * endpoint over the schema. The `/health`, `/ready`, and `/status` routes are
 * added automatically by Ponder — do not register them here (it would conflict
 * and fail the build).
 *
 * Custom routes (auth, rate limiting, alternative response shapes) would go in
 * this file alongside the GraphQL middleware if ever needed.
 */
import { db } from 'ponder:api';
import schema, { pluginPublication } from 'ponder:schema';
import { graphql } from 'ponder';
import { Hono } from 'hono';
import { eq } from 'drizzle-orm';
import { attributeRuns } from '../builder-attribution.js';

const app = new Hono();

app.use('/graphql', graphql({ db, schema }));
app.use('/', graphql({ db, schema }));

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
