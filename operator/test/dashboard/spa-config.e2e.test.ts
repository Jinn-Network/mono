/**
 * Page-split happy-path: navigate Overview → Settings → Memberships, and see
 * a restart notification raised by a surviving write path follow the operator
 * across routes.
 *
 * The existing setup-mode harness in spa.e2e.test.ts spawns a real daemon
 * that serves the SPA bundle from dist/dashboard. This test mocks the
 * daemon's API responses at the page level (Playwright route interception)
 * so the SPA renders running-mode without needing a live bootstrapped
 * fleet. It exercises the SPA wiring, not the daemon's bootstrap.
 *
 * HISTORY — this file has been repointed twice as its subject surfaces moved.
 * It first drove "check the Evaluator box alongside Solver, then Save"; roles
 * became immutable post-join, so it moved to an edit on the joined card
 * (POST /v1/operator/join/<cid> → `restartRequired` → notification). Wave-4 D1
 * (DR-2026-08-05) then retired the join write path entirely, and with it the
 * joined card's expand / model-select / Save controls.
 *
 * What survived is what this test now drives:
 *   1. Memberships is a READ view (OPERATOR-APP-SPEC §2.4 keeps it as the
 *      legacy view until cutover stage 5). GET /v1/operator/joined renders one
 *      read-only row per configured SolverNet, and the page offers no control
 *      that would write config.
 *   2. The restart-required journey moves to the surviving claim authority:
 *      PUT /v1/operator/claim-policy latches the daemon's `isRestartRequired()`
 *      flag (`restart-required-state.ts`), and `GET /v1/notifications` serves
 *      the resulting notice on EVERY route — which is the cross-route claim
 *      this test is really here to make, and the reason it asserts the notice
 *      on /operator/memberships rather than on the page that caused it.
 *
 * MIGRATED for #2408 (server-side notifications). `restart_required` is no
 * longer derived in the browser: `useNotifications.ts` is a thin fetcher over
 * `GET /v1/notifications`, and the daemon sets an explicit `isRestartRequired()`
 * flag on the write paths it never hot-applies, then serves the already-derived
 * notice. So the mock daemon is driven statefully (empty list until the write
 * fires, the notice afterwards) and the assertion is made after a reload, which
 * is the sharper claim: the pre-#2408 session-local `RestartPendingContext` flag
 * could never have survived one.
 */
import { test, expect, type Route } from '@playwright/test';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mockDaemonApi, makeRegistryManifestResponse } from './helpers/mock-daemon-api';

const PORT = 17332;

/** The manifest cid of the SolverNet this operator's config declares. */
const JOINED_CID = 'bafkreiopalaunchedsolvernet0000000000000000000000000000';

let daemon: ChildProcess | null = null;
let homeDir = '';
let handshakeUrl: string | null = null;


