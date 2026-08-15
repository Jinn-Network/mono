/**
 * Real-daemon Playwright e2e for the SolverNet creation/launch happy path.
 *
 * Spec: spec/2026-05-05-solvernet-creation-and-launch.md (Task 29 of the
 * implementation plan), narrowed scope.
 *
 * Approach (mirrors `spa-config.e2e.test.ts`): we spawn a real daemon
 * process so the SPA renders against the production HTTP gate, the
 * bundled dashboard, and real route registration — but we mock the
 * SPA's outbound HTTP at the Playwright `page.route()` boundary.
 *
 * The deeper deps (IPFS, IdentityRegistry setMetadata, subgraph) live
 * behind `solvernets/daemon-init.ts` and require viem / chain wiring;
 * building a dep-injected test entry point is out of scope for this
 * dispatch. Intercepting at the page boundary lets us drive the SPA
 * end-to-end without touching the daemon's chain integration.
 *
 * Coverage (this file): scenarios 1-4.
 *
 *   1. Operator → Launcher mode → Create SolverNet → walk Steps 1-5 →
 *      click Launch on Step 5.
 *   2. POST /v1/solvernets/drafts returns a fresh draft.
 *   3. PATCH /v1/solvernets/drafts/:id merges patches.
 *   4. POST /v1/solvernets/drafts/:id/launch returns a `launching`
 *      action (`solverNetId: 'sn-test-1'`).
 *   5. GET /v1/solvernets/launched/sn-test-1 progresses through
 *      `launchProgress.phase = 'broadcasting'` → `'confirming'` →
 *      `status: 'launched'`.
 *   6. Assert the URL flips to `/launcher/launched/sn-test-1` and the
 *      post-launch dashboard shows status `launched`.
 *
 * Out of scope for this dispatch (filed for follow-up):
 *   - Crash-recovery
 */
import { test, expect, type Page, type Route } from '@playwright/test';
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const PORT = 17333;

let daemon: ChildProcess | null = null;
let homeDir = '';
let handshakeUrl: string | null = null;

// ── Fixtures ─────────────────────────────────────────────────────────────────

const DRAFT_ID = 'draft-test-1';
const SOLVER_NET_ID = 'sn-test-1';
const MANIFEST_CID = 'QmTestSolverNetManifestCid000000000000000001';
const MANIFEST_HASH =
  '0xabcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890';
const PREDICTION_CONTRACT = { id: 'prediction', version: 'v1' };

type LifecycleTarget = 'paused' | 'launched' | 'retired';
type RegistrySummary = Record<string, unknown> & {
  manifestCid: string;
  status: LifecycleTarget;
};
interface ObservedLifecycleRequest {
  method: string;
  solverNetId: string;
  payload: { target: LifecycleTarget };
}

const RUNNING_BOOTSTRAP = {
  schemaVersion: 1,
  mode: 'running',
  // #1041: the SPA gates the dashboard behind onboardingComplete (App.tsx). A
  // running, onboarded daemon reports it; without it the app is stuck on the
  // onboarding takeover and the operator shell never renders.
  onboardingComplete: true,
  steps: ['wallet'],
  currentStep: 'complete',
  services: [
    { index: 1, step: 'complete', safe_address: '0xE64bAf0073a71b0Cb2C0558bB16f24b45E1FB5CF' },
  ],
  master_address: '0xE64bAf0073a71b0Cb2C0558bB16f24b45E1FB5CF',
  chain: 'base-sepolia',
  rpcUrl: 'https://sepolia.base.org',
  defaultRpcUrl: 'https://sepolia.base.org',
  solverNets: {},
};

const STATUS_PAYLOAD = {
  schemaVersion: 1,
  fleet: {
    services: [
      {
        index: 1,
        step: 'complete',
        safeAddress: '0xE64bAf0073a71b0Cb2C0558bB16f24b45E1FB5CF',
        agentId: 9001,
        safeBoundToAgent: true,
      },
    ],
  },
  master_address: '0xE64bAf0073a71b0Cb2C0558bB16f24b45E1FB5CF',
  rewards: {},
  masterGas: { balanceWei: '5000000000000000', runwayDaysExcess: '4' },
};

