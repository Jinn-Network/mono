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
import schema from 'ponder:schema';
import { graphql } from 'ponder';
import { Hono } from 'hono';
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

export default app;