test.beforeAll(async () => {
  homeDir = mkdtempSync(join(tmpdir(), 'jinn-spa-config-e2e-'));
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

  // Wait for /v1/bootstrap to be reachable (we'll mock it once the page loads).
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


test('operator opens the Settings tab, saves claim policy, and sees the restart notification on the read-only Memberships view', async ({ page }) => {
  await mockDaemonApi(page);

  /**
   * Stands in for the daemon's `isRestartRequired()` flag (`restart-required-state.ts`),
   * which the claim-policy write path sets and `/v1/notifications` reads. Flipped by
   * the PUT route below, consumed by the notifications route below that.
   */
  let restartRequired = false;

  // Per-test overrides, registered AFTER mockDaemonApi so they win.
  // 1. one already-configured SolverNet for MembershipsTab to render.
  await page.route(
    (url) => url.pathname === '/v1/operator/joined',
    (route) =>
      route.fulfill({
        contentType: 'application/json',
        body: JSON.stringify({
          joinedSolverNets: {
            [JOINED_CID]: {
              manifestCid: JOINED_CID,
              name: 'Prediction Markets',
              contract: { id: 'prediction', version: 'v1' },
              roles: ['solver'],
              harness: 'claude-code-learner',
              model: 'claude-haiku-4-5-20251001',
              plugins: ['jinn-prediction-plugin'],
            },
          },
        }),
      }),
  );
  // 2. the per-CID manifest, kept from the pre-D1 version of this test: the
  //    registry surface still resolves it, and serving it proves the read view
  //    does not depend on it.
  await page.route(
    (url) => url.pathname === `/v1/solvernets/registry/${JOINED_CID}`,
    (route) =>
      route.fulfill({
        contentType: 'application/json',
        body: JSON.stringify(makeRegistryManifestResponse({ manifestCid: JOINED_CID })),
      }),
  );
  // 3. claim policy — the GET seeds the editor; the PUT reports the change needs a
  //    restart AND, like the real write path, latches the daemon-side flag that
  //    `/v1/notifications` derives its notice from.
  await page.route(
    (url) => url.pathname === '/v1/operator/claim-policy',
    (route: Route) => {
      if (route.request().method() === 'PUT') {
        restartRequired = true;
        return route.fulfill({
          contentType: 'application/json',
          body: JSON.stringify({ restartRequired: true }),
        });
      }
      return route.fulfill({
        contentType: 'application/json',
        body: JSON.stringify({
          claimPolicy: { mode: 'every-runnable' },
          executionWiring: [
            {
              workKind: 'prediction.v1',
              harness: 'claude-code-learner',
              model: 'claude-haiku-4-5-20251001',
              plugins: ['jinn-prediction-plugin'],
              credentialRef: 'default',
              isolationPolicy: 'worktree',
            },
          ],
          restartRequired: false,
        }),
      });
    },
  );
  // 4. `/v1/notifications` (#2408), served from that flag: empty before the save, carrying the
  //    notice `notifications-build.ts` emits for `restartRequired` after it. Registered AFTER
  //    mockDaemonApi so it beats the default empty payload — Playwright checks routes in
  //    reverse-registration order, the same idiom password-rotation-notification.e2e.test.ts uses.
  await page.route(
    (url) => url.pathname === '/v1/notifications',
    (route) =>
      route.fulfill({
        contentType: 'application/json',
        body: JSON.stringify({
          schemaVersion: 1,
          generatedAt: new Date().toISOString(),
          notifications: restartRequired
            ? [
                {
                  kind: 'restart_required',
                  severity: 'warning',
                  title: 'Restart required',
                  message: 'A configuration change is pending — restart to apply.',
                  jumpTo: '/overview',
                },
              ]
            : [],
        }),
      }),
  );

  await page.goto(handshakeUrl ?? `http://127.0.0.1:${PORT}/`);

  await expect(page.getByText('jinn operator')).toBeVisible();

  // The Settings top tab exists and points at the operator section. Asserted
  // as a link rather than clicked through: `/operator` redirects to whichever
  // sub-route is currently the default landing tab, and that default has
  // already moved once (memberships → claim-policy). Driving the journey
  // through the redirect would couple this test to that choice.
  await expect(page.getByRole('link', { name: /^settings$/i })).toHaveAttribute(
    'href',
    '/operator',
  );

  const origin = new URL(page.url()).origin;

  // ── Memberships is a read view ──────────────────────────────────────────
  await page.goto(`${origin}/operator/memberships`);
  await expect(page).toHaveURL(/\/operator\/memberships$/);

  // `data-manifest-cid` lives on the card element itself, so match it as one
  // compound selector — `.filter({ has })` would look for a descendant.
  const card = page
    .locator(`[data-testid="joined-net-card"][data-manifest-cid="${JOINED_CID}"]`)
    .first();
  await expect(card).toBeVisible({ timeout: 15_000 });
  await expect(card.getByTestId('joined-net-card-name')).toHaveText('Prediction Markets');
  await expect(card.getByTestId('joined-net-card-role-solver')).toBeVisible();
  await expect(card).toContainText('claude-haiku-4-5-20251001');

  // The join lifecycle is gone, so the page must offer nothing that would
  // write config. Pin the absence — a regrown control here would POST at a
  // route that no longer exists.
  await expect(page.getByTestId('memberships-tab').getByRole('button')).toHaveCount(0);
  await expect(card.getByTestId('joined-net-card-toggle')).toHaveCount(0);
  await expect(card.getByTestId('joined-net-card-save')).toHaveCount(0);
  await expect(card.getByTestId('joined-net-card-leave')).toHaveCount(0);

  // ── A surviving write raises the notice, which follows across routes ─────
  await page.goto(`${origin}/operator/claim-policy`);
  await expect(page.getByTestId('claim-policy-tab')).toBeVisible({ timeout: 15_000 });
  await page.getByTestId('claim-policy-spend-cap').fill('250000000000000');

  const savePut = page.waitForResponse(
    (res) =>
      new URL(res.url()).pathname === '/v1/operator/claim-policy' &&
      res.request().method() === 'PUT',
  );
  await page.getByTestId('claim-policy-save').click();
  await savePut;

  // Post-#2408 the notice is server state, not session state: the save latched the daemon's
  // restart-required flag, so the next `GET /v1/notifications` carries `restart_required`.
  // Reload onto a DIFFERENT route rather than waiting out `useNotifications`' 30s
  // `refetchInterval` — it is both faster and the stronger assertion, since the flag now
  // outlives both the browser session that set it and the page that caused it (the removed
  // `RestartPendingContext` boolean was lost on any reload).
  await page.goto(`${origin}/operator/memberships`);

  // AppShell mounts `useNotifications` on every route, so the notice renders here on
  // /operator/memberships. Stable data-kind hook from NotificationItem; copy may evolve.
  const restartNotice = page.locator('[data-kind="restart_required"]');
  await expect(restartNotice).toBeVisible({ timeout: 15_000 });
  await expect(restartNotice).toHaveAttribute('data-severity', 'warning');
  await expect(restartNotice).toHaveCount(1);
  // Message text from notifications-build.ts.
  await expect(restartNotice).toContainText('restart to apply');
});