const SOLVERNETS_CATALOG = {
  schemaVersion: 1,
  generatedAt: new Date().toISOString(),
  nets: [
    {
      name: 'prediction',
      description:
        'Forecast resolved outcomes; rewarded by Brier score on verified resolutions.',
      contract: PREDICTION_CONTRACT,
      state: 'live',
      supportedRoles: ['solving', 'evaluating'],
      compatibleHarnesses: [
        {
          name: 'claude-code-learner',
          version: '0.1.0',
          supportsRoles: ['solving', 'evaluating'],
        },
      ],
      compatiblePlugins: [
        { name: 'jinn-prediction-plugin', version: '0.1.0', source: 'bundled' },
      ],
    },
  ],
};

// ── Daemon spawn ─────────────────────────────────────────────────────────────

test.beforeAll(async () => {
  homeDir = mkdtempSync(join(tmpdir(), 'jinn-solvernet-flow-e2e-'));
  const distBin = join(process.cwd(), 'dist', 'bin', 'jinn.js');
  if (!existsSync(distBin)) {
    throw new Error(`dist/bin/jinn.js missing — run \`yarn build\` first`);
  }
  daemon = spawn('node', [distBin, 'run', '--no-ui'], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      HOME: homeDir,
      JINN_PASSWORD: 'test-password',
      JINN_API_PORT: String(PORT),
      BASE_RPC_URL: 'http://127.0.0.1:65000',
      JINN_NETWORK: 'testnet',
      JINN_DISABLE_TESTNET_FAUCET: '1',
    },
    stdio: 'pipe',
  });

  const onChunk = (chunk: Buffer): void => {
    const text = chunk.toString('utf-8');
    const m = /UI handshake URL:\s+(\S+)/.exec(text);
    if (m && !handshakeUrl) handshakeUrl = m[1];
  };
  daemon.stderr?.on('data', onChunk);
  daemon.stdout?.on('data', onChunk);

  for (let i = 0; i < 60; i++) {
    try {
      const res = await fetch(`http://127.0.0.1:${PORT}/v1/bootstrap`, {
        headers: { 'x-jinn-ui-token': 'unused' },
      });
      if (res.status === 200 || res.status === 401) return;
    } catch {
      // not yet
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error('daemon never came up on test port');
});

test.afterAll(async () => {
  if (daemon && !daemon.killed) {
    daemon.kill('SIGTERM');
    await new Promise((r) => setTimeout(r, 500));
    if (!daemon.killed) daemon.kill('SIGKILL');
  }
});

// ── Mock state machine ───────────────────────────────────────────────────────

interface MockState {
  draft: Record<string, unknown> | null;
  observedLaunches: Array<{ draftId: string }>;
  observedLifecycleRequests: ObservedLifecycleRequest[];
  /** How many times GET /v1/solvernets/launched/sn-test-1 has been called. */
  launchedReadCount: number;
  launchedRecord: Record<string, unknown> | null;
  registrySummaries: RegistrySummary[];
}

function makeMockState(overrides: Partial<MockState> = {}): MockState {
  return {
    draft: null,
    observedLaunches: [],
    observedLifecycleRequests: [],
    launchedReadCount: 0,
    launchedRecord: null,
    registrySummaries: [],
    ...overrides,
  };
}

function buildLaunchedRecord(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  const status = (overrides.status ?? 'launched') as
    | 'launching'
    | 'launched'
    | 'paused'
    | 'retired'
    | 'failed';
  return {
    schemaVersion: 'solvernet.launched.v1',
    solverNetId: SOLVER_NET_ID,
    manifestCid: MANIFEST_CID,
    manifestHash: MANIFEST_HASH,
    launcherAgentId: '9001',
    launcherSafeAddress: '0xE64bAf0073a71b0Cb2C0558bB16f24b45E1FB5CF',
    launchedAt: '2026-05-05T00:00:00.000Z',
    statusUpdatedAt: '2026-05-05T00:00:00.000Z',
    status,
    generatorEnabled: status === 'launched',
    generatorState: { lastPollAt: undefined },
    generatorConfig: {
      cadenceMs: 60_000,
      windowMs: 3_600_000,
      maxOpenRounds: 5,
    },
    registry: {
      metadataTxHash:
        '0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef',
      metadataBlockNumber: 12345,
    },
    ...overrides,
  };
}

