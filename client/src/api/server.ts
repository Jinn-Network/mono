/**
 * HTTP API server for jinn-client artifact discovery.
 *
 * Uses Hono for routing.
 *
 * Routes:
 *   GET  /v1/status  (daemon health, fleet hints, RPC — best-effort)
 *   GET  /artifacts/search?tags=a,b&outcome=SUCCESS&limit=50
 *   GET  /artifacts/:id/content
 *   POST /artifacts  { id, taskId, requestId, title, content, tags, outcome }
 */

import { Hono } from 'hono';
import type { Context, MiddlewareHandler } from 'hono';
import { cors } from 'hono/cors';
import { serve } from '@hono/node-server';
import { randomUUID, timingSafeEqual } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import type { Server as HttpServer } from 'node:http';
import { dirname, extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Store } from '../store/store.js';
import {
  verifyRequestWithErc8128,
  InMemoryNonceStore,
} from '../auth/erc8128.js';
import { gatherStatusForApi, type StatusGatherConfig } from './gather-status.js';
import type { Corpus, ArtifactContent } from '../corpus/index.js';
import { AcquireError, HashMismatchError } from '../corpus/index.js';
import type { ArtifactSource } from '../types/envelope.js';
import { addEventsRoutes } from './events-endpoint.js';
import { addActivityEventsRoutes } from './activity-events-endpoint.js';
import { addBootstrapRoutes, type BootstrapEndpointConfig } from './bootstrap-endpoint.js';
import { addSolverNetsRoutes, type SolverNetsRegistry } from './solvernets-endpoint.js';
import {
  registerSolverNetsEndpoints,
  type SolverNetsEndpointsDeps,
} from './solvernets-endpoints.js';
import { addAgentBindingRoutes, type AgentBindingRoutesConfig } from './agent-binding-endpoint.js';
import { addHandshakeRoutes, requireUiToken } from './handshake.js';
import { addAdminRoutes } from './admin-endpoint.js';
import { addSetupRoutes, type SetupRoutesConfig } from './setup-endpoints.js';
import { addClaimPolicyRoutes, type ClaimPolicyRoutesConfig } from './claim-policy-endpoints.js';
import { addHarnessStatusRoutes, type HarnessStatusDeps } from './harness-status-endpoint.js';
import { addHarnessReadinessRoutes } from './harness-readiness-endpoint.js';
import { addHarnessAuthStatusRoutes } from './harness-auth-status-endpoint.js';
import type { HarnessReadinessRegistry } from '../harnesses/readiness-registry.js';
import { addHermesDoctorRoutes, type HermesDoctorConfig } from './hermes-doctor-endpoint.js';
import { addCodexDoctorRoutes, type CodexDoctorConfig } from './codex-doctor-endpoint.js';
import { addLauncherRoutes, type LauncherRoutesDeps } from './launcher-endpoints.js';
import {
  addOperatorArtifactsRoutes,
  type OperatorArtifactsRoutesConfig,
} from './operator-artifacts-endpoint.js';
import { addStopHookRoutes, type StopHookRoutesDeps } from './stop-hook.js';
import { addCapturesRoutes, type CapturesRoutesDeps } from './captures.js';
import { addDiscoveryRoutes } from './discovery-endpoint.js';
import type { DiscoveryAPI } from '../discovery/types.js';
import { addDebugReportRoutes, type DebugReportRoutesConfig } from './debug-report-endpoint.js';
import { addRewardsRoutes } from './rewards-endpoint.js';

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
   * artifact content) stay public.
   */
  apiToken: string;
  requireAuth?: boolean;
  onArtifactPublished?: (artifact: { id: string; title: string; tags: string[]; outcome: string }) => void;
  /** When set, GET /v1/status includes fleet file + RPC reads. */
  status?: StatusGatherConfig;
  /**
   * Daemon-side Corpus instance. When set, exposes
   * `POST /v1/artifacts/acquire` so the MCP subprocess (and other in-host
   * consumers) can fetch artifacts. Bearer-token gated like `POST /artifacts`.
   *
   * Asymmetry with `search_records` / `inspect_record`: record discovery is
   * keyless (subgraph/on-chain reads + IPFS gateway) and stays client-side in
   * the MCP server; artifact acquisition is a free fetch routed through the
   * daemon so the byte cache lives in one place.
   * See spec/2026-04-30-phase-a-umbrella.md §4.
   */
  corpus?: Corpus | (() => Corpus | undefined);
  /** When set, GET /v1/bootstrap reads <earningDir>/earning_state.json. */
  bootstrap?: BootstrapEndpointConfig;
  /** Optional panel-driven setup actions such as testnet faucet funding. */
  setup?: SetupRoutesConfig;
  /** When set, mounts the §2.15 Claim policy & wiring endpoints (GET/PUT). */
  claimPolicy?: ClaimPolicyRoutesConfig;
  /**
   * Launcher mode routes (`/v1/launcher/*`). Mounted only when supplied so
   * tests and bootstrap-only API instances don't pay the deps wiring cost.
   * Gated by the same UI token as `/v1/setup/*` — see the `app.use` block
   * inside `startApiServer` below.
   */
  launcher?: LauncherRoutesDeps;
  /** When set, GET /v1/solvernets exposes the catalog from a daemon registry. */
  solverNets?: { registry: SolverNetsRegistry };
  /**
   * jinn-mono-hqz0: SolverNet creation/launch endpoints (drafts CRUD,
   * launched CRUD, registry list/by-cid). Deps are populated AFTER
   * startApiServer returns (the SolverNet subsystem in main.ts depends on
   * post-bootstrap state), so we accept a holder ref. Routes register
   * eagerly here and dereference `holder.current` per-request, returning
   * 503 until the holder is populated.
   */
  solverNetsLauncher?: { holder: { current: SolverNetsEndpointsDeps | undefined } };
  /** When set, POST /v1/setup/agent-binding/retry is mounted so the SPA can
   *  retry the ERC-1271 bind step for unbound services. */
  agentBinding?: AgentBindingRoutesConfig;
  /**
   * When set, `/auth/handshake` is mounted and operator-class routes are
   * gated on the SPA's cookie/header session token EXCLUSIVELY (the bearer
   * `apiToken` does not admit here — the two credential planes never merge,
   * see the gate comment in `startApiServer`). When absent, the gate falls
   * back to the bearer `apiToken` — the only construction paths without
   * `ui` are `daemon.ts`'s self-start branch and test/embedded callers, on
   * which the bearer is the sole available credential. The gate itself is
   * unconditional (§14.3): the SPA-only route families and `/v1/events` /
   * `/v1/activity-events` are token-gated on every construction path.
   */
  ui?: { token: string; handshakeKey: string };
  /** Admin endpoint for operator MCP write tools. Only mounted when ui is also configured. */
  admin?: {
    onRestartRequested: (opts: { forceRespawn?: boolean }) => void;
    onStopRequested: () => void;
  };
  /**
   * When set, mounts `GET /api/harness/status` under the UI token gate.
   * Powers the dashboard's HarnessStatusPanel (mode + codeDigest + lastModeSwitchAt).
   */
  harnessStatus?: HarnessStatusDeps;
  /**
   * When set, mounts `GET /v1/harnesses/readiness` and
   * `GET /v1/harnesses/:name/readiness` under the UI token gate.
   * SPA polls the composed endpoint; the join flow uses the per-harness one.
   *
   * Accepts either a direct registry or a holder ref (same pattern as
   * solverNetsLauncher). main.ts uses the holder shape because the registry is
   * constructed post-bootstrap; routes register eagerly at server start so
   * Hono's matcher includes them before the first request — adding routes
   * after the matcher is built throws (jinn-mono-u34i field repro).
   */
  harnessReadinessRegistry?:
    | HarnessReadinessRegistry
    | { holder: { current: HarnessReadinessRegistry | undefined } };
  /**
   * When set, mounts `GET /api/hermes/doctor` under the UI token gate.
   * Powers the dashboard's Hermes install precheck panel in the join flow.
   */
  hermesDoctor?: HermesDoctorConfig;
  /**
   * When set, mounts `GET /api/codex/doctor` under the UI token gate.
   * Powers the dashboard's Codex install precheck panel in the join flow.
   */
  codexDoctor?: CodexDoctorConfig;
  /** Operator-local artifact inventory + future-artifact pricing controls. */
  operatorArtifacts?: Omit<OperatorArtifactsRoutesConfig, 'store'>;
  /** Path D local session-end hook endpoint. */
  stopHook?: StopHookRoutesDeps;
  /** Operator review API for pending captures. */
  captures?: CapturesRoutesDeps;
  /**
   * Discovery API. Mounts GET /v1/discovery/* routes that proxy DiscoveryAPI
   * methods (listPluginPublications, listBuilderArtifacts, getPluginScores)
   * so the SPA's /build route can fetch them without direct GraphQL or RPC
   * access.
   *
   * Accepts either a direct instance or a holder ref (same pattern as
   * solverNetsLauncher / harnessReadinessRegistry). main.ts uses the holder
   * shape because the daemon's DiscoveryAPI is constructed post-bootstrap;
   * routes register eagerly at server start so Hono's matcher includes them
   * before the first request. Without this, every /v1/discovery/* request
   * gets a 404 forever, and the /build page renders "Discovery unavailable"
   * permanently (jinn-mono-u34i field repro).
   */
  discovery?:
    | DiscoveryAPI
    | { holder: { current: DiscoveryAPI | undefined } };
  /**
   * One-click operator debug report (issue #420). When set, mounts
   * `GET /v1/debug-report/manifest` + `POST /v1/debug-report` under the UI
   * token gate. The bundle assembler reads the live resolved config so the
   * download reflects env overrides + defaults, not just the on-disk file.
   */
  debugReport?: DebugReportRoutesConfig;
}

