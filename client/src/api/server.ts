/**
 * HTTP API server for jinn-client artifact discovery.
 *
 * Uses Hono for routing (enables x402 payment middleware).
 *
 * Routes:
 *   GET  /artifacts/search?tags=a,b&outcome=SUCCESS&limit=50
 *   GET  /artifacts/:id/content
 *   POST /artifacts  { id, desiredStateId, requestId, title, content, tags, outcome }
 *   GET  /x402/artifacts/:id/content  (payment-gated, if x402 configured)
 */

import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { serve } from '@hono/node-server';
import { randomUUID } from 'node:crypto';
import type { Store } from '../store/store.js';
import { addX402Routes, type X402Config } from '../x402/handler.js';

export interface ApiServerConfig {
  port: number;
  store: Store;
  requireAuth?: boolean;
  onArtifactPublished?: (artifact: { id: string; title: string; tags: string[]; outcome: string }) => void;
  x402?: X402Config;
}

export interface ApiServer {
  port: number;
  close(): Promise<void>;
}

export async function startApiServer(config: ApiServerConfig): Promise<ApiServer> {
  const { store } = config;
  const app = new Hono();

  app.use(cors());

  // x402 payment-gated routes (if configured)
  if (config.x402) {
    addX402Routes(app, store, config.x402);
    console.log(`[api] x402 artifact serving enabled`);
  }

  // GET /artifacts/search
  app.get('/artifacts/search', (c) => {
    const tags = c.req.query('tags')?.split(',').filter(Boolean);
    const outcome = c.req.query('outcome') ?? undefined;
    const limit = c.req.query('limit') ? parseInt(c.req.query('limit')!) : undefined;

    const results = store.searchArtifacts({ tags, outcome, limit });
    return c.json({ results });
  });

  // GET /artifacts/:id/content (free, no payment gate)
  app.get('/artifacts/:id/content', (c) => {
    const id = c.req.param('id');
    const content = store.getArtifactContent(id);
    if (content === null) {
      return c.json({ error: 'Artifact not found or no content' }, 404);
    }
    return c.json({ id, content });
  });

  // POST /artifacts
  app.post('/artifacts', async (c) => {
    const body = await c.req.json<Record<string, unknown>>();

    const id = (body.id as string) ?? randomUUID();
    const title = body.title as string;
    const content = body.content as string;
    const tags = (body.tags as string[]) ?? [];
    const outcome = (body.outcome as string) ?? 'UNKNOWN';

    if (!title || !content) {
      return c.json({ error: 'title and content are required' }, 400);
    }

    store.insertArtifact({
      id,
      desiredStateId: (body.desiredStateId as string) ?? '',
      requestId: (body.requestId as string) ?? '',
      title,
      content,
      tags,
      outcome: outcome as 'SUCCESS' | 'FAILURE' | 'UNKNOWN',
    });

    config.onArtifactPublished?.({ id, title, tags, outcome });
    return c.json({ id, published: true }, 201);
  });

  return new Promise((resolve) => {
    const server = serve({
      fetch: app.fetch,
      port: config.port,
      hostname: '0.0.0.0',
    }, () => {
      console.log(`[api] Listening on port ${config.port}`);
      resolve({
        port: config.port,
        close: () => new Promise<void>((res) => server.close(() => res())),
      });
    });
  });
}
