/**
 * Acceptance-test for issue #641, migrated for issue #2408 (server-side notifications).
 *
 * `update_available` derivation moved from the SPA's `derive.ts` to the daemon's
 * `GET /v1/notifications` (spec §6.5) — the version-comparison rule is now server-side
 * (`buildNotifications` in `operator/src/api/notifications-build.ts`; parity-tested in
 * `operator/test/api/notifications-build.test.ts`). This E2E now proves the SPA renders
 * whatever `/v1/notifications` reports, by mocking that endpoint directly instead of
 * `/v1/status.version` / `.latestVersion`.
 *
 * Acceptance criteria (from issue #641, re-verified post-migration):
 *   (1) an `update_available` entry in the payload renders the banner.
 *   (2) an empty payload (alongside a `funding_low` control notice) renders no banner.
 */
import { test, expect } from '@playwright/test';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mockDaemonApi } from './helpers/mock-daemon-api';

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
 * Override the default `/v1/notifications` mock with an explicit list. Registered AFTER
 * `mockDaemonApi` so it wins (Playwright checks routes in reverse-registration order).
 */
async function mockNotifications(
  page: import('@playwright/test').Page,
  notifications: Array<Record<string, unknown>>,
): Promise<void> {
  await page.route(
    (url) => url.pathname === '/v1/notifications',
    (route) =>
      route.fulfill({
        contentType: 'application/json',
        body: JSON.stringify({ schemaVersion: 1, generatedAt: new Date().toISOString(), notifications }),
      }),
  );
}

test('update_available banner shows when the server reports it (issue #641, migrated #2408)', async ({ page }) => {
  await mockDaemonApi(page);
  await mockNotifications(page, [
    {
      kind: 'update_available',
      severity: 'info',
      title: 'Update available',
      message: 'Daemon 0.1.8 available (running 0.1.6).',
    },
  ]);

  await page.goto(handshakeUrl ?? `http://127.0.0.1:${PORT}/`);

  const updateItem = page.locator('[data-kind="update_available"]');
  await expect(updateItem).toBeVisible({ timeout: 15_000 });
  await expect(updateItem).toHaveAttribute('data-severity', 'info');
  // Message follows notifications-build.ts: "Daemon <latest> available (running <current>)."
  await expect(updateItem).toContainText('0.1.8');
  await expect(updateItem).toContainText('0.1.6');
});

test('no update_available banner when the server omits it (issue #641, migrated #2408)', async ({ page }) => {
  await mockDaemonApi(page);
  // Control: a different notification renders so we know the notifications surface mounted
  // (otherwise "absent" is vacuously true).
  await mockNotifications(page, [
    {
      kind: 'funding_low',
      severity: 'warning',
      title: 'Gas runway low',
      message: 'Gas runway low — wallet on Base Sepolia below threshold; top up soon.',
      jumpTo: '/overview',
    },
  ]);

  await page.goto(handshakeUrl ?? `http://127.0.0.1:${PORT}/`);

  await expect(page.locator('[data-kind="funding_low"]')).toBeVisible({ timeout: 15_000 });
  await expect(page.locator('[data-kind="update_available"]')).toHaveCount(0);
});
