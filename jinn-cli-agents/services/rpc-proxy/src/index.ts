import 'dotenv/config';
import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { serve } from '@hono/node-server';
import { loadConfig } from './config.js';
import { createAuthMiddleware } from './auth.js';
import { UpstreamPool } from './upstream.js';
import { createProxyHandler } from './proxy.js';

const config = loadConfig();
const pool = new UpstreamPool(config.upstreamUrls, 30_000, config.requestTimeoutMs);

const app = new Hono();
app.use('/*', cors());

// Health check — public, no auth
app.get('/health', (c) =>
  c.json({
    status: 'ok',
    service: 'rpc-proxy',
    upstreams: pool.getStatus(),
    timestamp: new Date().toISOString(),
  }),
);

// All POST traffic — auth required when token is configured
if (config.bearerToken) {
  app.use('/*', createAuthMiddleware(config.bearerToken));
}
app.post('/', createProxyHandler(pool));

// Background health check
setInterval(() => pool.healthCheck(), config.healthCheckIntervalMs);
setTimeout(() => pool.healthCheck(), 5_000);

serve({ fetch: app.fetch, port: config.port }, () => {
  console.log(`[rpc-proxy] Listening on :${config.port}`);
  console.log(`[rpc-proxy] ${config.upstreamUrls.length} upstream(s) configured`);
});
