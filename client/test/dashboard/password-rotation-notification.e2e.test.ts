/**
 * Acceptance-test for issue #441: surface the `password_rotation_due`
 * notification in the operator dashboard SPA when the daemon's `/v1/status`
 * reports a `security.lastPasswordRotationAt` older than 90 days.
 *
 * This is the Stage 7 (testing-jinn-app) regression. The unit tests in
 * `derive.test.ts` exercise the deriver against a synthetic `passwordRotatedAt`
 * input; this E2E exercises the full SPA wiring end-to-end:
 * - real `/v1/status` response carrying `security.lastPasswordRotationAt`
 * - `mapStatusToDeriveInput` reading `s.security.lastPasswordRotationAt`
 *   (useNotifications.ts) into the deriver's `passwordRotatedAt` field
 * - `deriveNotifications` firing `password_rotation_due` once the ISO timestamp
 *   is over the 90-day interval (derive.ts)
 * - the `NotificationsList` rendering the info notification with the data hooks
 *
 * The effect is time-gated (only fires after 90 days), so a live daemon with a
 * fresh keystore file would show nothing. We mock `/v1/status` to inject an aged
 * timestamp (120 days ago) and assert the notification renders; the control case
 * injects `null` and asserts no such notification appears.
 *
 * Acceptance criteria (from issue #441):
 *   (a) aged `security.lastPasswordRotationAt` (>90d) ⇒ `password_rotation_due`
 *       renders.
 *   (b) null `security.lastPasswordRotationAt` ⇒ no `password_rotation_due`
 *       notification (while the snapshot deriver still produces the
 *       zero-balance `funding_low`, proving the page mounted notifications).
 */
import { test, expect } from '@playwright/test';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mockDaemonApi, DEFAULT_STATUS_PAYLOAD } from './helpers/mock-daemon-api';

const PORT = 17335;

let daemon: ChildProcess | null = null;
let homeDir = '';
let handshakeUrl: string | null = null;

const DAY_MS = 1000 * 60 * 60 * 24;

test.beforeAll(async () => {
  homeDir = mkdtempSync(join(tmpdir(), 'jinn-password-rotation-e2e-'));
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
 * Override the default `/v1/status` mock with one carrying a `security` block.
 * `lastPasswordRotationAt` is the keystore-password file's ISO mtime (#441);
 * pass a fixed ISO string or `null`. Registered AFTER mockDaemonApi so this
 * route wins (Playwright checks routes in reverse-registration order).
 */
async function mockStatusWithSecurity(
  page: import('@playwright/test').Page,
  lastPasswordRotationAt: string | null,
): Promise<void> {
  await page.route(
    (url) => url.pathname === '/v1/status',
    (route) =>
      route.fulfill({
        contentType: 'application/json',
        body: JSON.stringify({
          ...DEFAULT_STATUS_PAYLOAD,
          security: { lastPasswordRotationAt },
        }),
      }),
  );
}

test('password_rotation_due renders when security.lastPasswordRotationAt is older than 90 days (issue #441)', async ({ page }) => {
  await mockDaemonApi(page);
  // 120 days ago — comfortably past the 90-day interval.
  const aged = new Date(Date.now() - 120 * DAY_MS).toISOString();
  await mockStatusWithSecurity(page, aged);

  await page.goto(handshakeUrl ?? `http://127.0.0.1:${PORT}/`);

  // Stable data-kind hook from NotificationItem; copy may evolve.
  const rotationItem = page.locator('[data-kind="password_rotation_due"]');
  await expect(rotationItem).toBeVisible({ timeout: 15_000 });
  await expect(rotationItem).toHaveAttribute('data-severity', 'info');
  await expect(rotationItem).toHaveCount(1);
  // Message text from derive.ts.
  await expect(rotationItem).toContainText('over 90 days old');
});

test('password_rotation_due is absent when security.lastPasswordRotationAt is null (issue #441)', async ({ page }) => {
  await mockDaemonApi(page);
  await mockStatusWithSecurity(page, null);

  await page.goto(handshakeUrl ?? `http://127.0.0.1:${PORT}/`);

  // Control: a snapshot-derived notification must render so we know the
  // notifications surface mounted (otherwise "absent" is vacuously true). The
  // default mocked /v1/status reports `masterGas.balanceWei: '0'`, which the
  // deriver maps to `funding_low`.
  const fundingLowItem = page.locator('[data-kind="funding_low"]');
  await expect(fundingLowItem).toBeVisible({ timeout: 15_000 });

  // With null rotation timestamp, the password notice must not appear.
  const rotationItem = page.locator('[data-kind="password_rotation_due"]');
  await expect(rotationItem).toHaveCount(0);
});
