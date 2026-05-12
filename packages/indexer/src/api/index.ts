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
import schema from 'ponder:schema';
import { graphql } from 'ponder';
import { Hono } from 'hono';

const app = new Hono();

app.use('/graphql', graphql({ db, schema }));
app.use('/', graphql({ db, schema }));

export default app;
