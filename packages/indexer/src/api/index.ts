/**
 * Ponder HTTP API endpoint definition.
 *
 * Ponder requires this file to exist. It wires up:
 *   - GraphQL at `/graphql` — the daemon's client/src/discovery/http.ts hits
 *     `<url>/graphql`; that is the only GraphQL mount (no longer at `/`).
 *   - `/explorer/*` — aggregation JSON routes (network KPIs, per-SolverNet
 *     stats, operator leaderboards). See src/api/explorer.ts.
 *   - `/` — the placeholder network-explorer page (ebu7.4 will replace this
 *     with the real hashed-asset SPA bundle and add static-asset serving then).
 *   - `/health`, `/ready`, `/status` — added automatically by Ponder; do NOT
 *     register them here (it would conflict and fail the build).
 *
 * Route-registration order matters in Hono: `/graphql` and `/explorer` are
 * registered before `/` so the exact-match routes are not shadowed by the
 * root handler.
 */
import { db } from 'ponder:api';
import schema from 'ponder:schema';
import { graphql } from 'ponder';
import { Hono } from 'hono';
import explorer from './explorer.js';
import { PLACEHOLDER_HTML } from './placeholder.js';

const app = new Hono();

app.use('/graphql', graphql({ db, schema }));
app.route('/explorer', explorer);
app.get('/', (c) => c.html(PLACEHOLDER_HTML));

export default app;
