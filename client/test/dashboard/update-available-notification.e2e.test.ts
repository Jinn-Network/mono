/**
 * Acceptance-test for issue #641: surface the `update_available` notification
 * in the operator dashboard SPA when the daemon reports a newer published
 * `@jinn-network/client`.
 *
 * This is the Stage 7 (testing-jinn-app) regression. The unit tests in
 * `useNotifications.test.tsx` (wire → deriver adapter) and `derive.test.ts`
 * (pure deriver) pin the mapping; this E2E exercises the full SPA wiring:
 * - the daemon's `/v1/status` snapshot carrying `version` + `latestVersion`
 * - `mapStatusToDeriveInput` normalising those into the deriver's
 *   `daemonVersion` / `latestVersion` fields
 * - `deriveNotifications` emitting the `update_available` kind only when
 *   `latestVersion` is a string strictly differing from `daemonVersion`
 * - the `NotificationsList` rendering the info banner
 *
 * The banner is a pure function of the `/v1/status` payload (unlike the
 * SSE-driven `claim_failed` kind), so both cases just override the `/v1/status`
 * route AFTER `mockDaemonApi` and assert on the rendered banner.
 *
 * Acceptance criteria (from issue #641):
 *   (1) newer `latestVersion` than `version` ⇒ `update_available` banner shows.
 *   (2) `latestVersion: null` (or equal to version) ⇒ NO banner.
 */
import { test, expect } from '@playwright/test';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  mockDaemonApi,
  DEFAULT_STATUS_PAYLOAD,
} from './helpers/mock-daemon-api';

const PORT = 17335;

let daemon: ChildProcess | null = null;
let homeDir = '';
let handshakeUrl: string | null = null;

test.beforeAll(async () => {
  homeDir = mkdtempSync(join(tmpdir(), 'jinn-update-available-e2e-'));
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
 * Override the `/v1/status` route with a payload carrying the given `version`
 * and `latestVersion`. Registered AFTER `mockDaemonApi` so it wins (Playwright
 * checks routes in reverse-registration order).
 */
async function overrideStatusVersions(
  page: import('@playwright/test').Page,
  version: string,
  latestVersion: string | null,
  extra: Record<string, unknown> = {},
): Promise<void> {
  await page.route(
    (url) => url.pathname === '/v1/status',
    (route) =>
      route.fulfill({
        contentType: 'application/json',
        body: JSON.stringify({
          ...DEFAULT_STATUS_PAYLOAD,
          version,
          latestVersion,
          ...extra,
        }),
      }),
  );
}

test('update_available banner shows when latestVersion is strictly newer than version (issue #641)', async ({ page }) => {
  await mockDaemonApi(page);
  await overrideStatusVersions(page, '0.1.6', '0.1.8');

  await page.goto(handshakeUrl ?? `http://127.0.0.1:${PORT}/`);

  const updateItem = page.locator('[data-kind="update_available"]');
  await expect(updateItem).toBeVisible({ timeout: 15_000 });
  await expect(updateItem).toHaveAttribute('data-severity', 'info');
  // Message follows deriveNotifications():
  //   "Daemon <latest> available (running <current>)."
  await expect(updateItem).toContainText('0.1.8');
  await expect(updateItem).toContainText('0.1.6');
});

test('no update_available banner when latestVersion is null (issue #641)', async ({ page }) => {
  await mockDaemonApi(page);
  // The negative case needs a POSITIVE sentinel from the SAME snapshot, so the
  // absence of `update_available` is a real negative rather than a
  // not-yet-rendered race. Drive `funding_low` explicitly from this payload
  // (runwayDaysExcess below the deriver's 3-day threshold, balance at/above
  // minEthWei so the stronger `funding_empty` does not supersede it) instead of
  // relying on whatever the shared default happens to derive — that coupling is
  // exactly what broke this test when #1296 moved `funding_empty` behind
  // `minEthWei`.
  await overrideStatusVersions(page, '0.1.6', null, {
    masterGas: { balanceWei: '5000000000000000', minEthWei: '1000000000000000', runwayDaysExcess: '1' },
  });

  await page.goto(handshakeUrl ?? `http://127.0.0.1:${PORT}/`);

  await expect(page.locator('[data-kind="funding_low"]')).toBeVisible({
    timeout: 15_000,
  });
  await expect(page.locator('[data-kind="update_available"]')).toHaveCount(0);
});
