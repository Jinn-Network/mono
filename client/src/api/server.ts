/**
 * HTTP API server for jinn-client artifact discovery.
 *
 * Uses Hono for routing (enables x402 payment middleware).
 *
 * Routes:
 *   GET  /v1/status  (daemon health, fleet hints, RPC — best-effort)
 *   GET  /artifacts/search?tags=a,b&outcome=SUCCESS&limit=50
 *   GET  /artifacts/:id/content
 *   POST /artifacts  { id, taskId, requestId, title, content, tags, outcome }
 *   GET  /x402/artifacts/:id/content  (payment-gated, if x402 configured)
 */

import { Hono } from 'hono';
import type { Context } from 'hono';
import { cors } from 'hono/cors';
import { serve } from '@hono/node-server';
import { randomUUID, timingSafeEqual } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import type { Server as HttpServer } from 'node:http';
import { dirname, extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Store } from '../store/store.js';
import { addX402Routes, type X402Config } from '../x402/handler.js';
import {
  verifyRequestWithErc8128,
  InMemoryNonceStore,
} from '../auth/erc8128.js';
import { gatherStatusForApi, type StatusGatherConfig } from './gather-status.js';
import type { Corpus, ArtifactContent } from '../corpus/index.js';
import { AcquireError, HashMismatchError } from '../corpus/index.js';
import { addEventsRoutes } from './events-endpoint.js';
import { addBootstrapRoutes } from './bootstrap-endpoint.js';
import { addHandshakeRoutes, requireUiToken } from './handshake.js';
import { addAdminRoutes } from './admin-endpoint.js';
import { addSetupRoutes, type SetupRoutesConfig } from './setup-endpoints.js';

export interface ApiServerConfig {
  port: number;
  /**
   * Bind host. Defaults to `127.0.0.1` so the daemon API is unreachable
   * across the network unless the operator explicitly opts in via
   * `apiBindHost` / `JINN_API_BIND_HOST`. Cost-mutating routes additionally
   * require a bearer token; the bind host is the outer firewall.
   */
  bindHost?: string;
  store: Store;
  /**
   * Bearer token required on cost-mutating routes (`POST /artifacts`,
   * `POST /v1/artifacts/acquire`). Generated at daemon startup (or read
   * from `DAEMON_API_TOKEN`) and threaded into the MCP subprocess via
   * the same env var. Read-only routes (`GET /v1/status`, search,
   * x402 cross-operator content) stay public.
   */
  apiToken: string;
  requireAuth?: boolean;
  onArtifactPublished?: (artifact: { id: string; title: string; tags: string[]; outcome: string }) => void;
  x402?: X402Config;
  /** When set, GET /v1/status includes fleet file + RPC reads. */
  status?: StatusGatherConfig;
  /**
   * Daemon-side Corpus instance. When set, exposes
   * `POST /v1/artifacts/acquire` so the MCP subprocess (and other in-host
   * consumers) can fetch artifacts without ever seeing the agent EOA private
   * key.
   *
   * SECURITY: this route signs x402 payments with the agent EOA. It has no
   * UI authentication; callers need the daemon bearer token. An attacker who
   * can reach this port and token can post fabricated
   * `access.endpoint` URLs and drain the operator's USDC balance via the
   * payment dance.
   *
   * Asymmetry with `search_records` / `inspect_record`: record discovery is
   * keyless (subgraph + IPFS gateway only) and stays client-side in the MCP
   * server. Artifact acquisition is the only path that needs the signing key
   * for x402 payments, so it's the only one that moves to the daemon. See
   * spec/2026-04-30-phase-a-umbrella.md §4.
   */
  corpus?: Corpus | (() => Corpus | undefined);
  /** When set, GET /v1/bootstrap reads <earningDir>/earning_state.json. */
  bootstrap?: { earningDir: string };
  /** Optional panel-driven setup actions such as testnet faucet funding. */
  setup?: SetupRoutesConfig;
  /** When set, /auth/handshake is mounted and SPA-only routes are gated by the token. */
  ui?: { token: string; handshakeKey: string };
  /** Admin endpoint for operator MCP write tools. Only mounted when ui is also configured. */
  admin?: { onRestartRequested: () => void };
}

export interface ApiServer {
  port: number;
  close(): Promise<void>;
  /** Underlying node http.Server, exposed so other subsystems (e.g. agent WS bridge)
   *  can mount on the same port. */
  server: HttpServer;
}

