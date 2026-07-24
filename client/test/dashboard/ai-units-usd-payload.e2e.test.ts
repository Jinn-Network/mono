/**
 * Regression coverage for issue #1004 — the /v1/status `aiUnits` payload now
 * carries actual-USD-spend fields (`usdMicrosThisBlock`, `usdMicrosThisWeek`,
 * `capPerBlockUsdMicros`, `capPerWeekUsdMicros`) plus an `estimated` flag, and
 * the legacy unit fields (`unitsThisBlock`, `unitsThisWeek`, `capPerBlock`,
 * `capPerWeek`) are now DERIVED from the USD accumulator via the GPT-5.4-mini
 * peg rather than summed directly.
 *
 * The Overview `AiUnitsPauseAlert` now renders the USD fields directly (#1802)
 * and prefers the daemon's binding `pausedWindow` (#830), while retaining the
 * legacy unit fields for older daemons.
 *
 * The mock below mirrors the exact derivation the daemon produces (verified in
 * `test/api/status-ai-units.test.ts`): a credential with $0.35 actual spend
 * this block ($0.60 over the week is irrelevant; block is the binding window)
 * over a $0.50 block cap is paused, and its peg-derived `unitsThisBlock` is
 * `0.35 / 0.50 * 100 = 70` against a `capPerBlock` of 100. The test pins the
 * SPA-side render of that payload so that:
 *   1. the pause alert renders against the new payload without crashing,
 *   2. the displayed USD figures and estimated/metered qualifier are correct
 *      (no NaN, no `undefined`, no spurious zero),
 *   3. no new console errors / page errors / error boundary are introduced.
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

const PORT = 17336;

let daemon: ChildProcess | null = null;
let homeDir = '';
let handshakeUrl: string | null = null;

// Benign console.error noise the SPA can emit during isolated route loads.
const HARMLESS_CONSOLE_ERROR_PATTERNS: RegExp[] = [/ResizeObserver loop completed/i];

test.beforeAll(async () => {
  homeDir = mkdtempSync(join(tmpdir(), 'jinn-ai-units-usd-e2e-'));
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

test('Overview AI-units pause alert renders correctly against the #1004 USD payload', async ({
  page,
}) => {
  const consoleErrors: string[] = [];
  const pageErrors: Error[] = [];
  page.on('console', (msg) => {
    if (msg.type() === 'error') consoleErrors.push(msg.text());
  });
  page.on('pageerror', (err) => pageErrors.push(err));

  // Shared baseline mocks first, then override /v1/status with the #1004 shape.
  // Playwright runs the most-recently-registered matching route first, so this
  // override wins over the DEFAULT_STATUS_PAYLOAD route inside mockDaemonApi.
  await mockDaemonApi(page);
  await page.route(
    (url) => url.pathname === '/v1/rewards',
    (route) =>
      route.fulfill({
        contentType: 'application/json',
        body: JSON.stringify({
          schemaVersion: 1,
          generatedAt: '2026-06-03T13:00:00.000Z',
          readState: 'ready',
          totalPending: '0',
          totalClaimed: '0',
          lastClaimAt: null,
          lastClaimTickAt: null,
          nextCheckpointAt: null,
          services: [],
        }),
      }),
  );

  const statusWithUsdAiUnits = {
    ...DEFAULT_STATUS_PAYLOAD,
    aiUnits: {
      credentials: [
        {
          credentialId: 'anthropic:api-key',
          // Legacy unit fields — derived from USD via the peg on the daemon
          // side. $0.35 block / $0.50 per 100 units => 70 units.
          unitsThisBlock: 70,
          unitsThisWeek: 1200,
          capPerBlock: 100,
          capPerWeek: 2800,
          // Additive USD fields (issue #1004).
          usdMicrosThisBlock: 350_000,
          usdMicrosThisWeek: 6_000_000,
          capPerBlockUsdMicros: 500_000,
          capPerWeekUsdMicros: 14_000_000,
          estimated: true,
          // Block is NOT yet at cap (70 < 100); the credential is paused on the
          // WEEK window — but here we keep it under both to first assert the
          // unpaused render is clean, then a second credential exercises pause.
          paused: false,
          pausedWindow: null,
          blockResetsAt: '2026-06-03T18:00:00.000Z',
          weekResetsAt: '2026-06-09T13:00:00.000Z',
        },
        {
          credentialId: 'anthropic:subscription',
          // Block window has hit cap: $0.50 / $0.50 => 100 / 100 units.
          unitsThisBlock: 100,
          unitsThisWeek: 2000,
          capPerBlock: 100,
          capPerWeek: 2800,
          usdMicrosThisBlock: 500_000,
          usdMicrosThisWeek: 10_000_000,
          capPerBlockUsdMicros: 500_000,
          capPerWeekUsdMicros: 14_000_000,
          estimated: false,
          paused: true,
          pausedWindow: 'block',
          blockResetsAt: '2026-06-03T18:00:00.000Z',
          weekResetsAt: '2026-06-09T13:00:00.000Z',
        },
      ],
    },
  };

  await page.route(
    (url) => url.pathname === '/v1/status',
    (route) =>
      route.fulfill({ contentType: 'application/json', body: JSON.stringify(statusWithUsdAiUnits) }),
  );
  await page.route(
    (url) => url.pathname === '/v1/bootstrap',
    (route) =>
      route.fulfill({ contentType: 'application/json', body: JSON.stringify(DEFAULT_RUNNING_BOOTSTRAP) }),
  );

  await page.goto(handshakeUrl ?? `http://127.0.0.1:${PORT}/`);
  await expect(page).toHaveURL(/\/overview$/);

  // Acceptance 1 — the paused credential's alert renders against the new shape.
  const alert = page.getByTestId('ai-units-pause-alert-anthropic:subscription');
  await expect(alert).toBeVisible();
  await expect(alert).toContainText('Paused');
  await expect(alert).toContainText('anthropic:subscription');

  // Acceptance 2 — displayed USD figures are metered and non-zero. The daemon
  // says the block window is binding, so that window's actual spend is shown.
  await expect(alert).toContainText('metered $0.5000 / $0.5000 this block');
  await expect(alert).not.toContainText('units');
  await expect(alert).not.toContainText('NaN');
  await expect(alert).not.toContainText('undefined');

  // The non-paused credential must NOT surface an alert (paused:false).
  await expect(page.getByTestId('ai-units-pause-alert-anthropic:api-key')).toHaveCount(0);

  // Acceptance 3 — no new console / page errors and no error boundary.
  expect(pageErrors, 'pageerror events on Overview with #1004 payload').toHaveLength(0);
  expect(await page.locator('[data-error-boundary]').count(), 'error boundary').toBe(0);
  const realErrors = consoleErrors.filter(
    (err) => !HARMLESS_CONSOLE_ERROR_PATTERNS.some((re) => re.test(err)),
  );
  expect(realErrors, 'console errors on Overview with #1004 payload').toEqual([]);
});