export interface ApiServer {
  port: number;
  close(): Promise<void>;
  /** Underlying node http.Server, exposed so other subsystems (e.g. agent WS bridge)
   *  can mount on the same port. */
  server: HttpServer;
  /** Hono app, exposed so subsystems initialised AFTER startApiServer (e.g. the
   *  SolverNet subsystem in main.ts) can mount their routes on the same instance.
   *  See jinn-mono-hqz0. */
  app: Hono;
  /**
   * Replace the `status` config the GET /v1/status handler reads. The
   * setup-mode server starts before the running-mode config (spendCaps,
   * aiUnits) is built; the daemon calls this on construction so the
   * running-mode status block is served. Without this, the running-mode
   * config — including the AI-units gate per-credential view and the
   * spend-cap view — is silently dropped.
   */
  setStatusConfig(status: StatusGatherConfig | undefined): void;
}

const __dirname = dirname(fileURLToPath(import.meta.url));

/**
 * Resolve the operator dashboard directory.
 *
 * jinn-client is meant to be installed as a package and run via the `jinn`
 * binary, which executes the compiled `dist/` tree — there `__dirname` is
 * `dist/api/` and the SPA lives at `dist/dashboard/`.
 *
 * Repo contributors running `yarn jinn run` (tsx + src/) do not have
 * `dist/dashboard/` next to `src/api/`. They build the SPA into
 * `src/dashboard/spa/dist/` via `yarn build:spa`. We try both so the dev
 * loop produces the same UI as production after a single SPA build.
 *
 * If neither candidate has an `index.html`, the daemon emits a clear error
 * page rather than silently serving stale or missing assets.
 */
