/**
 * Acceptance-test for issue #442: wire `claim_failed` notification from the
 * daemon SSE event stream into the operator dashboard SPA.
 *
 * This is the Stage 7 (testing-jinn-app) regression. The unit tests in
 * `useNotifications.test.tsx` exercise the hook against a mocked
 * `useEventStream` return value; this E2E exercises the full SPA wiring:
 * - real `EventSource` opening `/v1/events?kinds=intent`
 * - the SSE body parsed into `StructuredEvent` by the SPA
 * - `useNotifications` filtering for `errorCode === 'claim_failed'` in the
 *   30-min wall-clock window
 * - the `NotificationsList` rendering the warning with the expected text
 *
 * The test mocks the daemon HTTP surface (so the SPA mounts the running-mode
 * dashboard) and overrides `/v1/events` to fulfill with an SSE body that
 * contains exactly one fresh `claim_failed` intent event. Playwright's
 * `route.fulfill` closes the response once the body is sent — EventSource
 * will attempt to reconnect, but the initial event has already been parsed
 * into the hook's state before then.
 *
 * Acceptance criteria (from issue #442):
 *   (a) `claim_failed` appears as a notification when emitted via SSE.
 *   (b) Old events outside the recent window don't surface — covered by
 *       `useNotifications.test.tsx` ("does not emit claim_failed when the
 *       only matching event is older than 30 minutes"). The wall-clock window
 *       is the same filter; an E2E covering it would require fake timers
 *       inside the browser context, which buys us no additional coverage
 *       over the unit test that pins the filter directly.
 *   (c) Existing snapshot-derived notifications still work unchanged —
 *       this test overrides /v1/status with a low-runway masterGas block
 *       (see issue #1296 — funding_low now fires per chain on
 *       `runwayDaysExcess < 3`, not on zero balance alone) and asserts
 *       funding_low still renders alongside the SSE-driven claim_failed,
 *       proving the new code path did not regress the deriver.
 */
import { test, expect } from '@playwright/test';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mockDaemonApi, DEFAULT_STATUS_PAYLOAD } from './helpers/mock-daemon-api';

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

/**
 * Build an SSE wire body containing one `intent` event with
 * `errorCode === 'claim_failed'` timestamped fresh (now). The wire format
 * follows the events-endpoint.ts contract: one JSON-encoded
 * `StructuredEvent` per `data:` line, terminated by a blank line.
 */
function buildClaimFailedSseBody(): string {
  const event = {
    schemaVersion: 1,
    id: 'evt-e2e-claim-failed-1',
    ts: new Date().toISOString(),
    kind: 'intent',
    message: 'Task claim failed',
    requestId: 'task-e2e',
    errorCode: 'claim_failed',
  };
  return `data: ${JSON.stringify(event)}\n\n`;
}

test('claim_failed appears as a warning notification when emitted via SSE (issue #442)', async ({ page }) => {
  // Install the standard daemon-API mocks first so the SPA mounts running-mode.
  await mockDaemonApi(page);

  // Override /v1/status with a low-runway masterGas block so funding_low
  // fires (#1296 — the deriver now keys funding_low on
  // `runwayDaysExcess < 3` per chain, not on zero balance alone; the shared
  // DEFAULT_STATUS_PAYLOAD default is healthy at runwayDaysExcess: '4').
  // Registered AFTER mockDaemonApi so this route wins (Playwright checks
  // routes in reverse-registration order).
  await page.route(
    (url) => url.pathname === '/v1/status',
    (route) =>
      route.fulfill({
        contentType: 'application/json',
        body: JSON.stringify({
          ...DEFAULT_STATUS_PAYLOAD,
          masterGas: { ...DEFAULT_STATUS_PAYLOAD.masterGas, runwayDaysExcess: '1' },
        }),
      }),
  );

  // Override the `/v1/events` SSE route AFTER mockDaemonApi so this
  // registration wins (Playwright checks routes in reverse-registration
  // order — later registrations are checked first). Match the SSE endpoint
  // regardless of query params (`?kinds=intent`).
  await page.route(
    (url) => url.pathname === '/v1/events',
    (route) =>
      route.fulfill({
        contentType: 'text/event-stream',
        headers: { 'Cache-Control': 'no-cache', 'X-Accel-Buffering': 'no' },
        body: buildClaimFailedSseBody(),
      }),
  );

  await page.goto(handshakeUrl ?? `http://127.0.0.1:${PORT}/`);

  // The shell mounts the notification list once the bootstrap + status
  // queries resolve. Use the stable data-kind hook from NotificationItem so
  // the assertion doesn't depend on copy that may evolve.
  const claimFailedItem = page.locator('[data-kind="claim_failed"]');
  await expect(claimFailedItem).toBeVisible({ timeout: 15_000 });
  await expect(claimFailedItem).toHaveAttribute('data-severity', 'warning');
  // Single notification, not one per event (aggregation).
  await expect(claimFailedItem).toHaveCount(1);
  // The message text follows the format from useNotifications.ts:
  //   "N claim attempt(s) failed in the last 30 minutes. Check Tasks for details."
  await expect(claimFailedItem).toContainText('1 claim attempt');
  await expect(claimFailedItem).toContainText('last 30 minutes');

  // Acceptance criterion (c): a snapshot-derived notification still renders
  // alongside the SSE-driven one. The overridden /v1/status payload above
  // reports a low-runway `masterGas`, which the deriver maps to
  // `funding_low`. Asserting that BOTH notifications render proves the
  // SSE branch did not regress the snapshot deriver.
  const fundingLowItem = page.locator('[data-kind="funding_low"]');
  await expect(fundingLowItem).toBeVisible({ timeout: 15_000 });
});
