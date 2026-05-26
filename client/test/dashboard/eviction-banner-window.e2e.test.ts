/**
 * Acceptance-test for issue #651: auto-restake suppression window must hide
 * BOTH the inline `EvictionBanner` on /overview AND the `service_evicted`
 * notification in the global notifications row, while the daemon's
 * `EvictionLoop` is still inside its 2 × checkIntervalMs grace window.
 *
 * Stage 7 (testing-jinn-app) regression. The predicate
 * (`isWithinAutoRestakeWindow`) and the two surfaces that consume it
 * (`selectVisibleEvictedService` for the banner; `deriveNotifications`'s
 * `service_evicted` aggregator for the notice) are each covered by unit /
 * component tests under `client/src/dashboard/spa/src/notifications/` and
 * `client/src/dashboard/spa/src/pages/Overview.test.tsx`. This E2E exercises
 * the production wiring end-to-end: real `useQuery` against the mocked
 * `/v1/status` endpoint, real `OverviewPage` mounted via the routing shell,
 * real `useNotifications` composing the snapshot deriver — so a regression
 * in either consumer surfaces before it ships.
 *
 * Three scenarios, one per acceptance branch:
 *   (a) `autoRestake.enabled === true` + fresh `evictedSince`  — both surfaces hidden.
 *   (b) `autoRestake.enabled === true` + aged-past `evictedSince` — both surfaces visible.
 *   (c) `autoRestake.enabled === false`                         — both surfaces visible.
 *
 * Backward-compat fallback (no `autoRestake` on the wire at all) is
 * exhaustively covered by the unit test `auto-restake-window.test.ts`
 * ("returns false when autoRestake is undefined (older daemon)") — covering
 * it here would buy no additional wiring evidence beyond scenario (c).
 */
import { test, expect } from '@playwright/test';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  mockDaemonApi,
  DEFAULT_STATUS_PAYLOAD,
  DEFAULT_RUNNING_BOOTSTRAP,
} from './helpers/mock-daemon-api';

const PORT = 17335;

let daemon: ChildProcess | null = null;
let homeDir = '';
let handshakeUrl: string | null = null;

test.beforeAll(async () => {
  homeDir = mkdtempSync(join(tmpdir(), 'jinn-eviction-window-e2e-'));
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

/**
 * Build a `/v1/status` payload with a single evicted service plus the
 * supplied `autoRestake` block. Carries enough non-eviction state to mount
 * the running-mode shell — `masterGas.balanceWei` is non-zero so the
 * baseline `funding_low` notification does not fire and confuse the assertions.
 */
function buildEvictedStatus(opts: {
  evictedSinceMs: number;
  autoRestake: { enabled: boolean; checkIntervalMs: number } | undefined;
}): Record<string, unknown> {
  const { evictedSinceMs, autoRestake } = opts;
  return {
    ...DEFAULT_STATUS_PAYLOAD,
    fleet: {
      services: [
        {
          index: 1,
          step: 'complete',
          safeAddress: '0x0e767E28C6889CcD0DfB88E631a3702D56Ce24FC',
          agentId: 5474,
          safeBoundToAgent: true,
          serviceId: 99,
          evicted: true,
          evictedSince: new Date(evictedSinceMs).toISOString(),
        },
      ],
    },
    // Bring masterGas balance well above zero so the deriver does NOT emit
    // `funding_low` (which would still pass assertions but adds noise).
    masterGas: { balanceWei: '1000000000000000000', runwayDaysExcess: '7' },
    autoRestake,
  } as Record<string, unknown>;
}

/**
 * Install standard daemon mocks and override `/v1/status` with the supplied
 * payload. Last-registered route wins in Playwright, so the override must
 * come after `mockDaemonApi`.
 */
async function installStatusMock(
  page: import('@playwright/test').Page,
  status: Record<string, unknown>,
): Promise<void> {
  await mockDaemonApi(page);
  await page.route(
    (url) => url.pathname === '/v1/status',
    (route) =>
      route.fulfill({
        contentType: 'application/json',
        body: JSON.stringify(status),
      }),
  );
  // Use the default bootstrap so the SPA mounts the running dashboard. The
  // helper already wires this, but make the dependency explicit for readers.
  void DEFAULT_RUNNING_BOOTSTRAP;
}

test('autoRestake within window suppresses banner and notification (#651)', async ({ page }) => {
  // evictedSince = 30s ago; checkIntervalMs = 60s → window is 120s → well inside.
  const status = buildEvictedStatus({
    evictedSinceMs: Date.now() - 30_000,
    autoRestake: { enabled: true, checkIntervalMs: 60_000 },
  });
  await installStatusMock(page, status);
  await page.goto(handshakeUrl ?? `http://127.0.0.1:${PORT}/`);

  // The dashboard must mount — wait for any stable non-eviction landmark
  // before asserting on absence (otherwise we'd race the initial render).
  // The notifications list region is present in running-mode regardless of
  // whether it has items, so wait for the body to settle by waiting for a
  // network-idle moment after the status query resolves.
  await page.waitForLoadState('networkidle');

  // Banner must NOT be visible while inside the suppression window.
  await expect(page.getByTestId('overview-eviction-banner')).toHaveCount(0);
  // Notification must NOT be emitted either.
  await expect(page.locator('[data-kind="service_evicted"]')).toHaveCount(0);
});

test('autoRestake past window shows banner and notification (#651)', async ({ page }) => {
  // evictedSince = 5 minutes ago; checkIntervalMs = 60s → window = 120s → past.
  const status = buildEvictedStatus({
    evictedSinceMs: Date.now() - 5 * 60_000,
    autoRestake: { enabled: true, checkIntervalMs: 60_000 },
  });
  await installStatusMock(page, status);
  await page.goto(handshakeUrl ?? `http://127.0.0.1:${PORT}/`);

  // Both surfaces visible — the operator is now alarmed because the loop
  // failed to settle within its grace window.
  await expect(page.getByTestId('overview-eviction-banner')).toBeVisible({ timeout: 15_000 });
  await expect(page.getByTestId('overview-eviction-banner')).toContainText(/service evicted/i);
  await expect(page.locator('[data-kind="service_evicted"]')).toBeVisible({ timeout: 15_000 });
});

test('autoRestake disabled shows banner and notification immediately (#651)', async ({ page }) => {
  // evictedSince = 1s ago; loop disabled → no suppression regardless of age.
  const status = buildEvictedStatus({
    evictedSinceMs: Date.now() - 1_000,
    autoRestake: { enabled: false, checkIntervalMs: 0 },
  });
  await installStatusMock(page, status);
  await page.goto(handshakeUrl ?? `http://127.0.0.1:${PORT}/`);

  await expect(page.getByTestId('overview-eviction-banner')).toBeVisible({ timeout: 15_000 });
  await expect(page.locator('[data-kind="service_evicted"]')).toBeVisible({ timeout: 15_000 });
});