/**
 * Build the launched-record snapshot to return on the Nth poll.
 *
 * The dispatch spec calls for three poll responses:
 *   - 1st: launchProgress.phase = 'broadcasting', status 'launching'
 *   - 2nd: launchProgress.phase = 'confirming', status 'launching'
 *   - 3rd: status 'launched', launchProgress undefined
 *
 * Subsequent polls (the post-launch dashboard polls on mount) keep
 * returning the launched record.
 */
function buildLaunchedSnapshot(callIndex: number): Record<string, unknown> {
  if (callIndex === 0) {
    return buildLaunchedRecord({
      status: 'launching',
      launchProgress: { phase: 'broadcasting', attemptCount: 1 },
    });
  }
  if (callIndex === 1) {
    return buildLaunchedRecord({
      status: 'launching',
      launchProgress: { phase: 'confirming', attemptCount: 1 },
    });
  }
  // 3rd call onwards — launched and steady-state.
  return buildLaunchedRecord();
}

const MOCK_MANIFEST = {
  schemaVersion: 'solvernet.manifest.v1',
  solverNetId: SOLVER_NET_ID,
  network: 'base-sepolia',
  name: 'Polymarket forecasts',
  description:
    'Forecast resolved Polymarket outcomes; rewarded by Brier score on verified resolutions.',
  launcher: {
    safeAddress: '0xE64bAf0073a71b0Cb2C0558bB16f24b45E1FB5CF',
    agentEoa: '0x1111111111111111111111111111111111111111',
    agentId: '9001',
  },
  contract: {
    ...PREDICTION_CONTRACT,
    schemas: { task: {}, solution: {}, verdict: {} },
    claimPolicyDefaults: {
      mode: 'parallel',
      maxClaims: 5,
      maxClaimsPerOperator: 1,
      claimLeaseTtlSeconds: 3600,
    },
    credentialRequirements: { creator: [], solver: [], evaluator: [] },
    evaluationFunction: {
      id: 'brier-score',
      deterministic: true,
      inputs: ['solution', 'resolution'],
      output: 'score',
      implementation: 'prediction-v0-evaluator',
    },
    aggregationFunction: {
      id: 'mean',
      deterministic: true,
      inputs: ['scores'],
      output: 'score',
      windowDays: 30,
    },
  },
  solutionPriceWei: '100000000000000',
  verdictPriceWei: '50000000000000',
  openRoles: ['solver', 'evaluator'],
  createdAt: '2026-05-05T00:00:00.000Z',
  launchedAt: '2026-05-05T00:00:00.000Z',
  signature: {
    alg: 'eip-191',
    signer: '0x1111111111111111111111111111111111111111',
    value: '0xdeadbeef',
  },
};

function buildRegistrySummary(
  overrides: Partial<RegistrySummary> = {},
): RegistrySummary {
  return {
    manifestCid: MANIFEST_CID,
    solverNetId: SOLVER_NET_ID,
    name: MOCK_MANIFEST.name,
    network: 'base-sepolia',
    launcherAgentId: '9001',
    launcherSafeAddress: '0xE64bAf0073a71b0Cb2C0558bB16f24b45E1FB5CF',
    status: 'launched',
    statusUpdatedAt: '2026-05-05T00:00:00.000Z',
    contractId: PREDICTION_CONTRACT.id,
    contractVersion: PREDICTION_CONTRACT.version,
    solutionPriceWei: '100000000000000',
    verdictPriceWei: '50000000000000',
    openRoles: ['solver', 'evaluator'],
    anchorBlock: 12345,
    ...overrides,
  };
}

function lifecycleResponseTimestamp(target: LifecycleTarget): string {
  return `2026-05-05T00:00:0${target === 'paused' ? 1 : target === 'launched' ? 2 : 3}.000Z`;
}