function resolveDashboardDir(): string | null {
  const candidates = [
    join(__dirname, '..', 'dashboard'),                  // packaged: dist/api/.. = dist/dashboard
    join(__dirname, '..', 'dashboard', 'spa', 'dist'),   // dev: src/api/.. = src/dashboard/spa/dist
  ];
  for (const candidate of candidates) {
    if (existsSync(join(candidate, 'index.html'))) {
      return candidate;
    }
  }
  return null;
}

const dashboardDir = resolveDashboardDir() ?? join(__dirname, '..', 'dashboard');
const assetsDir = join(dashboardDir, 'assets');

/**
 * Resolve the `JINN_ENABLE_EMBEDDED_AGENT` env var. Default off. Anything
 * other than `1` / `true` (case-insensitive) is treated as off so a stray
 * value can't accidentally re-enable the surface.
 *
 * Issue #367: this also has a daemon-side consumer (`main.ts` gates the
 * `/api/agent/ws` bridge on it), so it stays a standalone helper rather than
 * being inlined into `resolveFeatureFlags`.
 */
export function isEmbeddedAgentEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const raw = env['JINN_ENABLE_EMBEDDED_AGENT'];
  if (raw === undefined) return false;
  const normalized = raw.trim().toLowerCase();
  return normalized === '1' || normalized === 'true';
}

