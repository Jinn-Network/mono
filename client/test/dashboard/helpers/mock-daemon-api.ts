/**
 * Shared Playwright route-interception helper for the operator dashboard SPA
 * tests. Mocks all daemon API endpoints so the SPA renders running-mode
 * without a live bootstrapped fleet.
 *
 * Uses host-agnostic `**\/v1/...` glob patterns so the mocks match any port.
 * The optional `port` argument is reserved for forward-compatibility when
 * multi-op tests need per-port matching (not yet implemented).
 */
import type { Page } from '@playwright/test';

export interface MockDaemonApiOptions {
  /**
   * Port the daemon would normally run on. Reserved for future use; the
   * current implementation uses host-agnostic globs (`**\/v1/...`) so the
   * mocks match any port. Multi-op tests can still pass the port for clarity.
   */
  port?: number;
}

/** Default payloads — exported so callers can spread + override per-test. */

/** Minimal stub `LaunchedSolverNetRecord` for the per-id record endpoint. */
export const MOCK_LAUNCHED_RECORD = {
  schemaVersion: 'solvernet.launched.v1' as const,
  solverNetId: 'mock-solvernet-id',
  manifestCid: 'bafkrei-mock-manifest-cid',
  manifestHash: '0x0000000000000000000000000000000000000000000000000000000000000000' as const,
  launcherAgentId: '5474',
  launcherSafeAddress: '0x0e767E28C6889CcD0DfB88E631a3702D56Ce24FC' as const,
  launchedAt: new Date().toISOString(),
  status: 'launched' as const,
  statusUpdatedAt: new Date().toISOString(),
  generatorEnabled: false,
  registry: {},
};

/** Minimal empty list of owned launched SolverNet records. */
export const DEFAULT_OWNED_LAUNCHED_LIST = {
  records: [],
} as const;

/** Minimal empty global registry list. */
export const DEFAULT_REGISTRY_LIST = {
  nets: [],
} as const;

/** Minimal empty draft list. */
export const DEFAULT_DRAFT_LIST = {
  drafts: [],
} as const;

/** Minimal empty joined SolverNets map. */
export const DEFAULT_JOINED_SOLVER_NETS = {
  joinedSolverNets: {},
} as const;

/** Minimal empty captures list. */
export const DEFAULT_CAPTURES_LIST = {
  pending: [],
} as const;

/** Minimal launcher status — no tasks running. */
export const DEFAULT_LAUNCHER_STATUS = {
  schemaVersion: 1 as const,
  generatedAt: new Date().toISOString(),
  nets: [],
};

/** Minimal launcher tasks response — no tasks. */
export const DEFAULT_LAUNCHER_TASKS = {
  schemaVersion: 1 as const,
  generatedAt: new Date().toISOString(),
  tasks: [],
};

/** Minimal events list. */
export const DEFAULT_EVENTS = {
  events: [],
} as const;

/** Minimal activity-events page — empty list, no cursor, no counts. */
export const DEFAULT_ACTIVITY_EVENTS = {
  events: [],
  nextCursor: null,
  counts: {},
} as const;

/** Single activity-event row for the /v1/activity-events/:id detail route. */
export const MOCK_ACTIVITY_EVENT_ROW = {
  id: 1,
  ts: new Date().toISOString(),
  kind: 'task_posted',
  requestId: null,
  serviceIndex: 1,
  txHash: null,
  solverType: 'prediction.v1',
  outcome: 'ok',
  detail: null,
} as const;