async function fulfillLifecycleTransition(
  route: Route,
  state: MockState,
): Promise<void> {
  const req = route.request();
  const url = new URL(req.url());
  const segments = url.pathname.split('/').filter(Boolean);
  const id = decodeURIComponent(segments[3] ?? '');
  if (id !== SOLVER_NET_ID || !state.launchedRecord) {
    return route.fulfill({
      status: 404,
      contentType: 'application/json',
      body: JSON.stringify({ error: 'record_not_found' }),
    });
  }
  const body = (req.postDataJSON?.() ?? {}) as { target?: LifecycleTarget };
  const target = body.target;
  if (target !== 'paused' && target !== 'launched' && target !== 'retired') {
    return route.fulfill({
      status: 400,
      contentType: 'application/json',
      body: JSON.stringify({ error: 'invalid_target' }),
    });
  }

  state.observedLifecycleRequests.push({
    method: req.method(),
    solverNetId: id,
    payload: { target },
  });
  state.launchedRecord = {
    ...state.launchedRecord,
    status: target,
    statusUpdatedAt: lifecycleResponseTimestamp(target),
    generatorEnabled: target === 'launched',
    registry: {
      metadataTxHash:
        `0x${String(state.observedLifecycleRequests.length).padStart(64, '0')}`,
      metadataBlockNumber: 12345 + state.observedLifecycleRequests.length,
    },
  };
  return route.fulfill({
    contentType: 'application/json',
    body: JSON.stringify(state.launchedRecord),
  });
}