/**
 * Resolve the operator-app feature flags from the daemon environment.
 *
 * Each flag is derived from a `JINN_ENABLE_*` env var ("1" enables). The SPA
 * reads the injected `window.__JINN_FEATURES__` via `lib/features.ts`; absent
 * or partial injection is treated as all-off there, so this can stay a flat
 * boolean record.
 *
 * Issue #327: `pluginBuilderUi` gates the operator-app builder surfaces
 * (`/build` route + Build top-tab). Default-off until the first-run UX is
 * solid; the plug-in substrate (CLI verbs, indexer, Discovery API, docs)
 * stays live regardless.
 *
 * Issue #326 / #367: `embeddedAgent` gates the embedded Claude agent chat
 * surface (operating-shell rail + onboarding "Ask Claude" panel). Migrated
 * here from the `/v1/bootstrap` JSON response so the operator app has a single
 * feature-flag channel — see #367.
 */
function resolveFeatureFlags(): Record<string, boolean> {
  return {
    pluginBuilderUi: process.env['JINN_ENABLE_PLUGIN_BUILDER_UI'] === '1',
    embeddedAgent: isEmbeddedAgentEnabled(),
  };
}

/**
 * Inject the feature-flag bootstrap script into the SPA `index.html`.
 *
 * The script sets `window.__JINN_FEATURES__` before the SPA module loads, so
 * the first render already sees the flags. Inserted immediately before the
 * SPA's `<script type="module">` tag; if that tag is missing the script is
 * appended before `</head>` (or `</body>`) so the SPA still gets it.
 *
 * Exported for unit testing — the runtime call lives in `readSpaIndex`.
 */