/** Minimal operator execution-data (artifacts) list — includes all required response fields. */
export const DEFAULT_OPERATOR_ARTIFACTS = {
  schemaVersion: 1 as const,
  generatedAt: new Date().toISOString(),
  source: 'served' as const,
  pricing: {
    publicEndpoint: '',
    defaultPriceUsdc: '0',
    perArtifactTypePrice: {},
    donation: { enabled: false },
  },
  summary: {
    served: {
      totalCount: 0,
      totalBytes: 0,
      freeCount: 0,
      gatedCount: 0,
      latestCreatedAt: null,
      artifactTypes: [],
    },
    network: {
      totalCount: 0,
      totalBytes: 0,
      latestFetchedAt: null,
      artifactTypes: [],
    },
    access: {
      accessCount: 0,
      paidServeCount: 0,
      freeServeCount: 0,
      failedPaymentCount: 0,
      paymentRequiredCount: 0,
      revenueUsdc: '0',
      lastAccessAt: null,
      lastPaidAt: null,
    },
  },
  recentAccesses: [],
  artifacts: [],
};

/** Minimal task-post-counts (#918/#942) — chain windows + empty byCid map. */
export const DEFAULT_TASK_POST_COUNTS = {
  chain: { h1: 0, h6: 0, h24: 0 },
  byCid: {},
};

export const DEFAULT_RUNNING_BOOTSTRAP = {
  schemaVersion: 1,
  mode: 'running',
  // Onboarding gate (#1041): App.tsx holds the full-screen Onboarding takeover
  // until bootstrap reports onboardingComplete:true. A running, already-onboarded
  // daemon surfaces this from its persisted config (bootstrap-endpoint.ts), so the
  // mock must carry it or the SPA never reaches the operator dashboard.
  onboardingComplete: true,
  steps: ['wallet'],
  currentStep: 'complete',
  services: [
    { index: 1, step: 'complete', safe_address: '0x0e767E28C6889CcD0DfB88E631a3702D56Ce24FC' },
  ],
  master_address: '0xE64bAf0073a71b0Cb2C0558bB16f24b45E1FB5CF',
  chain: 'base-sepolia',
  rpcUrl: 'https://sepolia.base.org',
  defaultRpcUrl: 'https://sepolia.base.org',
  solverNets: {
    prediction: {
      enabled: true,
      roles: ['solving'],
      harness: 'claude-code-learner',
      model: 'claude-haiku-4-5-20251001',
      plugins: ['jinn-prediction-plugin'],
    },
  },
} as const;

/**
 * Empty notifications payload (issue #2408 — `GET /v1/notifications`). The SPA now consumes
 * this endpoint directly instead of deriving notices client-side from `/v1/status` +
 * `/v1/bootstrap` + SSE; per-test overrides register their own route AFTER `mockDaemonApi` so
 * they win (Playwright checks routes in reverse-registration order).
 */
export const DEFAULT_NOTIFICATIONS_PAYLOAD = {
  schemaVersion: 1,
  generatedAt: new Date().toISOString(),
  notifications: [] as Array<{
    kind: string;
    severity: 'blocking' | 'warning' | 'info';
    title: string;
    message: string;
    jumpTo?: string;
    details?: Record<string, unknown>;
  }>,
};

export const DEFAULT_STATUS_PAYLOAD = {
  schemaVersion: 1,
  fleet: { services: [{ index: 1, step: 'complete', safeAddress: '0x0e767E28C6889CcD0DfB88E631a3702D56Ce24FC', agentId: 5474, safeBoundToAgent: true }] },
  predictionV1: {
    operator: {
      ok: true,
      enabled: true,
      diagnostics: [],
      solverNet: { name: 'prediction', enabled: true, roles: ['solving'] },
      nextAction: { description: 'Waiting for Tasks. SolverNet active, Harness loaded.' },
    },
    totals: { observedTasks: 0, activeTaskRuns: 0, solutions: 0, verdicts: 0, failed: 0 },
  },
  rewards: {},
  masterGas: { balanceWei: '0', runwayDaysExcess: '4' },
} as const;

export const DEFAULT_SOLVERNETS_CATALOG = {
  schemaVersion: 1,
  generatedAt: new Date().toISOString(),
  nets: [
    {
      name: 'prediction',
      description: 'Forecast resolved outcomes; rewarded by Brier score on verified resolutions.',
      contract: { id: 'prediction', version: 'v1' },
      state: 'live',
      supportedRoles: ['solving', 'evaluating'],
      compatibleHarnesses: [{ name: 'claude-code-learner', version: '0.1.0', supportsRoles: ['solving', 'evaluating'] }],
      compatiblePlugins: [{ name: 'jinn-prediction-plugin', version: '0.1.0', source: 'bundled' }],
    },
  ],
} as const;

