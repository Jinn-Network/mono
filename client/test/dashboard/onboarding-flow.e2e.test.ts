/**
 * #983 — post-flip guided onboarding, end to end against a mocked daemon API.
 *
 * Validates:
 *  1. App holds the onboarding takeover while the daemon is `running` but
 *     onboardingComplete is absent (the MEDIUM eject-before-harness bug).
 *  2. Once the bootstrap is terminal, rail step 4 goes active and mounts the
 *     harness READINESS card, sourced from the composed
 *     `GET /v1/harnesses/readiness` snapshot and tolerating the brief 503
 *     `subsystem_not_ready` window after the flip.
 *  3. Enter dashboard → POST /v1/operator/onboarding-complete; once bootstrap
 *     reports onboardingComplete:true the takeover drops to <Operating>.
 *  4. No membership write fires anywhere in the takeover.
 *
 * REPOINTED for Wave-4 D1 (DR-2026-08-05). The takeover used to have a
 * "Pick your first SolverNet" step that POSTed /v1/operator/join/<cid>, and an
 * "Enter dashboard" button that re-joined to persist the chosen harness +
 * model. D1 deleted both routes. The step-4 assertions therefore move from
 * "the rail's SolverNet step is active and its card carries the real cid" to
 * "the rail's readiness step is active and reports what this machine can run",
 * and the join assertions invert: the test now pins that ZERO join requests
 * fire, because a takeover that silently discarded the operator's answers is
 * exactly the bug this repoint exists to prevent.
 *
 * Like spa-config.e2e.test.ts this mocks the daemon's API at the page level so
 * the SPA renders without a live bootstrapped fleet. The mocks are mutable
 * closures so the test can drive the readiness 503→200 self-heal and the
 * bootstrap onboardingComplete transition.
 */
import { test, expect } from '@playwright/test';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const PORT = 17333;
const SWE_CID = 'bafkreichswerebenchv2example983';

let daemon: ChildProcess | null = null;
let homeDir = '';
let handshakeUrl: string | null = null;

