/**
 * HTTP API server for jinn-client artifact discovery.
 *
 * Exposes local artifacts to peer nodes. Mutations require ERC-8128 auth.
 *
 * Routes:
 *   GET  /artifacts/search?tags=a,b&outcome=SUCCESS&limit=50
 *   GET  /artifacts/:id/content
 *   POST /artifacts  { id, desiredStateId, requestId, title, content, tags, outcome }
 */

import { createServer, type Server, type IncomingMessage, type ServerResponse } from 'node:http';
import { randomUUID } from 'node:crypto';
import type { Store } from '../store/store.js';
import {
  verifyRequestWithErc8128,
  InMemoryNonceStore,
  type NonceStore,
} from '../auth/erc8128.js';

export interface ApiServerConfig {
  port: number;
  store: Store;
  requireAuth?: boolean; // default true for mutations
}

export interface ApiServer {
  port: number;
  close(): Promise<void>;
}

export async function startApiServer(config: ApiServerConfig): Promise<ApiServer> {
  const { store } = config;
  const nonceStore = new InMemoryNonceStore();

  const server = createServer(async (req, res) => {
    try {
      await handleRequest(req, res, store, nonceStore, config.requireAuth ?? true);
    } catch (err) {
      console.error('[api] Unhandled error:', err);
      sendJson(res, 500, { error: 'Internal server error' });
    }
  });

  return new Promise((resolve) => {
    server.listen(config.port, '0.0.0.0', () => {
      const addr = server.address();
      const port = typeof addr === 'object' && addr ? addr.port : config.port;
      console.log(`[api] Listening on port ${port}`);
      resolve({
        port,
        close: () => new Promise<void>((res) => server.close(() => res())),
      });
    });
  });
}

async function handleRequest(
  req: IncomingMessage,
  res: ServerResponse,
  store: Store,
  nonceStore: NonceStore,
  requireAuth: boolean,
): Promise<void> {
  const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
  const method = req.method ?? 'GET';

  // CORS
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, Signature, Signature-Input, Content-Digest');
  if (method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  // GET /artifacts/search
  if (method === 'GET' && url.pathname === '/artifacts/search') {
    const tags = url.searchParams.get('tags')?.split(',').filter(Boolean);
    const outcome = url.searchParams.get('outcome') ?? undefined;
    const limit = url.searchParams.has('limit') ? parseInt(url.searchParams.get('limit')!) : undefined;

    const results = store.searchArtifacts({ tags, outcome, limit });
    sendJson(res, 200, { results });
    return;
  }

  // GET /artifacts/:id/content
  const contentMatch = url.pathname.match(/^\/artifacts\/([^/]+)\/content$/);
  if (method === 'GET' && contentMatch) {
    const id = contentMatch[1];
    const content = store.getArtifactContent(id);
    if (content === null) {
      sendJson(res, 404, { error: 'Artifact not found or no content' });
      return;
    }
    sendJson(res, 200, { id, content });
    return;
  }

  // POST /artifacts
  if (method === 'POST' && url.pathname === '/artifacts') {
    // Auth check for mutations
    if (requireAuth) {
      const verified = await verifyIncomingRequest(req, nonceStore);
      if (!verified) {
        sendJson(res, 401, { error: 'Authentication required (ERC-8128)' });
        return;
      }
    }

    const body = await readBody(req);
    if (!body) {
      sendJson(res, 400, { error: 'Request body required' });
      return;
    }

    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(body);
    } catch {
      sendJson(res, 400, { error: 'Invalid JSON' });
      return;
    }

    const id = (parsed.id as string) ?? randomUUID();
    const title = parsed.title as string;
    const content = parsed.content as string;
    const tags = (parsed.tags as string[]) ?? [];
    const outcome = (parsed.outcome as string) ?? 'UNKNOWN';

    if (!title || !content) {
      sendJson(res, 400, { error: 'title and content are required' });
      return;
    }

    store.insertArtifact({
      id,
      desiredStateId: (parsed.desiredStateId as string) ?? '',
      requestId: (parsed.requestId as string) ?? '',
      title,
      content,
      tags,
      outcome: outcome as 'SUCCESS' | 'FAILURE' | 'UNKNOWN',
    });

    sendJson(res, 201, { id, published: true });
    return;
  }

  // 404
  sendJson(res, 404, { error: 'Not found' });
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function sendJson(res: ServerResponse, status: number, data: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(data));
}

function readBody(req: IncomingMessage): Promise<string | null> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      if (chunks.length === 0) {
        resolve(null);
        return;
      }
      resolve(Buffer.concat(chunks).toString('utf-8'));
    });
    req.on('error', () => resolve(null));
  });
}

async function verifyIncomingRequest(
  req: IncomingMessage,
  nonceStore: NonceStore,
): Promise<string | null> {
  if (!req.headers['signature']) {
    return null;
  }

  try {
    const body = await readBody(req);
    const url = `http://${req.headers.host ?? 'localhost'}${req.url ?? '/'}`;
    const headers = new Headers();
    for (const [key, value] of Object.entries(req.headers)) {
      if (typeof value === 'string') headers.set(key, value);
    }

    const request = new Request(url, {
      method: req.method,
      headers,
      body: body && req.method !== 'GET' ? body : undefined,
    });

    const result = await verifyRequestWithErc8128({ request, nonceStore });
    if (result.ok) {
      return result.address;
    }
    return null;
  } catch {
    return null;
  }
}
