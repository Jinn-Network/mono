/**
 * Page-split happy-path: navigate Overview → Settings → Memberships, edit a
 * joined SolverNet, save, and see the restart notification.
 *
 * The existing setup-mode harness in spa.e2e.test.ts spawns a real daemon
 * that serves the SPA bundle from dist/dashboard. This test mocks the
 * daemon's API responses at the page level (Playwright route interception)
 * so the SPA renders running-mode without needing a live bootstrapped
 * fleet. It exercises the SPA wiring, not the daemon's bootstrap.
 *
 * HISTORY — this file used to drive "check the Evaluator box alongside
 * Solver, then Save". That flow no longer exists: roles are immutable
 * post-join (`JoinedNetCard.tsx` — "Roles are immutable post-join (set by
 * JoinFlow and not editable here — operators leave + rejoin to change
 * roles)"), the top tab is labelled "Settings" rather than "Operator",
 * `/operator` redirects to `/operator/memberships`, and the restart banner
 * became the `restart_required` notification AppShell renders. The test now
 * drives the surviving equivalent of the same wiring — an edit on the joined
 * card → POST /v1/operator/join/<cid> → `restartRequired` → notification —
 * because that is what the original was actually guarding.
 *
 * MIGRATED for #2408 (server-side notifications). `restart_required` is no
 * longer derived in the browser: `useNotifications.ts` is a thin fetcher over
 * `GET /v1/notifications`, and the daemon sets an explicit `isRestartRequired()`
 * flag on the three write paths it never hot-applies — `joinedSolverNets` among
 * them — then serves the already-derived notice. So the mock daemon is driven
 * statefully (empty list until the join POST fires, the notice afterwards) and
 * the assertion is made after a reload, which is the sharper claim: the pre-#2408
 * session-local `RestartPendingContext` flag could never have survived one.
 */
import { test, expect } from '@playwright/test';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mockDaemonApi, makeRegistryManifestResponse } from './helpers/mock-daemon-api';

const PORT = 17332;

/** The manifest cid of the SolverNet this operator has already joined. */
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


test('operator opens the Settings tab, edits a joined SolverNet, saves, and sees the restart notification', async ({ page }) => {
  await mockDaemonApi(page);

  /**
   * Stands in for the daemon's `isRestartRequired()` flag (`restart-required-state.ts`),
   * which the `joinedSolverNets` write path sets and `/v1/notifications` reads. Flipped by
   * the join POST route below, consumed by the notifications route below that.
   */
  let restartRequired = false;

  // Per-test overrides, registered AFTER mockDaemonApi so they win.
  // 1. one already-joined SolverNet for MembershipsTab to render.
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
  // 2. the per-CID manifest the card resolves its catalog entry from. Without
  //    it the card treats the membership as orphaned and offers Leave, not Edit.
  await page.route(
    (url) => url.pathname === `/v1/solvernets/registry/${JOINED_CID}`,
    (route) =>
      route.fulfill({
        contentType: 'application/json',
        body: JSON.stringify(makeRegistryManifestResponse({ manifestCid: JOINED_CID })),
      }),
  );
  // 3. the save POST reports the config change needs a restart — and, like the real write
  //    path, latches the daemon-side flag that `/v1/notifications` derives the notice from.
  await page.route(
    (url) => url.pathname === `/v1/operator/join/${JOINED_CID}`,
    (route) => {
      restartRequired = true;
      return route.fulfill({
        contentType: 'application/json',
        body: JSON.stringify({
          ok: true,
          restartRequired: true,
          manifestCid: JOINED_CID,
          config: { manifestCid: JOINED_CID, name: 'Prediction Markets', roles: ['solver'] },
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
  // sub-route is currently the default landing tab, that default has already
  // moved once (memberships → claim-policy), and claim-policy white-screens
  // under this mock — `ClaimPolicyTab` passes `query.data.executionWiring`
  // straight into `entries.length` with no fallback, so a response lacking
  // that field throws and blanks the route. Driving the journey through it
  // would couple this test to an unrelated page's robustness.
  await expect(page.getByRole('link', { name: /^settings$/i })).toHaveAttribute(
    'href',
    '/operator',
  );

  // Go straight to Memberships, where joined SolverNets are edited. Same
  // direct-navigation idiom join.e2e.test.ts uses for /operator/registry.
  const origin = new URL(page.url()).origin;
  await page.goto(`${origin}/operator/memberships`);
  await expect(page).toHaveURL(/\/operator\/memberships$/);

  // `data-manifest-cid` lives on the card element itself, so match it as one
  // compound selector — `.filter({ has })` would look for a descendant.
  const card = page
    .locator(`[data-testid="joined-net-card"][data-manifest-cid="${JOINED_CID}"]`)
    .first();
  await expect(card).toBeVisible({ timeout: 15_000 });
  await expect(card.getByTestId('joined-net-card-name')).toHaveText('Prediction Markets');

  // Expand the edit body, change the model, save.
  await card.getByTestId('joined-net-card-toggle').click();
  await expect(card).toHaveAttribute('data-expanded', 'true');

  const save = card.getByTestId('joined-net-card-save');
  await expect(save).toBeDisabled(); // nothing dirty yet

  await card.getByTestId('joined-net-card-model-select').selectOption('claude-sonnet-4-6');
  await expect(save).toBeEnabled();

  const savePost = page.waitForResponse(
    (res) =>
      new URL(res.url()).pathname === `/v1/operator/join/${JOINED_CID}` &&
      res.request().method() === 'POST',
  );
  await save.click();
  await savePost;

  // Post-#2408 the notice is server state, not session state: the save latched the daemon's
  // restart-required flag, so the next `GET /v1/notifications` carries `restart_required`.
  // Reload rather than waiting out `useNotifications`' 30s `refetchInterval` — it is both
  // faster and the stronger assertion, since the flag now outlives the browser session that
  // set it (the removed `RestartPendingContext` boolean was lost on any reload).
  await page.reload();

  // AppShell mounts `useNotifications` on every route, so the notice renders here on
  // /operator/memberships. Stable data-kind hook from NotificationItem; copy may evolve.
  const restartNotice = page.locator('[data-kind="restart_required"]');
  await expect(restartNotice).toBeVisible({ timeout: 15_000 });
  await expect(restartNotice).toHaveAttribute('data-severity', 'warning');
  await expect(restartNotice).toHaveCount(1);
  // Message text from notifications-build.ts.
  await expect(restartNotice).toContainText('restart to apply');
});