async function mockDaemonApi(page: Page, state: MockState): Promise<void> {
  // Operator-side reads.
  await page.route('**/v1/bootstrap', (route) =>
    route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify(RUNNING_BOOTSTRAP),
    }),
  );
  await page.route('**/v1/status', (route) =>
    route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify(STATUS_PAYLOAD),
    }),
  );
  await page.route('**/v1/solvernets', (route) =>
    route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify(SOLVERNETS_CATALOG),
    }),
  );
  await page.route('**/v1/events/recent**', (route) =>
    route.fulfill({ contentType: 'application/json', body: JSON.stringify({ events: [] }) }),
  );
  // Suppress claude auth check.
  await page.route('**/v1/auth/claude**', (route) =>
    route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({
        schemaVersion: 1,
        authenticated: true,
        context: 'bare',
        detail: 'mocked',
        binary: { ok: true, detail: 'mocked' },
      }),
    }),
  );
  // Auth handshake — silenced so Playwright doesn't redirect away.
  await page.route('**/auth/handshake**', (route) =>
    route.fulfill({ contentType: 'application/json', body: '{"ok":true}' }),
  );
  // Launcher-overview reads (post-launch dashboard mounts use these).
  await page.route('**/v1/launcher/status', (route) =>
    route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({
        schemaVersion: 1,
        generatedAt: new Date().toISOString(),
        nets: [],
      }),
    }),
  );
  await page.route('**/v1/launcher/tasks**', (route) =>
    route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({
        schemaVersion: 1,
        generatedAt: new Date().toISOString(),
        tasks: [],
      }),
    }),
  );

  // ── Drafts CRUD ─────────────────────────────────────────────────────────
  await page.route('**/v1/solvernets/drafts', async (route) => {
    const req = route.request();
    if (req.method() === 'POST') {
      const now = '2026-05-05T00:00:00.000Z';
      state.draft = {
        schemaVersion: 'solvernet.draft.v1',
        draftId: DRAFT_ID,
        completedSteps: [],
        createdAt: now,
        updatedAt: now,
      };
      return route.fulfill({
        contentType: 'application/json',
        body: JSON.stringify(state.draft),
      });
    }
    if (req.method() === 'GET') {
      return route.fulfill({
        contentType: 'application/json',
        body: JSON.stringify({
          drafts: state.draft ? [state.draft] : [],
        }),
      });
    }
    return route.fulfill({ status: 405, body: 'method not allowed' });
  });

  await page.route('**/v1/solvernets/drafts/*', async (route) => {
    const url = new URL(route.request().url());
    const segments = url.pathname.split('/').filter(Boolean);
    // /v1/solvernets/drafts/:id   → segments = [v1, solvernets, drafts, :id]
    // /v1/solvernets/drafts/:id/launch — fall through to the next handler.
    if (segments[4] === 'launch') return route.fallback();

    const id = decodeURIComponent(segments[3] ?? '');
    const req = route.request();
    if (req.method() === 'GET') {
      if (!state.draft || (state.draft.draftId as string) !== id) {
        return route.fulfill({
          status: 404,
          contentType: 'application/json',
          body: JSON.stringify({ error: 'draft_not_found' }),
        });
      }
      return route.fulfill({
        contentType: 'application/json',
        body: JSON.stringify(state.draft),
      });
    }
    if (req.method() === 'PATCH') {
      if (!state.draft || (state.draft.draftId as string) !== id) {
        return route.fulfill({
          status: 404,
          contentType: 'application/json',
          body: JSON.stringify({ error: 'draft_not_found' }),
        });
      }
      const patch = (req.postDataJSON?.() ?? {}) as Record<string, unknown>;
      const next = {
        ...state.draft,
        ...patch,
        draftId: id,
        updatedAt: new Date().toISOString(),
      };
      state.draft = next;
      return route.fulfill({
        contentType: 'application/json',
        body: JSON.stringify(next),
      });
    }
    if (req.method() === 'DELETE') {
      state.draft = null;
      return route.fulfill({
        contentType: 'application/json',
        body: JSON.stringify({ ok: true }),
      });
    }
    return route.fulfill({ status: 405, body: 'method not allowed' });
  });

  // ── Launch ──────────────────────────────────────────────────────────────
  await page.route('**/v1/solvernets/drafts/*/launch', async (route: Route) => {
    const url = new URL(route.request().url());
    const segments = url.pathname.split('/').filter(Boolean);
    const draftId = decodeURIComponent(segments[3] ?? '');
    if (!state.draft || (state.draft.draftId as string) !== draftId) {
      return route.fulfill({
        status: 404,
        contentType: 'application/json',
        body: JSON.stringify({ error: 'draft_not_found' }),
      });
    }
    state.observedLaunches.push({ draftId });
    return route.fulfill({
      status: 202,
      contentType: 'application/json',
      body: JSON.stringify({
        solverNetId: SOLVER_NET_ID,
        status: 'launching',
        pollUrl: `/v1/solvernets/launched/${SOLVER_NET_ID}`,
      }),
    });
  });

  await page.route('**/v1/solvernets/launched/*/lifecycle', async (route) => {
    if (route.request().method() !== 'PATCH') {
      return route.fulfill({ status: 405, body: 'method not allowed' });
    }
    return fulfillLifecycleTransition(route, state);
  });

  // ── Launched-record polling ────────────────────────────────────────────
  await page.route('**/v1/solvernets/launched/*', async (route) => {
    const url = new URL(route.request().url());
    const segments = url.pathname.split('/').filter(Boolean);
    const id = decodeURIComponent(segments[3] ?? '');
    const sub = segments[4];
    const req = route.request();

    if (sub === 'lifecycle' && req.method() === 'PATCH') {
      return fulfillLifecycleTransition(route, state);
    }

    // Only the bare GET /launched/:id and PATCH /lifecycle are in scope.
    // Anything else gets a 405 to make missing coverage loud.
    if (sub === undefined && req.method() === 'GET') {
      if (id !== SOLVER_NET_ID) {
        return route.fulfill({
          status: 404,
          contentType: 'application/json',
          body: JSON.stringify({ error: 'record_not_found' }),
        });
      }
      if (state.launchedRecord) {
        state.launchedReadCount += 1;
        return route.fulfill({
          contentType: 'application/json',
          body: JSON.stringify(state.launchedRecord),
        });
      }
      const idx = state.launchedReadCount;
      state.launchedReadCount += 1;
      return route.fulfill({
        contentType: 'application/json',
        body: JSON.stringify(buildLaunchedSnapshot(idx)),
      });
    }
    return route.fulfill({ status: 405, body: 'method not allowed' });
  });

  // Bare /launched (no id) — returns owned list. The post-launch dashboard
  // doesn't read this in the happy path, but the Launcher overview does.
  await page.route('**/v1/solvernets/launched', async (route) => {
    return route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({
        records: state.launchedRecord ? [state.launchedRecord] : [],
      }),
    });
  });

  // Registry catalog (post-launch dashboard fetches the manifest body for
  // the launched cid via /v1/solvernets/registry/:cid).
  await page.route('**/v1/solvernets/registry**', async (route) => {
    const url = new URL(route.request().url());
    const segments = url.pathname.split('/').filter(Boolean);
    if (segments.length === 3) {
      // List
      return route.fulfill({
        contentType: 'application/json',
        body: JSON.stringify({
          summaries: state.registrySummaries,
          lastRefreshedAt: new Date().toISOString(),
          lastError: null,
        }),
      });
    }
    if (segments.length === 4) {
      return route.fulfill({
        contentType: 'application/json',
        body: JSON.stringify({
          manifest: MOCK_MANIFEST,
          lifecycle: {
            status: 'launched',
            statusUpdatedAt: '2026-05-05T00:00:00.000Z',
            sourceBlock: 12345,
          },
        }),
      });
    }
    return route.fulfill({ status: 404, body: 'not handled' });
  });
}