/**
 * Build a registry-catalog summary row (the shape RegistryCatalog renders).
 * Mirrors `SolverNetManifestSummary`. Override any field per-test.
 */
export function makeRegistrySummary(
  overrides: Partial<{
    manifestCid: string;
    solverNetId: string;
    name: string;
    network: string;
    launcherAgentId: string;
    launcherSafeAddress: string;
    status: 'launched' | 'paused' | 'retired';
    statusUpdatedAt: string;
    contractId: string;
    contractVersion: string;
    solutionPriceWei: string;
    verdictPriceWei: string;
    openRoles: Array<'solver' | 'evaluator'>;
    anchorBlock: number;
  }> = {},
) {
  return {
    manifestCid: 'bafkreiopalaunchedsolvernet0000000000000000000000000000',
    solverNetId: 'agent5474_prediction.v1-1_aaaaaaaa',
    name: 'Prediction Markets',
    network: 'base-sepolia',
    launcherAgentId: '5474',
    launcherSafeAddress: '0xE64bAf0073a71b0Cb2C0558bB16f24b45E1FB5CF',
    status: 'launched' as const,
    statusUpdatedAt: '2026-05-05T00:01:00Z',
    contractId: 'prediction',
    contractVersion: 'v1',
    solutionPriceWei: '1000000000000000',
    verdictPriceWei: '500000000000000',
    openRoles: ['solver', 'evaluator'] as Array<'solver' | 'evaluator'>,
    anchorBlock: 1,
    ...overrides,
  };
}

/**
 * Build a `RegistryManifestResponse` for the per-CID GET the JoinFlow form
 * fetches (`GET /v1/solvernets/registry/:cid`). The manifest fields below are
 * the minimum JoinFlow reads (name, contract.evaluationFunction.implementation,
 * openRoles, prices). Only `manifestCid` and `name` are overridable; for a
 * different network/launcher, build a full manual object.
 */
export function makeRegistryManifestResponse(
  overrides: Partial<{ manifestCid: string; name: string }> = {},
) {
  const manifestCid = overrides.manifestCid ?? 'bafkreiopalaunchedsolvernet0000000000000000000000000000';
  return {
    manifest: {
      schemaVersion: 'solvernet.manifest.v1' as const,
      solverNetId: 'agent5474_prediction.v1-1_aaaaaaaa',
      network: 'base-sepolia' as const,
      name: overrides.name ?? 'Prediction Markets',
      description: 'Forecast resolved outcomes; rewarded by Brier score.',
      launcher: {
        safeAddress: '0xE64bAf0073a71b0Cb2C0558bB16f24b45E1FB5CF',
        agentEoa: '0x1111111111111111111111111111111111111111',
        agentId: '5474',
      },
      contract: {
        id: 'prediction',
        version: 'v1',
        schemas: { task: {}, solution: {}, verdict: {} },
        claimPolicyDefaults: {
          mode: 'parallel' as const,
          maxClaims: 5,
          maxClaimsPerOperator: 1,
          claimLeaseTtlSeconds: 600,
        },
        credentialRequirements: { creator: [], solver: [], evaluator: [] },
        evaluationFunction: {
          id: 'predictionV1Eval',
          deterministic: true,
          inputs: ['solution.predictionPbool'],
          output: 'verdict.brierScore',
          // Match the real SDK manifest (packages/sdk/src/contracts.ts) so the
          // JoinFlow evaluator-harness binding — which does
          // implementation.includes('prediction-v1-evaluator') — resolves the
          // same way against this mock as against a live daemon.
          implementation: 'client/src/harnesses/impls/prediction-v1-evaluator',
        },
        aggregationFunction: {
          id: 'predictionV1Agg',
          deterministic: true,
          inputs: ['verdict.brierScore'],
          output: 'aggregate.score',
        },
      },
      solutionPriceWei: '1000000000000000',
      verdictPriceWei: '500000000000000',
      openRoles: ['solver', 'evaluator'] as Array<'solver' | 'evaluator'>,
      registry: { manifestCid },
      createdAt: '2026-05-05T00:00:00Z',
      launchedAt: '2026-05-05T00:01:00Z',
      signature: {
        alg: 'eip-191' as const,
        signer: '0x1111111111111111111111111111111111111111',
        value:
          '0x2222222222222222222222222222222222222222222222222222222222222222222222222222222222222222222222222222222222222222222222222222222222',
      },
    },
    lifecycle: {
      status: 'launched' as const,
      statusUpdatedAt: '2026-05-05T00:01:00Z',
      sourceBlock: 1,
    },
  };
}