const __dirname = dirname(fileURLToPath(import.meta.url));
const dashboardDir = join(__dirname, '..', 'dashboard');
const assetsDir = join(dashboardDir, 'assets');

function readSpaIndex(): string {
  try {
    return readFileSync(join(dashboardDir, 'index.html'), 'utf-8');
  } catch {
    return '<html><body><p>SPA not built. Run <code>yarn build</code>.</p></body></html>';
  }
}

const ASSET_MIME: Record<string, string> = {
  '.js': 'application/javascript; charset=utf-8',
  '.mjs': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.html': 'text/html; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
};

export async function startApiServer(config: ApiServerConfig): Promise<ApiServer> {
  const { store } = config;
  const app = new Hono();

  app.use(cors());

  // ── Bearer-token gate for cost-mutating routes ─────────────────────────────
  //
  // `POST /artifacts` and `POST /v1/artifacts/acquire` both have side effects
  // that cost the operator (artifact insert; signing x402 payments with the
  // agent EOA). Without auth, an attacker reachable on the daemon API port
  // could fabricate `access.endpoint` URLs and drain USDC. The bearer token
  // is generated at daemon startup (or read from `DAEMON_API_TOKEN`) and
  // forwarded to the MCP subprocess via the same env var. Read-only routes
  // (`GET /v1/status`, `GET /artifacts/search`, `GET /artifacts/:id/content`)
  // and the x402 cross-operator content routes stay public — they are
  // intentionally network-reachable / payment-gated. The ERC-8128 middleware
  // (gated by `requireAuth=true`, never set in prod) layers on top of this.
  const expectedAuth = `Bearer ${config.apiToken}`;
  const expectedBuf = Buffer.from(expectedAuth);
  const requireBearer = async (c: Context, next: () => Promise<void>): Promise<Response | void> => {
    const provided = c.req.header('Authorization') ?? '';
    const providedBuf = Buffer.from(provided);
    let ok = false;
    if (providedBuf.length === expectedBuf.length) {
      try {
        ok = timingSafeEqual(providedBuf, expectedBuf);
      } catch {
        ok = false;
      }
    }
    if (!ok) {
      return c.json({ error: 'unauthorized', reason: 'bearer_required' }, 401);
    }
    await next();
    return;
  };

  // SPA index at /
  app.get('/', (c) => c.html(readSpaIndex()));

  // Static SPA assets emitted by Vite into dist/dashboard/assets/.
  app.get('/assets/:filename', (c) => {
    const filename = c.req.param('filename');
    // Prevent path traversal: filename must not contain separators.
    if (!filename || filename.includes('/') || filename.includes('\\') || filename.includes('..')) {
      return c.notFound();
    }
    const filePath = normalize(join(assetsDir, filename));
    if (!filePath.startsWith(assetsDir)) return c.notFound();
    if (!existsSync(filePath)) return c.notFound();
    const data = readFileSync(filePath);
    const mime = ASSET_MIME[extname(filename).toLowerCase()] ?? 'application/octet-stream';
    return new Response(new Uint8Array(data), { headers: { 'content-type': mime } });
  });

  app.get('/v1/status', async (c) => {
    try {
      const body = await gatherStatusForApi(store, config.status);
      return c.json(body);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return c.json(
        {
          error: 'status_gather_failed',
          message,
          daemon: { shutdownState: store.getShutdownState(), dbPath: store.path },
        },
        500,
      );
    }
  });

  addEventsRoutes(app);

  if (config.bootstrap) {
    addBootstrapRoutes(app, config.bootstrap);
  }

  if (config.ui) {
    addHandshakeRoutes(app, config.ui);
    // Gate SPA-only routes (do NOT gate /v1/status or /artifacts/*).
    app.use('/v1/events', requireUiToken(config.ui.token));
    app.use('/v1/events/*', requireUiToken(config.ui.token));
    app.use('/v1/bootstrap', requireUiToken(config.ui.token));
  }

  if (config.ui && config.admin) {
    app.use('/api/admin/*', requireUiToken(config.ui.token));
    addAdminRoutes(app, config.admin);
  }

  if (config.ui) {
    // Setup routes (claude auth probe + login spawn, keystore password change)
    // gated behind the UI token so external callers can't fingerprint the host
    // or rotate keys.
    app.use('/v1/auth/*', requireUiToken(config.ui.token));
    app.use('/v1/setup/*', requireUiToken(config.ui.token));
    addSetupRoutes(app, config.setup);
  }

  // x402 payment-gated routes (if configured)
  if (config.x402) {
    addX402Routes(app, store, config.x402);
    console.log(`[api] x402 artifact serving enabled`);
  }

  // Bearer-token gate for POST /artifacts. Registered as `app.use` so it
  // runs BEFORE the ERC-8128 middleware (when both are active) — an
  // unauthenticated client gets a `bearer_required` 401 instead of leaking
  // through to ERC-8128's nonce machinery. Method-narrowed to POST so GETs
  // (search, content) stay public.
  app.use('/artifacts', async (c, next) => {
    if (c.req.method !== 'POST') return next();
    return requireBearer(c, next);
  });

  // ERC-8128 auth middleware for POST routes
  const authNonceStore = config.requireAuth ? new InMemoryNonceStore() : null;
  let pendingBody: Record<string, unknown> | null = null;

  if (config.requireAuth) {
    app.use('/artifacts', async (c, next) => {
      if (c.req.method !== 'POST') return next();

      const body = await c.req.text();
      const request = new Request(c.req.url, {
        method: c.req.method,
        headers: c.req.raw.headers,
        body,
      });

      const result = await verifyRequestWithErc8128({ request, nonceStore: authNonceStore! });
      if (!result.ok) {
        return c.json({ error: 'Authentication required (ERC-8128)', reason: result.reason }, 401);
      }

      pendingBody = JSON.parse(body) as Record<string, unknown>;
      return next();
    });
  }

  // GET /artifacts/search
  app.get('/artifacts/search', (c) => {
    const tags = c.req.query('tags')?.split(',').filter(Boolean);
    const outcome = c.req.query('outcome') ?? undefined;
    const requestId = c.req.query('requestId') ?? undefined;
    const taskId = c.req.query('taskId') ?? undefined;
    const after = c.req.query('after') ?? undefined;
    const before = c.req.query('before') ?? undefined;
    const limit = c.req.query('limit') ? parseInt(c.req.query('limit')!) : undefined;

    const results = store.searchArtifacts({ tags, outcome, requestId, taskId, after, before, limit });
    return c.json({ results });
  });

  // GET /artifacts/:id/content (free, no payment gate)
  app.get('/artifacts/:id/content', (c) => {
    const id = c.req.param('id');
    const content = store.resolveCatalogArtifactContent(id);
    if (content === null) {
      return c.json({ error: 'Artifact not found or no content' }, 404);
    }
    return c.json({ id, content });
  });

  // POST /artifacts (bearer gate via app.use above; ERC-8128 layered on top
  // when requireAuth=true). The middleware order means bearer fails first.
  app.post('/artifacts', async (c) => {
    const body = pendingBody ?? await c.req.json<Record<string, unknown>>();
    pendingBody = null;

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
      taskId: (body.taskId as string) ?? '',
      requestId: (body.requestId as string) ?? '',
      title,
      content,
      tags,
      outcome: outcome as 'SUCCESS' | 'FAILURE' | 'UNKNOWN',
    });

    config.onArtifactPublished?.({ id, title, tags, outcome });
    return c.json({ id, published: true }, 201);
  });

  // ── POST /v1/artifacts/acquire ─────────────────────────────────────────────
  //
  // Daemon-side acquire endpoint (jinn-mono-vy37.1.6). The MCP subprocess
  // proxies its `acquire_artifact` tool through this route so the agent EOA
  // private key required for x402 payments never leaves daemon process
  // memory. Localhost-only — see api server bind host below; this route MUST
  // NOT be exposed across the network without an auth layer because the
  // daemon will sign x402 payments on the caller's behalf.
  //
  // Asymmetry with `search_records` / `inspect_record`: record lookup stays
  // client-side because subgraph queries and IPFS manifest fetches are keyless.
  // Only the buyer side of x402 needs the signing key, so only the buyer path
  // moves here.
  // See spec/2026-04-30-phase-a-umbrella.md §4.
  if (config.corpus) {
    const resolveCorpus = (): Corpus | undefined =>
      typeof config.corpus === 'function' ? config.corpus() : config.corpus;
    // Single-flight: dedupe concurrent acquires for the same sha256 so two
    // MCP tool calls within the same restoration don't double-pay or race
    // the cache. Map entries clear themselves once the inner promise settles.
    const inFlight = new Map<string, Promise<ArtifactContent>>();

    app.post('/v1/artifacts/acquire', requireBearer, async (c) => {
      const corpus = resolveCorpus();
      if (!corpus) {
        return c.json(
          { ok: false, reason: 'corpus_unavailable', error: 'corpus is not ready', retryable: true },
          503,
        );
      }
      let body: Record<string, unknown>;
      try {
        body = await c.req.json<Record<string, unknown>>();
      } catch {
        return c.json({ ok: false, reason: 'invalid_args', error: 'invalid JSON body', retryable: false }, 400);
      }

      const sha256 = body['sha256'];
      const access = body['access'] as { endpoint?: unknown; priceUsdc?: unknown } | undefined;
      const envelopeCid = body['envelopeCid'];
      const artifactType = body['artifactType'];

      if (typeof sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(sha256)) {
        return c.json(
          { ok: false, reason: 'invalid_args', error: 'sha256 must be a 64-char hex string', retryable: false },
          400,
        );
      }
      if (
        !access ||
        typeof access.endpoint !== 'string' ||
        typeof access.priceUsdc !== 'string'
      ) {
        return c.json(
          { ok: false, reason: 'invalid_args', error: 'access.endpoint and access.priceUsdc are required strings', sha256, retryable: false },
          400,
        );
      }

      const accessNormalized = { endpoint: access.endpoint, priceUsdc: access.priceUsdc };
      const hint: { artifactType?: string; envelopeCid?: string } = {};
      if (typeof artifactType === 'string') hint.artifactType = artifactType;
      if (typeof envelopeCid === 'string') hint.envelopeCid = envelopeCid;

      const existing = inFlight.get(sha256);
      const acquirePromise = existing ?? corpus.acquireBySha256(sha256, accessNormalized, hint);
      if (!existing) inFlight.set(sha256, acquirePromise);
      try {
        const out = await acquirePromise;
        return c.json({
          ok: true,
          sha256: out.sha256,
          content: out.bytes.toString('base64'),
          artifactType: out.artifactType,
          source: out.source,
          paidAmountUsdc: out.paidAmountUsdc,
          fetchedAt: out.fetchedAt,
          ...(out.sourceOperator ? { sourceOperator: out.sourceOperator } : {}),
        });
      } catch (err) {
        if (err instanceof HashMismatchError) {
          return c.json(
            {
              ok: false,
              reason: 'hash_mismatch',
              sha256,
              error: err.message,
              sha256Expected: err.sha256Expected,
              sha256Actual: err.sha256Actual,
              source: err.source,
              ...(err.sourceOperator ? { sourceOperator: err.sourceOperator } : {}),
              retryable: false,
            },
            422,
          );
        }
        if (err instanceof AcquireError) {
          return c.json(
            { ok: false, reason: 'origin_null', sha256, error: err.message, retryable: true },
            502,
          );
        }
        const message = err instanceof Error ? err.message : String(err);
        return c.json(
          { ok: false, reason: 'origin_null', sha256, error: message, retryable: true },
          500,
        );
      } finally {
        // Clear single-flight entry only when we created it, so concurrent
        // callers awaiting the same promise still receive the resolved result.
        if (!existing) inFlight.delete(sha256);
      }
    });
  }

  // SPA fallback: any unmatched non-API GET path returns the SPA index.
  // Lets the SPA own client-side routing without 404s on deep links.
  app.get('*', (c) => {
    const path = c.req.path;
    if (
      path.startsWith('/v1') ||
      path.startsWith('/artifacts') ||
      path.startsWith('/auth') ||
      path.startsWith('/api') ||
      path.startsWith('/x402') ||
      path.startsWith('/assets')
    ) {
      return c.notFound();
    }
    return c.html(readSpaIndex());
  });

  return new Promise((resolve, reject) => {
    const server = serve({
      fetch: app.fetch,
      port: config.port,
      hostname: config.bindHost ?? '127.0.0.1',
    }, () => {
      const addr = server.address();
      const actualPort = (typeof addr === 'object' && addr) ? addr.port : config.port;
      console.log(`[api] Listening on port ${actualPort}`);
      if (config.ui) {
        const handshakeUrl = `http://127.0.0.1:${actualPort}/?k=${config.ui.handshakeKey}`;
        console.log(`[api] UI handshake URL: ${handshakeUrl}`);
      }
      resolve({
        port: actualPort,
        close: () => new Promise<void>((res) => server.close(() => res())),
        // serve() returns Server | Http2Server | Http2SecureServer; we never
        // pass http2/https opts so it's always a node http.Server at runtime.
        server: server as HttpServer,
      });
    });

    // Handle server errors (EADDRINUSE, socket errors, etc.) so they don't
    // crash the process as unhandled 'error' events on the EventEmitter.
    server.on('error', (err) => {
      reject(err);
    });
  });
}
