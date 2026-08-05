/**
 * Acceptance-test for issue #442, migrated for issue #2408 (server-side notifications).
 *
 * `claim_failed` derivation moved from the SPA's SSE-ring hook to the daemon's
 * `GET /v1/notifications` (spec §6.5) — the daemon now reads its own event ring and applies
 * the 30-min wall-clock window server-side (`countRecentClaimFailures` in
 * `client/src/api/notifications-build.ts`; parity-tested in
 * `client/test/api/notifications-build.test.ts`). This E2E now only proves the SPA renders
 * whatever `/v1/notifications` reports — it mocks that endpoint directly instead of an SSE
 * body, since the hook no longer reads `/v1/events` at all.
 *
 * Acceptance criteria (from issue #442, re-verified post-migration):
 *   (a) `claim_failed` appears as a notification when the server reports it.
 *   (b) The 30-min window itself is a server-side concern now, pinned by
 *       `notifications-build.test.ts`, not this E2E.
 *   (c) A second, unrelated server-derived notification (`funding_low`) renders alongside
 *       `claim_failed` in the same payload, proving the SPA doesn't special-case one kind.
 */
import { test, expect } from '@playwright/test';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mockDaemonApi } from './helpers/mock-daemon-api';

const PORT = 17334;

let daemon: ChildProcess | null = null;
let homeDir = '';
let handshakeUrl: string | null = null;

test.beforeAll(async () => {
  homeDir = mkdtempSync(join(tmpdir(), 'jinn-claim-failed-e2e-'));
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

test('claim_failed appears as a warning notification when the server reports it (issue #442, migrated #2408)', async ({ page }) => {
  // Install the standard daemon-API mocks first so the SPA mounts running-mode.
  await mockDaemonApi(page);

  // Override /v1/notifications with the server-shaped payload the daemon would produce for
  // a burst of 1 recent claim failure plus a low L2 gas runway. Registered AFTER
  // mockDaemonApi so this route wins (Playwright checks routes in reverse-registration order).
  await page.route(
    (url) => url.pathname === '/v1/notifications',
    (route) =>
      route.fulfill({
        contentType: 'application/json',
        body: JSON.stringify({
          schemaVersion: 1,
          generatedAt: new Date().toISOString(),
          notifications: [
            {
              kind: 'funding_low',
              severity: 'warning',
              title: 'Gas runway low',
              message: 'Gas runway low — wallet on Base Sepolia below threshold; top up soon.',
              jumpTo: '/overview',
            },
            {
              kind: 'claim_failed',
              severity: 'warning',
              title: 'Claim failed',
              message: '1 claim attempt failed in the last 30 minutes. Check Tasks for details.',
              jumpTo: '/overview',
              details: { count: 1, sinceMs: Date.now() - 30 * 60 * 1000 },
            },
          ],
        }),
      }),
  );

  await page.goto(handshakeUrl ?? `http://127.0.0.1:${PORT}/`);

  // The shell mounts the notification list once /v1/notifications resolves. Use the stable
  // data-kind hook from NotificationItem so the assertion doesn't depend on copy that may evolve.
  const claimFailedItem = page.locator('[data-kind="claim_failed"]');
  await expect(claimFailedItem).toBeVisible({ timeout: 15_000 });
  await expect(claimFailedItem).toHaveAttribute('data-severity', 'warning');
  // Single notification, not one per event (aggregation happens server-side now).
  await expect(claimFailedItem).toHaveCount(1);
  // The message text follows the format from notifications-build.ts:
  //   "N claim attempt(s) failed in the last 30 minutes. Check Tasks for details."
  await expect(claimFailedItem).toContainText('1 claim attempt');
  await expect(claimFailedItem).toContainText('last 30 minutes');

  // Acceptance criterion (c): a second server-derived notification renders alongside the
  // claim_failed one, proving the SPA renders the whole payload, not just one special kind.
  const fundingLowItem = page.locator('[data-kind="funding_low"]');
  await expect(fundingLowItem).toBeVisible({ timeout: 15_000 });
});
