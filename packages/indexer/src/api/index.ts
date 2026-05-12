/**
 * Ponder HTTP API endpoint definition.
 *
 * Ponder requires this file to exist. It wires up the auto-generated GraphQL
 * endpoint over the schema and mounts the /explorer/* aggregation routes. The
 * `/health`, `/ready`, and `/status` routes are added automatically by Ponder —
 * do not register them here (it would conflict and fail the build).
 *
 * Route order matters with Hono: `/explorer` is registered before the `/`
 * catch-all GraphQL middleware so the GraphQL catch-all does not shadow the
 * explorer routes.
 *
 * The GraphQL endpoint is kept at both `/graphql` and `/` for backward
 * compatibility with the daemon's client/src/discovery/http.ts, which hits
 * `<url>/graphql`. Task C handles replacing the `/` mount with the SPA.
 */
import { db } from 'ponder:api';
import schema from 'ponder:schema';
import { graphql } from 'ponder';
import { Hono } from 'hono';
import explorer from './explorer.js';

const app = new Hono();

// /explorer/* must be registered before the `/` GraphQL catch-all.
app.route('/explorer', explorer);

app.use('/graphql', graphql({ db, schema }));
app.use('/', graphql({ db, schema }));

export default app;