export async function mockDaemonApi(page: Page, _opts: MockDaemonApiOptions = {}): Promise<void> {
  // Use URL-function predicates throughout so Playwright's first-match-wins
  // semantics are deterministic — no glob ambiguity between similar paths.
  await page.route(
    (url) => url.pathname === '/v1/bootstrap',
    (route) =>
      route.fulfill({ contentType: 'application/json', body: JSON.stringify(DEFAULT_RUNNING_BOOTSTRAP) }),
  );
  await page.route(
    (url) => url.pathname === '/v1/status',
    (route) =>
      route.fulfill({ contentType: 'application/json', body: JSON.stringify(DEFAULT_STATUS_PAYLOAD) }),
  );
  await page.route(
    (url) => url.pathname === '/v1/notifications',
    (route) =>
      route.fulfill({ contentType: 'application/json', body: JSON.stringify(DEFAULT_NOTIFICATIONS_PAYLOAD) }),
  );
  // Catalog of SolverNet types (GET /v1/solvernets — exact path, no trailing segment).
  await page.route(
    (url) => url.pathname === '/v1/solvernets',
    (route) =>
      route.fulfill({ contentType: 'application/json', body: JSON.stringify(DEFAULT_SOLVERNETS_CATALOG) }),
  );
  await page.route(
    (url) => url.pathname === '/v1/setup/solvernets/prediction',
    (route) =>
      route.fulfill({
        contentType: 'application/json',
        body: JSON.stringify({
          ok: true,
          restartRequired: true,
          name: 'prediction',
          config: { enabled: true, roles: ['solving', 'evaluating'] },
        }),
      }),
  );

  // ---- SolverNet creation + launch endpoints ----
  // Use a URL function to disambiguate the list (`/v1/solvernets/launched`) from
  // per-record GETs (`/v1/solvernets/launched/:id`). Glob-only rules have
  // ambiguous ordering when both patterns could match the same URL.
  await page.route(
    (url) => url.pathname === '/v1/solvernets/launched',
    (route) =>
      route.fulfill({ contentType: 'application/json', body: JSON.stringify(DEFAULT_OWNED_LAUNCHED_LIST) }),
  );
  // Per-record GET, lifecycle PATCH, and generator-config PATCH — returns a
  // minimal valid LaunchedSolverNetRecord so the detail page renders cleanly.
  await page.route(
    (url) => url.pathname.startsWith('/v1/solvernets/launched/'),
    (route) =>
      route.fulfill({ contentType: 'application/json', body: JSON.stringify(MOCK_LAUNCHED_RECORD) }),
  );
  // Global registry list (GET /v1/solvernets/registry) + per-manifest GET.
  await page.route(
    (url) => url.pathname === '/v1/solvernets/registry',
    (route) =>
      route.fulfill({ contentType: 'application/json', body: JSON.stringify(DEFAULT_REGISTRY_LIST) }),
  );
  await page.route(
    (url) => url.pathname.startsWith('/v1/solvernets/registry/'),
    (route) =>
      route.fulfill({ contentType: 'application/json', body: JSON.stringify({ manifest: null }) }),
  );
  // Draft CRUD + launch.
  await page.route(
    (url) => url.pathname === '/v1/solvernets/drafts',
    (route) =>
      route.fulfill({ contentType: 'application/json', body: JSON.stringify(DEFAULT_DRAFT_LIST) }),
  );
  await page.route(
    (url) => url.pathname.startsWith('/v1/solvernets/drafts/'),
    (route) =>
      route.fulfill({ contentType: 'application/json', body: JSON.stringify({ ok: true }) }),
  );

  // ---- Operator participation endpoints ----
  // ORDERING NOTE: Playwright checks routes in reverse-registration order (last
  // registered = first checked). Prefix catch-alls must be registered BEFORE
  // specific exact-match routes so the specific routes take priority.
  await page.route(
    (url) => url.pathname.startsWith('/v1/operator/'),
    (route) =>
      route.fulfill({ contentType: 'application/json', body: JSON.stringify({ ok: true }) }),
  );
  // Specific exact routes registered AFTER catch-all so they win (checked first).
  // The read that backs the (read-only, post-Wave-4-D1) Memberships view. Needs
  // its own route because the catch-all's `{ ok: true }` is not a valid
  // `{ joinedSolverNets }` payload.
  await page.route(
    (url) => url.pathname === '/v1/operator/joined',
    (route) =>
      route.fulfill({ contentType: 'application/json', body: JSON.stringify(DEFAULT_JOINED_SOLVER_NETS) }),
  );
  // execution-data accepts query params (source, limit); match by pathname.
  await page.route(
    (url) => url.pathname === '/v1/operator/execution-data',
    (route) =>
      route.fulfill({ contentType: 'application/json', body: JSON.stringify(DEFAULT_OPERATOR_ARTIFACTS) }),
  );

  // ---- Launcher status + tasks (legacy endpoints) ----
  // Catch-all registered BEFORE specific routes so specific routes win.
  await page.route(
    (url) => url.pathname.startsWith('/v1/launcher/'),
    (route) =>
      route.fulfill({ contentType: 'application/json', body: JSON.stringify({ ok: true }) }),
  );
  await page.route(
    (url) => url.pathname === '/v1/launcher/status',
    (route) =>
      route.fulfill({ contentType: 'application/json', body: JSON.stringify(DEFAULT_LAUNCHER_STATUS) }),
  );
  // launcher/tasks — paginated task list used by TasksPanel on the launched-record page.
  await page.route(
    (url) => url.pathname === '/v1/launcher/tasks',
    (route) =>
      route.fulfill({ contentType: 'application/json', body: JSON.stringify(DEFAULT_LAUNCHER_TASKS) }),
  );

  // ---- Captures ----
  await page.route(
    (url) => url.pathname === '/api/captures/pending',
    (route) =>
      route.fulfill({ contentType: 'application/json', body: JSON.stringify(DEFAULT_CAPTURES_LIST) }),
  );
  await page.route(
    (url) => url.pathname.startsWith('/api/captures/'),
    (route) =>
      route.fulfill({ contentType: 'application/json', body: JSON.stringify({ ok: true }) }),
  );

  // ---- Discovery (task-post-counts, #918/#942) ----
  // NetworkTab polls this every 30s; without the mock the request falls through
  // to the real daemon and NetworkTab crashes on the chain-less response.
  // (matches with/without the ?cid query — match by pathname).
  await page.route(
    (url) => url.pathname === '/v1/discovery/task-post-counts',
    (route) =>
      route.fulfill({ contentType: 'application/json', body: JSON.stringify(DEFAULT_TASK_POST_COUNTS) }),
  );

  // ---- Misc setup + auth ----
  await page.route(
    (url) => url.pathname.startsWith('/v1/setup/'),
    (route) =>
      route.fulfill({ contentType: 'application/json', body: JSON.stringify({ ok: true }) }),
  );
  await page.route(
    (url) => url.pathname.startsWith('/v1/auth/'),
    (route) =>
      route.fulfill({ contentType: 'application/json', body: JSON.stringify({ authenticated: false, context: 'bare', detail: 'mock' }) }),
  );

  // Suppress the auth handshake redirect; the SPA will silently fall back.
  await page.route(
    (url) => url.pathname.startsWith('/auth/handshake'),
    (route) =>
      route.fulfill({ contentType: 'application/json', body: '{"ok":true}' }),
  );

  // ---- Admin / restart ----
  await page.route(
    (url) => url.pathname.startsWith('/api/admin/'),
    (route) =>
      route.fulfill({ contentType: 'application/json', body: JSON.stringify({ ok: true }) }),
  );

  // ---- Harness status (raw fetch in HarnessStatusPanel, not via jfetch) ----
  await page.route(
    (url) => url.pathname.startsWith('/api/harness/'),
    (route) =>
      route.fulfill({
        contentType: 'application/json',
        body: JSON.stringify({ mode: 'train', codeDigest: 'mock-digest', lastModeSwitchAt: Date.now() }),
      }),
  );

  // ---- Per-harness readiness (#332) — probed by the JoinFlow form ----
  // GET /v1/harnesses/:name/readiness. Default every harness to ready so the
  // join form's Save & Join gate is open. Catalog/join tests that exercise the
  // not-ready path override this route per-test (registered after mockDaemonApi).
  await page.route(
    (url) => /^\/v1\/harnesses\/[^/]+\/readiness$/.test(url.pathname),
    (route) => {
      // pathname = ['', 'v1', 'harnesses', <name>, 'readiness'] → name at [3]
      const name = decodeURIComponent(new URL(route.request().url()).pathname.split('/')[3] ?? '');
      return route.fulfill({
        contentType: 'application/json',
        body: JSON.stringify({ harnessName: name, manifestCids: [], ready: true }),
      });
    },
  );

  // ---- Discovery (proxied via daemon's /v1/discovery/* routes, used by Build page) ----
  await page.route(
    (url) => url.pathname.startsWith('/v1/discovery/'),
    (route) =>
      route.fulfill({ contentType: 'application/json', body: JSON.stringify({ items: [], total: 0 }) }),
  );

  // ---- Events feed ----
  // The SSE stream at /v1/events (no trailing slash) is opened by
  // LoadingScreen via useEventStream() during the brief window while the
  // bootstrap query is in-flight. Without a mock it hits the real daemon
  // and gets a 401 (auth cookie not set). Fulfill with an empty SSE body
  // so the browser accepts the response without logging a console error.
  await page.route(
    (url) => url.pathname === '/v1/events',
    (route) =>
      route.fulfill({
        contentType: 'text/event-stream',
        headers: { 'Cache-Control': 'no-cache', 'X-Accel-Buffering': 'no' },
        body: '',
      }),
  );
  // Catch-all using URL function for any /v1/events/* not already mocked.
  await page.route(
    (url) => url.pathname.startsWith('/v1/events/'),
    (route) =>
      route.fulfill({ contentType: 'application/json', body: JSON.stringify(DEFAULT_EVENTS) }),
  );

  // ---- Activity events (persistent lifecycle stream — /v1/activity-events) ----
  // The Events list + EventDetail pages call /v1/activity-events[ /:id ]. Without
  // a mock these fall through to the real daemon and 401 (auth cookie not set in
  // the mocked context) — same failure mode the /v1/events mock above guards.
  // Register the per-id prefix BEFORE the exact list route so the exact match
  // wins (Playwright checks last-registered first).
  await page.route(
    (url) => url.pathname.startsWith('/v1/activity-events/'),
    (route) =>
      route.fulfill({ contentType: 'application/json', body: JSON.stringify(MOCK_ACTIVITY_EVENT_ROW) }),
  );
  await page.route(
    (url) => url.pathname === '/v1/activity-events',
    (route) =>
      route.fulfill({ contentType: 'application/json', body: JSON.stringify(DEFAULT_ACTIVITY_EVENTS) }),
  );
}