test.beforeAll(async () => {
  homeDir = mkdtempSync(join(tmpdir(), 'jinn-onboarding-e2e-'));
  const distBin = join(process.cwd(), 'dist', 'bin', 'jinn.js');
  if (!existsSync(distBin)) {
    throw new Error('dist/bin/jinn.js missing — run `yarn build` first');
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

test('post-flip onboarding: confirm harness readiness, complete, drop the takeover', async ({
  page,
}) => {
  // ── Mutable mock state ───────────────────────────────────────────────────
  // The takeover holds until onboardingComplete flips true; the readiness
  // snapshot 503s once (the post-flip registry-holder window), then serves.
  let onboardingComplete = false;
  let registryServed = false; // first poll 503s, subsequent polls 200
  let readinessServed = false; // first poll 503s, subsequent polls 200
  const joinedSolverNets: Record<string, unknown> = {};
  const joinRequests: string[] = [];
  let onboardingCompletePosts = 0;

  const j = (body: unknown): { contentType: string; body: string } => ({
    contentType: 'application/json',
    body: JSON.stringify(body),
  });

  const sweSummary = {
    manifestCid: SWE_CID,
    solverNetId: 'sn-swe-1',
    name: 'SWE-rebench v2',
    network: 'base-sepolia',
    launcherAgentId: '42',
    launcherSafeAddress: '0xabc0000000000000000000000000000000000001',
    status: 'launched',
    statusUpdatedAt: '2026-06-01T00:00:00.000Z',
    contractId: 'swe-rebench-v2',
    contractVersion: 'v1',
    solutionPriceWei: '0',
    verdictPriceWei: '0',
    openRoles: ['solver', 'evaluator'],
    anchorBlock: 1,
  };

  // bootstrap: running, terminal step, onboardingComplete toggled by the test.
  await page.route(
    (url) => url.pathname === '/v1/bootstrap',
    (route) =>
      route.fulfill(
        j({
          schemaVersion: 1,
          mode: 'running',
          steps: ['complete'],
          currentStep: 'complete',
          services: [
            { index: 1, step: 'complete', safe_address: '0x0e767E28C6889CcD0DfB88E631a3702D56Ce24FC' },
          ],
          master_address: '0xE64bAf0073a71b0Cb2C0558bB16f24b45E1FB5CF',
          chain: 'base-sepolia',
          rpcUrl: 'https://sepolia.base.org',
          defaultRpcUrl: 'https://sepolia.base.org',
          joinedSolverNets,
          ...(onboardingComplete ? { onboardingComplete: true } : {}),
        }),
      ),
  );

  await page.route(
    (url) => url.pathname === '/v1/status',
    (route) =>
      route.fulfill(
        j({
          schemaVersion: 1,
          fleet: { services: [{ index: 1, step: 'complete', safeAddress: '0x0e767E28C6889CcD0DfB88E631a3702D56Ce24FC', agentId: 5474, safeBoundToAgent: true }] },
          rewards: {},
          masterGas: { balanceWei: '0', runwayDaysExcess: '4' },
        }),
      ),
  );

  // Registry: first poll 503 subsystem_not_ready, then 200 with the summary.
  await page.route(
    (url) => url.pathname === '/v1/solvernets/registry',
    (route) => {
      if (!registryServed) {
        registryServed = true;
        return route.fulfill({
          status: 503,
          contentType: 'application/json',
          body: JSON.stringify({ error: 'subsystem_not_ready' }),
        });
      }
      return route.fulfill(
        j({ summaries: [sweSummary], lastRefreshedAt: '2026-06-01T00:00:00.000Z', lastError: null }),
      );
    },
  );

  // Per-harness readiness — the catch-all, for any single-harness probe some
  // other surface makes. Registered FIRST so the composed-snapshot route below
  // beats it: Playwright checks routes in reverse-registration order, and
  // `/v1/harnesses/readiness` matches this prefix too.
  await page.route(
    (url) => url.pathname.startsWith('/v1/harnesses/'),
    (route) => route.fulfill(j({ harnessName: 'codex', manifestCids: [], ready: true })),
  );
  // Harness readiness — the composed snapshot the step-4 card reads. First
  // poll 503 subsystem_not_ready (the registry holder is populated post-flip),
  // then 200 with one ready harness. The card must self-heal, not latch a
  // false "not ready".
  await page.route(
    (url) => url.pathname === '/v1/harnesses/readiness',
    (route) => {
      if (!readinessServed) {
        readinessServed = true;
        return route.fulfill({
          status: 503,
          contentType: 'application/json',
          body: JSON.stringify({ error: 'subsystem_not_ready' }),
        });
      }
      return route.fulfill(
        j({
          lastRefreshedAt: '2026-06-01T00:00:00.000Z',
          harnesses: [{ harnessName: 'codex', manifestCids: [], ready: true }],
        }),
      );
    },
  );

  // The join routes are GONE (Wave-4 D1). This mock exists only so a rogue
  // request is RECORDED rather than falling through to the real daemon and
  // 404-ing quietly; the assertion below is that it never fires.
  await page.route(
    // Deliberately NOT `startsWith('/v1/operator/join')` — that would also
    // swallow `/v1/operator/joined`, the read this SPA still makes.
    (url) => url.pathname === '/v1/operator/join' || url.pathname.startsWith('/v1/operator/join/'),
    (route) => {
      joinRequests.push(`${route.request().method()} ${new URL(route.request().url()).pathname}`);
      return route.fulfill({ status: 404, contentType: 'application/json', body: '{}' });
    },
  );

  // onboarding-complete — record the POST and flip the bootstrap flag.
  await page.route(
    (url) => url.pathname === '/v1/operator/onboarding-complete',
    (route) => {
      onboardingCompletePosts += 1;
      onboardingComplete = true;
      return route.fulfill(j({ ok: true, onboardingComplete: true }));
    },
  );

  // Endpoints the takeover / operating shell otherwise touches.
  await page.route(
    (url) => url.pathname === '/v1/operator/joined',
    (route) => route.fulfill(j({ joinedSolverNets })),
  );
  await page.route(
    (url) => url.pathname === '/v1/operator/execution-data',
    (route) => route.fulfill(j({ schemaVersion: 1, generatedAt: new Date().toISOString(), source: 'served', pricing: { publicEndpoint: '', defaultPriceUsdc: '0', perArtifactTypePrice: {}, donation: { enabled: false } }, summary: { served: { totalCount: 0, totalBytes: 0, freeCount: 0, gatedCount: 0, latestCreatedAt: null, artifactTypes: [] }, network: { totalCount: 0, totalBytes: 0, latestFetchedAt: null, artifactTypes: [] }, access: { accessCount: 0, paidServeCount: 0, freeServeCount: 0, failedPaymentCount: 0, paymentRequiredCount: 0, revenueUsdc: '0', lastAccessAt: null, lastPaidAt: null } }, recentAccesses: [], artifacts: [] })),
  );
  await page.route(
    (url) => url.pathname === '/v1/discovery/task-post-counts',
    (route) => route.fulfill(j({ chain: { h1: 0, h6: 0, h24: 0 }, byCid: {} })),
  );
  await page.route(
    (url) => url.pathname.startsWith('/v1/discovery/'),
    (route) => route.fulfill(j({ items: [], total: 0 })),
  );
  await page.route(
    (url) => url.pathname === '/api/captures/pending',
    (route) => route.fulfill(j({ pending: [] })),
  );
  await page.route(
    (url) => url.pathname === '/v1/events',
    (route) =>
      route.fulfill({ contentType: 'text/event-stream', headers: { 'Cache-Control': 'no-cache', 'X-Accel-Buffering': 'no' }, body: '' }),
  );
  await page.route(
    (url) => url.pathname.startsWith('/v1/activity-events'),
    (route) => route.fulfill(j({ events: [], nextCursor: null, counts: {} })),
  );
  await page.route(
    (url) => url.pathname.startsWith('/v1/auth/'),
    (route) => route.fulfill(j({ authenticated: false, context: 'bare', detail: 'mock' })),
  );
  await page.route(
    (url) => url.pathname.startsWith('/auth/handshake'),
    (route) => route.fulfill({ contentType: 'application/json', body: '{"ok":true}' }),
  );

  // ── Drive the flow ───────────────────────────────────────────────────────
  await page.goto(handshakeUrl ?? `http://127.0.0.1:${PORT}/`);

  // 1. Takeover is held: onboarding progress shows, the operating shell does not.
  await expect(page.getByTestId('onboarding-progress')).toBeVisible();
  // The readiness step (rail step 4) is active once the bootstrap is terminal.
  await expect(page.getByTestId('onboarding-phase-4')).toHaveAttribute('data-status', 'active');
  await expect(page.getByTestId('overview-page-grid')).toHaveCount(0);

  // 2. The readiness card mounts and self-heals from the 503 window to the
  //    composed snapshot — one row per harness this build registers.
  const card = page.getByTestId('onboarding-harness-card');
  await expect(card).toBeVisible({ timeout: 15_000 });
  await expect(page.getByTestId('onboarding-harness-row-codex')).toHaveAttribute(
    'data-ready',
    'true',
    { timeout: 15_000 },
  );

  // 3. The step asks no question: no SolverNet card, no harness radio, no model
  //    select. Anything it collected here would be discarded — the write paths
  //    that used to persist those answers are gone.
  await expect(page.getByTestId('onboarding-solvernet-card')).toHaveCount(0);
  await expect(page.getByTestId('onboarding-model-select')).toHaveCount(0);

  // 4. Enter dashboard is open on arrival — readiness is reported, not enforced.
  const enter = page.getByTestId('onboarding-enter-dashboard');
  await expect(enter).toBeEnabled({ timeout: 15_000 });

  // 5. Enter dashboard fires exactly one POST /v1/operator/onboarding-complete
  //    and nothing else.
  await enter.click();
  await expect.poll(() => onboardingCompletePosts).toBe(1);

  // 6. With bootstrap now reporting onboardingComplete:true the takeover drops
  //    to <Operating> (the overview grid renders; the takeover is gone).
  await expect(page.getByTestId('overview-page-grid')).toBeVisible({ timeout: 15_000 });
  await expect(page.getByTestId('onboarding-progress')).toHaveCount(0);

  // 7. The whole journey wrote no membership. This is the assertion that would
  //    have caught a takeover still POSTing at a deleted route.
  expect(joinRequests).toEqual([]);
});