export function injectFeatureFlags(html: string, features: Record<string, boolean>): string {
  const script = `<script>window.__JINN_FEATURES__=${JSON.stringify(features)};</script>`;
  const moduleTagMatch = html.match(/<script\b[^>]*type=["']module["'][^>]*>/i);
  if (moduleTagMatch?.index !== undefined) {
    return html.slice(0, moduleTagMatch.index) + script + html.slice(moduleTagMatch.index);
  }
  if (html.includes('</head>')) {
    return html.replace('</head>', `${script}</head>`);
  }
  if (html.includes('</body>')) {
    return html.replace('</body>', `${script}</body>`);
  }
  return html + script;
}

function readSpaIndex(): string {
  try {
    const html = readFileSync(join(dashboardDir, 'index.html'), 'utf-8');
    return injectFeatureFlags(html, resolveFeatureFlags());
  } catch {
    return [
      '<!doctype html><html><body style="font-family:system-ui;padding:2rem;max-width:48rem;line-height:1.5">',
      '<h1>jinn dashboard bundle missing</h1>',
      '<p>jinn-client is meant to be installed as a published package and launched via the <code>jinn</code> binary. ',
      'On a healthy install, the operator dashboard ships inside the package.</p>',
      '<p>If you installed jinn from npm and are seeing this page, the package is corrupted — re-install it.</p>',
      '<p>If you are running from a checkout of this repo (e.g. <code>yarn jinn run</code>), build the SPA first:</p>',
      '<pre>yarn build         # full build (recommended)\nyarn build:spa     # SPA only</pre>',
      '<p>Then re-run <code>jinn run</code>.</p>',
      '</body></html>',
    ].join('');
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

function parseArtifactSources(value: unknown): ArtifactSource[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) return undefined;
  const sources: ArtifactSource[] = [];
  for (const raw of value) {
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return undefined;
    const source = raw as Record<string, unknown>;
    if (
      source['kind'] !== 'ipfs' ||
      typeof source['cid'] !== 'string' ||
      typeof source['sha256'] !== 'string' ||
      !/^[0-9a-f]{64}$/.test(source['sha256']) ||
      source['encoding'] !== 'jinn.artifact.donation.v1'
    ) {
      return undefined;
    }
    sources.push({
      kind: 'ipfs',
      cid: source['cid'],
      sha256: source['sha256'],
      encoding: 'jinn.artifact.donation.v1',
    });
  }
  return sources;
}

export async function startApiServer(config: ApiServerConfig): Promise<ApiServer> {
  const { store } = config;
  const app = new Hono();

  // The /v1/status handler reads from this holder, not the closure-captured
  // `config.status`, so the daemon can swap the running-mode config in after
  // the server is already up. See `setStatusConfig` on the returned object.
  let liveStatus: StatusGatherConfig | undefined = config.status;

  // Global CORS EXCEPT `/api/stop-hook` (§14.1): that route now requires the
  // `DAEMON_API_TOKEN` bearer (see the gate below), but a bearer credential
  // isn't ambiently attached to cross-origin fetches the way a cookie is —
  // scoping CORS away from it is defense-in-depth, not the auth boundary.
  app.use(async (c, next) => {
    if (c.req.path === '/api/stop-hook') return next();
    return cors()(c, next);
  });

  // ── Bearer-token check for cost-mutating / operator-class routes ────────────
  //
  // `POST /artifacts` and `POST /v1/artifacts/acquire` both have side effects
  // (artifact insert; outbound fetch of an arbitrary `access.endpoint` plus a
  // cache write). Without auth, an attacker reachable on the daemon API port
  // could fabricate `access.endpoint` URLs and drive the daemon's fetcher. The
  // bearer token is generated at daemon startup (or read from
  // `DAEMON_API_TOKEN`) and forwarded to the MCP subprocess via the same env
  // var. Read-only routes (`GET /v1/status`, `GET /artifacts/search`,
  // `GET /artifacts/:id/content`) stay public — they are intentionally
  // network-reachable. The ERC-8128 middleware (gated by `requireAuth=true`,
  // never set in prod) layers on top of this.
  const expectedAuth = `Bearer ${config.apiToken}`;
  const expectedBuf = Buffer.from(expectedAuth);
  const bearerValid = (c: Context): boolean => {
    const provided = c.req.header('Authorization') ?? '';
    const providedBuf = Buffer.from(provided);
    if (providedBuf.length !== expectedBuf.length) return false;
    try {
      return timingSafeEqual(providedBuf, expectedBuf);
    } catch {
      return false;
    }
  };
  const requireBearer = async (c: Context, next: () => Promise<void>): Promise<Response | void> => {
    if (!bearerValid(c)) {
      return c.json({ error: 'unauthorized', reason: 'bearer_required' }, 401);
    }
    await next();
    return;
  };

  // ── Unconditional operator-class auth gate (§4.3 / §14.3) ───────────────
  //
  // Every route on this listener is `operator`-class (token-gated,
  // regardless of bind address) except a fixed allowlist: `/`, `/assets/*`,
  // `/auth/handshake`, `/artifacts*` (the bearer regime — scoped by §4.2's
  // disposition table to artifacts + stop-hook ONLY, never the general
  // operator-class routes below), and — for now — `GET /v1/status` (its
  // exemption is removed by a LATER package per §14.5, once `/health` +
  // `/ready` land as the unauthenticated-safe liveness surface; do NOT gate
  // it here).
  //
  // This block runs UNCONDITIONALLY — independent of whether `config.ui`
  // was supplied — so a construction path that skips `ui` (`daemon.ts`'s
  // self-start branch when `config.apiServer` is absent, or a bare
  // `startApiServer({ apiToken })` test/embedded call) does not leave the
  // SPA-only route families (nor `/v1/events` / `/v1/activity-events`,
  // which used to be mounted OUTSIDE this block entirely) unauthenticated.
  //
  // The two credential planes do NOT merge: when `config.ui` is configured
  // (every production boot via main.ts), ONLY the ui-token grants access —
  // the bearer `apiToken` sits in every spawned solver agent's own process
  // env (learner adapters' spawnOpts.env, Hermes' bootstrap .env file), so
  // admitting it here would let any agent reach change-password, admin
  // restart/stop, claim-policy/wiring writes, captures approve (publishes),
  // network config, faucet drip (real tx), join/leave, debug-report,
  // rewards, etc. — routes §4.2's disposition table classes `Control`,
  // never `bearer`-gated. The bearer only ever buys the no-`ui`
  // self-start/test path, where it's the sole available credential.
  const requireOperatorToken: MiddlewareHandler = config.ui
    ? requireUiToken(config.ui.token)
    : requireBearer;

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
      // Thread the live HarnessReadinessRegistry through to gather-status so
      // the response carries a `harness` rollup. main.ts uses the holder shape
      // (registry is constructed post-bootstrap); dereferencing once per
      // request keeps server.ts decoupled from that timing. When the holder
      // is empty (pre-bootstrap) the getter returns null and the assembler
      // defaults to ready.
      const reg = config.harnessReadinessRegistry;
      const getRegistry = (): HarnessReadinessRegistry | null =>
        reg && 'holder' in reg ? (reg.holder.current ?? null) : (reg ?? null);
      // Resolve the live DiscoveryAPI (holder pattern, same as the registry
      // above) so /v1/status can enrich task-relative outcomes (#502). When
      // the holder is empty (pre-bootstrap) this is undefined and gather-status
      // leaves outcomes null.
      const disc = config.discovery;
      const liveDiscovery: DiscoveryAPI | undefined =
        disc && 'holder' in disc ? disc.holder.current : disc;
      const statusConfig: StatusGatherConfig | undefined = liveStatus
        ? {
            ...liveStatus,
            discovery: liveDiscovery,
            harnessReadiness: () => {
              const live = getRegistry();
              if (!live) return null;
              return {
                snapshot: live.getSnapshot(),
                joinedHarnessesByCid: live.getJoinedHarnessesByCid(),
              };
            },
          }
        : undefined;
      const body = await gatherStatusForApi(store, statusConfig);
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

  if (config.ui) {
    addHandshakeRoutes(app, config.ui);
  }

  // Operator-class gate — unconditional, see `requireOperatorToken` above.
  // `/v1/events` and `/v1/activity-events` are included here even though
  // their routes are mounted unconditionally below (`addEventsRoutes` /
  // `addActivityEventsRoutes` run regardless of `config.ui`) — this is the
  // exact gap §14.3 closes.
  app.use('/v1/events', requireOperatorToken);
  app.use('/v1/events/*', requireOperatorToken);
  app.use('/v1/activity-events', requireOperatorToken);
  app.use('/v1/activity-events/*', requireOperatorToken);
  app.use('/v1/bootstrap', requireOperatorToken);
  app.use('/v1/rewards', requireOperatorToken);
  app.use('/v1/solvernets', requireOperatorToken);
  app.use('/v1/solvernets/*', requireOperatorToken);
  app.use('/v1/auth/*', requireOperatorToken);
  app.use('/v1/setup/*', requireOperatorToken);
  app.use('/v1/operator', requireOperatorToken);
  app.use('/v1/operator/*', requireOperatorToken);
  app.use('/v1/launcher', requireOperatorToken);
  app.use('/v1/launcher/*', requireOperatorToken);
  app.use('/v1/discovery', requireOperatorToken);
  app.use('/v1/discovery/*', requireOperatorToken);
  app.use('/api/admin/*', requireOperatorToken);
  app.use('/api/harness/*', requireOperatorToken);
  app.use('/api/hermes/*', requireOperatorToken);
  app.use('/api/codex/*', requireOperatorToken);
  app.use('/api/captures/*', requireOperatorToken);
  app.use('/v1/harnesses/*', requireOperatorToken);
  app.use('/v1/debug-report', requireOperatorToken);
  app.use('/v1/debug-report/*', requireOperatorToken);

  addEventsRoutes(app);
  addActivityEventsRoutes(app, { store });

  if (config.stopHook) {
    // §14.1: the stop-hook route is an "Application (external tool)" route,
    // not an `operator`-class one — it's driven by harness subprocesses that
    // only ever carry the bearer `DAEMON_API_TOKEN` (see
    // `client/src/runner/claude.ts`, the learner adapters, and Hermes'
    // bootstrap env), never a UI session. Bearer-only, not
    // `requireOperatorToken` (which would also accept the ui-token).
    app.use('/api/stop-hook', requireBearer);
    addStopHookRoutes(app, config.stopHook);
  }

  if (config.captures) {
    addCapturesRoutes(app, config.captures);
  }

  if (config.bootstrap) {
    addBootstrapRoutes(app, config.bootstrap);
  }

  if (config.ui) {
    addRewardsRoutes(app, {
      store,
      getStatus: () => liveStatus,
    });
  }

  if (config.discovery) {
    const disc = config.discovery;
    if ('holder' in disc) {
      // Lazy holder shape — register routes eagerly; handler returns 503
      // subsystem_not_ready until main.ts populates holder.current after
      // bootstrap. Same pattern as harnessReadinessRegistry.
      addDiscoveryRoutes(app, {
        getDiscovery: () => disc.holder.current ?? null,
      });
    } else {
      const discoveryInstance = disc;
      addDiscoveryRoutes(app, { discovery: () => discoveryInstance });
    }
  }

  if (config.solverNets) {
    addSolverNetsRoutes(app, { registry: config.solverNets.registry });
  }

  // jinn-mono-hqz0: SolverNet creation/launch endpoints. Deps come from a
  // post-bootstrap subsystem; we register the routes eagerly with a
  // deps-proxy that dereferences a holder per-request. If the holder is
  // empty (subsystem not ready yet) the routes effectively no-op via 503
  // because the underlying handlers can't reach `store`. We surface a
  // clear 503 by short-circuiting in a middleware before delegating.
  if (config.solverNetsLauncher) {
    const { holder } = config.solverNetsLauncher;
    app.use('/v1/solvernets/drafts', async (c, next) => holder.current ? next() : c.json({ error: 'subsystem_not_ready', message: 'SolverNet subsystem still initialising' }, 503));
    app.use('/v1/solvernets/drafts/*', async (c, next) => holder.current ? next() : c.json({ error: 'subsystem_not_ready', message: 'SolverNet subsystem still initialising' }, 503));
    app.use('/v1/solvernets/launched', async (c, next) => holder.current ? next() : c.json({ error: 'subsystem_not_ready', message: 'SolverNet subsystem still initialising' }, 503));
    app.use('/v1/solvernets/launched/*', async (c, next) => holder.current ? next() : c.json({ error: 'subsystem_not_ready', message: 'SolverNet subsystem still initialising' }, 503));
    app.use('/v1/solvernets/registry', async (c, next) => holder.current ? next() : c.json({ error: 'subsystem_not_ready', message: 'SolverNet subsystem still initialising' }, 503));
    app.use('/v1/solvernets/registry/*', async (c, next) => holder.current ? next() : c.json({ error: 'subsystem_not_ready', message: 'SolverNet subsystem still initialising' }, 503));
    // Build a Proxy whose property reads dereference the holder. Route
    // handlers in solvernets-endpoints.ts read deps.store, deps.launch,
    // etc. eagerly inside each handler, so per-request dereference is
    // sufficient.
    const depsProxy = new Proxy({} as SolverNetsEndpointsDeps, {
      get(_target, prop) {
        const live = holder.current;
        if (!live) return undefined;
        return live[prop as keyof SolverNetsEndpointsDeps];
      },
    });
    registerSolverNetsEndpoints(app, depsProxy);
  }

  if (config.agentBinding) {
    addAgentBindingRoutes(app, config.agentBinding);
  }

  if (config.debugReport) {
    addDebugReportRoutes(app, config.debugReport);
  }

  if (config.ui && config.admin) {
    addAdminRoutes(app, config.admin);
  }

  if (config.harnessStatus) {
    addHarnessStatusRoutes(app, config.harnessStatus);
  }

  if (config.harnessReadinessRegistry) {
    const reg = config.harnessReadinessRegistry;
    if ('holder' in reg) {
      // Lazy holder shape: register routes eagerly with a getter; main.ts
      // populates holder.current post-bootstrap. Until then, the routes
      // return 503 subsystem_not_ready (panel handles this gracefully).
      addHarnessReadinessRoutes(app, {
        getRegistry: () => reg.holder.current ?? null,
      });
      addHarnessAuthStatusRoutes(app, {
        getRegistry: () => reg.holder.current ?? null,
      });
    } else {
      addHarnessReadinessRoutes(app, { registry: reg });
      addHarnessAuthStatusRoutes(app, { registry: reg });
    }
  }

  if (config.ui) {
    addHermesDoctorRoutes(app, config.hermesDoctor ?? {});
    addCodexDoctorRoutes(app, config.codexDoctor ?? {});
  }

  if (config.ui) {
    addOperatorArtifactsRoutes(app, {
      store,
      ...(config.operatorArtifacts ?? {}),
    });
  }

  if (config.ui) {
    // Setup routes (claude auth probe + login spawn, keystore password change)
    // gated behind the UI token so external callers can't fingerprint the host
    // or rotate keys.
    addSetupRoutes(app, config.setup);
    if (config.claimPolicy) {
      addClaimPolicyRoutes(app, config.claimPolicy);
    }
  }

  // Launcher mode routes — gated by the UI token via the `app.use` block
  // above. The launcher mode SPA is the only legitimate consumer; external
  // callers cannot fingerprint per-SolverNet generator state without it.
  if (config.ui && config.launcher) {
    addLauncherRoutes(app, config.launcher);
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
  // proxies its `acquire_artifact` tool through this route so the byte cache
  // (network_artifacts) lives in one place — the daemon — and the resolution
  // chain (cache → self-store → route-resolver → free origin fetch) runs once.
  // Bearer-token gated; localhost-only — see api server bind host below.
  //
  // Asymmetry with `search_records` / `inspect_record`: record lookup stays
  // client-side because subgraph/on-chain queries and IPFS manifest fetches are
  // keyless; artifact-byte acquisition routes here so the cache is shared.
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
      const ownerSafe = body['ownerSafe'];
      const sources = parseArtifactSources(body['sources']);

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
      if (body['sources'] !== undefined && sources === undefined) {
        return c.json(
          { ok: false, reason: 'invalid_args', error: 'sources must be donation IPFS artifact source objects', sha256, retryable: false },
          400,
        );
      }
      if (sources?.some((source) => source.sha256 !== sha256)) {
        return c.json(
          { ok: false, reason: 'invalid_args', error: 'source sha256 must match requested artifact sha256', sha256, retryable: false },
          400,
        );
      }

      const accessNormalized = { endpoint: access.endpoint, priceUsdc: access.priceUsdc };
      const hint: {
        artifactType?: string;
        envelopeCid?: string;
        sources?: ArtifactSource[];
        ownerSafe?: string;
      } = {};
      if (typeof artifactType === 'string') hint.artifactType = artifactType;
      if (typeof envelopeCid === 'string') hint.envelopeCid = envelopeCid;
      if (sources && sources.length > 0) hint.sources = sources;
      if (typeof ownerSafe === 'string') hint.ownerSafe = ownerSafe;

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
      const httpServer = server as HttpServer;
      resolve({
        port: actualPort,
        close: () =>
          new Promise<void>((res) => {
            let settled = false;
            const done = () => {
              if (settled) return;
              settled = true;
              res();
            };
            const timer = setTimeout(done, 2_000);
            timer.unref?.();
            try {
              httpServer.close(() => {
                clearTimeout(timer);
                done();
              });
              // Shutdown should not wait for dashboard keep-alive/SSE clients.
              // Once the daemon is stopping, close existing sockets after the
              // listener has stopped accepting new connections.
              httpServer.closeIdleConnections();
              httpServer.closeAllConnections();
            } catch {
              clearTimeout(timer);
              done();
            }
          }),
        // serve() returns Server | Http2Server | Http2SecureServer; we never
        // pass http2/https opts so it's always a node http.Server at runtime.
        server: httpServer,
        app,
        setStatusConfig: (status) => {
          liveStatus = status;
        },
      });
    });

    // Handle server errors (EADDRINUSE, socket errors, etc.) so they don't
    // crash the process as unhandled 'error' events on the EventEmitter.
    server.on('error', (err) => {
      reject(err);
    });
  });
}