// ── Test helpers ─────────────────────────────────────────────────────────────

async function clearLocalStorage(page: Page): Promise<void> {
  // The Create wizard persists `draftId` to localStorage. Tests must
  // start clean so they don't pick up a stale id from a prior run.
  await page.addInitScript(() => {
    try {
      window.localStorage.clear();
    } catch {
      // best-effort
    }
  });
}

function dashboardUrl(path = '/'): string {
  const url = new URL(handshakeUrl ?? `http://127.0.0.1:${PORT}/`);
  url.pathname = path;
  return url.toString();
}

// ── Tests ────────────────────────────────────────────────────────────────────

test('Launcher happy-path: walks Create wizard and lands on the post-launch dashboard at /launcher/launched/sn-test-1', async ({
  page,
}) => {
  await clearLocalStorage(page);
  const state = makeMockState();
  await mockDaemonApi(page, state);

  // Land on Operator (default mode).
  await page.goto(handshakeUrl ?? `http://127.0.0.1:${PORT}/`);
  await expect(page.getByText('jinn operator')).toBeVisible();

  // Navigate directly to the Launcher page. The Launcher tab is only
  // conditionally rendered in TopTabs when there are already launched records
  // or the current route is under /launcher — so clicking it from the
  // overview (with an empty state) is not possible; use direct navigation
  // instead (mirrors the approach used by the passing lifecycle-transitions
  // test and the sibling join.e2e.test.ts).
  await page.goto(dashboardUrl('/launcher'));

  // Empty-state CTA appears — click "Create SolverNet".
  await expect(page.getByText(/no solvernets created yet\./i)).toBeVisible();
  await page.getByRole('link', { name: /^create solvernet$/i }).click();
  await expect(page.getByTestId('launcher-create-step-1')).toBeVisible();

  // ── Step 1 — Define ─────────────────────────────────────────────────────
  await page.getByTestId('launcher-create-name').fill('Polymarket forecasts');
  await page
    .getByTestId('launcher-create-description')
    .fill(
      'Forecast resolved Polymarket outcomes; rewarded by Brier score on verified resolutions.',
    );
  await page.getByTestId('launcher-create-next').click();
  await expect(page.getByTestId('launcher-create-step-2')).toBeVisible();

  // ── Step 2 — Review contract (read-only) ────────────────────────────────
  await page.getByTestId('launcher-create-next').click();
  await expect(page.getByTestId('launcher-create-step-3')).toBeVisible();

  // ── Step 3 — Configure generator (defaults pre-filled) ──────────────────
  await page.getByTestId('launcher-create-next').click();
  await expect(page.getByTestId('launcher-create-step-4')).toBeVisible();

  // ── Step 4 — Pricing ────────────────────────────────────────────────────
  await page
    .getByTestId('launcher-create-solutionPriceWei')
    .fill('100000000000000');
  await page
    .getByTestId('launcher-create-verdictPriceWei')
    .fill('50000000000000');
  await page.getByTestId('launcher-create-next').click();
  await expect(page.getByTestId('launcher-create-step-5')).toBeVisible();

  // ── Step 5 — Review & Launch ────────────────────────────────────────────
  await expect(page.getByTestId('launcher-create-manifest-summary')).toBeVisible();
  // Both roles are checked by default. Click Launch (StepNav's Next btn).
  await page.getByTestId('launcher-create-next').click();

  // The SPA polls GET /v1/solvernets/launched/sn-test-1 on a 1.5s
  // interval; our mock sequence flips to `launched` on the third call,
  // at which point the SPA navigates to the post-launch dashboard.
  await expect(page).toHaveURL(/\/launcher\/launched\/sn-test-1$/, {
    timeout: 15_000,
  });
  await expect(page.getByTestId('launcher-launched')).toBeVisible({
    timeout: 10_000,
  });
  await expect(page.getByTestId('launcher-launched-status-badge')).toContainText(
    /launched/i,
    { timeout: 10_000 },
  );
  await expect(page.getByTestId('launcher-launched-name')).toContainText(
    'Polymarket forecasts',
  );
  await expect(page.getByTestId('launcher-launched-spend-solution-price')).not.toHaveText('—');
  await expect(page.getByTestId('launcher-launched-spend-verdict-price')).not.toHaveText('—');

  // Daemon-side assertions: the launch fired exactly once against our
  // draft and the launched record is being polled.
  expect(state.observedLaunches).toEqual([{ draftId: DRAFT_ID }]);
  expect(state.launchedReadCount).toBeGreaterThanOrEqual(3);
});

test('Launcher lifecycle transitions: Pause, Resume, Retire send lifecycle requests and update status', async ({
  page,
}) => {
  await clearLocalStorage(page);
  const state = makeMockState({
    launchedRecord: buildLaunchedRecord(),
  });
  await mockDaemonApi(page, state);

  await page.goto(dashboardUrl(`/launcher/launched/${SOLVER_NET_ID}`));
  await expect(page.getByTestId('launcher-launched')).toBeVisible({
    timeout: 10_000,
  });
  await expect(page.getByTestId('launcher-launched-status-badge')).toContainText(
    /launched/i,
  );

  await page.getByTestId('launcher-launched-action-paused').click();
  await expect(page.getByTestId('launcher-launched-dialog')).toHaveAttribute(
    'data-target',
    'paused',
  );
  await page.getByTestId('launcher-launched-dialog-confirm').click();
  await expect(page.getByTestId('launcher-launched-status-badge')).toContainText(
    /paused/i,
  );

  await page.getByTestId('launcher-launched-action-launched').click();
  await expect(page.getByTestId('launcher-launched-dialog')).toHaveAttribute(
    'data-target',
    'launched',
  );
  await page.getByTestId('launcher-launched-dialog-confirm').click();
  await expect(page.getByTestId('launcher-launched-status-badge')).toContainText(
    /launched/i,
  );

  await page.getByTestId('launcher-launched-action-retired').click();
  await expect(page.getByTestId('launcher-launched-dialog')).toHaveAttribute(
    'data-target',
    'retired',
  );
  await expect(page.getByTestId('launcher-launched-dialog-confirm')).toBeDisabled();
  await page
    .getByTestId('launcher-launched-dialog-typed')
    .fill(MOCK_MANIFEST.name);
  await expect(page.getByTestId('launcher-launched-dialog-confirm')).toBeEnabled();
  await page.getByTestId('launcher-launched-dialog-confirm').click();
  await expect(page.getByTestId('launcher-launched-status-badge')).toContainText(
    /retired/i,
  );
  await expect(page.getByTestId('launcher-launched-terminal-pill')).toBeVisible();

  expect(state.observedLifecycleRequests).toEqual([
    {
      method: 'PATCH',
      solverNetId: SOLVER_NET_ID,
      payload: { target: 'paused' },
    },
    {
      method: 'PATCH',
      solverNetId: SOLVER_NET_ID,
      payload: { target: 'launched' },
    },
    {
      method: 'PATCH',
      solverNetId: SOLVER_NET_ID,
      payload: { target: 'retired' },
    },
  ]);
});

test('Launched dashboard renders generator runtime posting activity (total posted + last posted) at the app surface (#471)', async ({
  page,
}) => {
  await clearLocalStorage(page);
  const state = makeMockState({
    launchedRecord: buildLaunchedRecord({
      generatorState: {
        lastPollAt: '2026-05-05T15:00:00.000Z',
        totalPosted: 7,
        lastPostedInstanceId: 'astropy__astropy-14096',
      },
    }),
  });
  await mockDaemonApi(page, state);

  await page.goto(dashboardUrl(`/launcher/launched/${SOLVER_NET_ID}`));
  await expect(page.getByTestId('launcher-launched')).toBeVisible({
    timeout: 10_000,
  });

  // Recent posting activity is exposed by the launched-record API's
  // generatorState and rendered on the launched dashboard's generator panel.
  await expect(
    page.getByTestId('launcher-launched-generator-total-posted'),
  ).toHaveText('7');
  await expect(
    page.getByTestId('launcher-launched-generator-last-posted'),
  ).toHaveText('astropy__astropy-14096');
  // Last poll also renders (sibling row in the same runtime-state grid).
  await expect(
    page.getByTestId('launcher-launched-generator-last-poll'),
  ).not.toHaveText('—');
});

test('Launched dashboard self-hides total-posted / last-posted rows when the generator omits them (#471)', async ({
  page,
}) => {
  await clearLocalStorage(page);
  // buildLaunchedRecord's default generatorState carries only lastPollAt —
  // the prediction.v1 generator does not emit totalPosted / lastPostedInstanceId.
  const state = makeMockState({
    launchedRecord: buildLaunchedRecord(),
  });
  await mockDaemonApi(page, state);

  await page.goto(dashboardUrl(`/launcher/launched/${SOLVER_NET_ID}`));
  await expect(page.getByTestId('launcher-launched')).toBeVisible({
    timeout: 10_000,
  });
  // The generator panel is present…
  await expect(
    page.getByTestId('launcher-launched-generator-panel'),
  ).toBeVisible();
  // …but the two posting-activity rows self-hide when the fields are absent.
  await expect(
    page.getByTestId('launcher-launched-generator-total-posted'),
  ).toHaveCount(0);
  await expect(
    page.getByTestId('launcher-launched-generator-last-posted'),
  ).toHaveCount(0);
});

test('Launched dashboard surfaces the vetted-pool stale notice, distinct from re-published, at the app surface (#796)', async ({
  page,
}) => {
  await clearLocalStorage(page);
  const state = makeMockState({
    launchedRecord: buildLaunchedRecord({
      generatorState: { poolPublicationStale: true },
    }),
  });
  await mockDaemonApi(page, state);

  await page.goto(dashboardUrl(`/launcher/launched/${SOLVER_NET_ID}`));
  await expect(page.getByTestId('launcher-launched')).toBeVisible({
    timeout: 10_000,
  });

  // The warning notice renders when the daemon flags the pool as stale…
  await expect(
    page.getByTestId('launcher-launched-generator-pool-stale'),
  ).toBeVisible();
  await expect(
    page.getByTestId('launcher-launched-generator-pool-stale'),
  ).toContainText('Vetted pool re-publish needed');
  // …and it is DISTINCT from the re-published notice, which is absent here.
  await expect(
    page.getByTestId('launcher-launched-generator-pool-republished'),
  ).toHaveCount(0);
});

test('Fresh daemon empty states show no launched operator catalog and no owned launcher SolverNets', async ({
  page,
}) => {
  await clearLocalStorage(page);
  const state = makeMockState();
  await mockDaemonApi(page, state);

  // Navigate directly to /operator/registry — the TopTabs label for /operator
  // is "Settings" (not "operator"), and the registry catalog empty state lives
  // at /operator/registry, not /operator (which redirects to /operator/claim-policy).
  await page.goto(dashboardUrl('/operator/registry'));
  await expect(page.getByText('jinn operator')).toBeVisible();

  await expect(page.getByTestId('registry-catalog-empty')).toContainText(
    'No launched SolverNets available.',
  );

  // Navigate directly to /launcher — the Launcher tab in TopTabs is only
  // rendered when there are owned launched records or the current route is
  // under /launcher, so clicking it from the registry page (empty state) is
  // not possible.
  await page.goto(dashboardUrl('/launcher'));
  await expect(page.getByTestId('launcher-empty-state')).toContainText(
    'No SolverNets created yet.',
  );
});
