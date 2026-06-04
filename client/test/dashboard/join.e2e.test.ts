// client/test/dashboard/join.e2e.test.ts
//
// Deterministic op-b join journey (DR-2026-06-03, #1014). A real daemon serves
// the SPA bundle + auth handshake; every /v1/* data call is intercepted at the
// page.route() boundary. "op-b discovers op-a's launched SolverNet in the
// catalog → joins it → sees the success affordance." The cross-operator
// catalog is a FIXTURE (op-b's registry response contains op-a's manifest) —
// not a real cross-daemon round-trip, which is exactly the T2.3 flake source
// this replaces.
import { test, expect } from '@playwright/test';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  mockDaemonApi,
  makeRegistrySummary,
  makeRegistryManifestResponse,
} from './helpers/mock-daemon-api.js';

const PORT = 17337;
const OP_A_CID = 'bafkreiopalaunchedsolvernet0000000000000000000000000000';

let daemon: ChildProcess | null = null;
let homeDir = '';
let handshakeUrl: string | null = null;

test.beforeAll(async () => {
  homeDir = mkdtempSync(join(tmpdir(), 'jinn-join-e2e-'));
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
  const capture = (chunk: Buffer) => {
    const m = /UI handshake URL:\s+(\S+)/.exec(chunk.toString('utf-8'));
    if (m && !handshakeUrl) handshakeUrl = m[1];
  };
  daemon.stderr?.on('data', capture);
  daemon.stdout?.on('data', capture);

  for (let i = 0; i < 60; i++) {
    try {
      const res = await fetch(`http://127.0.0.1:${PORT}/v1/bootstrap`, {
        headers: { 'x-jinn-ui-token': 'unused-but-required' },
      });
      // Only finish once BOTH the API answers and the handshake URL has been
      // captured — the daemon may serve /v1/bootstrap (401) a beat before the
      // handshake line is flushed, and returning then would leave handshakeUrl
      // null and fail the test instantly.
      if (handshakeUrl && (res.status === 200 || res.status === 401)) return;
    } catch {
      // not yet
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error('daemon API did not come up within 30s');
});

test.afterAll(async () => {
  if (daemon) {
    daemon.kill('SIGTERM');
    await new Promise((r) => setTimeout(r, 500));
  }
  if (homeDir) {
    try {
      rmSync(homeDir, { recursive: true, force: true });
    } catch {
      // best-effort
    }
  }
});

test('op-b discovers op-a\'s launched SolverNet in the catalog, joins it, and sees the success affordance', async ({ page }) => {
  test.setTimeout(60_000);

  await mockDaemonApi(page);

  // Per-test overrides registered AFTER mockDaemonApi so they win.
  // 1. op-b's catalog contains op-a's launched SolverNet.
  await page.route(
    (url) => url.pathname === '/v1/solvernets/registry',
    (route) =>
      route.fulfill({
        contentType: 'application/json',
        body: JSON.stringify({
          summaries: [makeRegistrySummary({ manifestCid: OP_A_CID })],
          lastRefreshedAt: '2026-06-03T00:00:00Z',
          lastError: null,
        }),
      }),
  );
  // 2. the per-CID manifest the JoinFlow form fetches.
  await page.route(
    (url) => url.pathname === `/v1/solvernets/registry/${OP_A_CID}`,
    (route) =>
      route.fulfill({
        contentType: 'application/json',
        body: JSON.stringify(makeRegistryManifestResponse({ manifestCid: OP_A_CID })),
      }),
  );
  // 3. the join POST succeeds.
  await page.route(
    (url) => url.pathname === `/v1/operator/join/${OP_A_CID}`,
    (route) =>
      route.fulfill({
        contentType: 'application/json',
        body: JSON.stringify({
          ok: true,
          restartRequired: true,
          manifestCid: OP_A_CID,
          config: { manifestCid: OP_A_CID, name: 'Prediction Markets', roles: ['solver'] },
        }),
      }),
  );

  if (!handshakeUrl) throw new Error('daemon did not print a UI handshake URL');
  await page.goto(handshakeUrl);
  const origin = new URL(page.url()).origin;
  await page.goto(`${origin}/operator/registry`);

  const card = page.getByTestId('registry-card').filter({ has: page.locator(`[data-manifest-cid="${OP_A_CID}"]`) });
  await expect(card.first()).toBeVisible({ timeout: 15_000 });

  await card.first().getByTestId('registry-join-cta').click();
  await expect(page).toHaveURL(new RegExp(`/operator/join/${OP_A_CID}`));
  await expect(page.getByTestId('join-flow')).toBeVisible({ timeout: 15_000 });

  await page.getByTestId('join-flow').getByLabel('Solver').check();
  const harnessSelect = page.getByTestId('join-harness-select');
  await expect(harnessSelect).toBeVisible();
  await harnessSelect.selectOption('claude-code');

  await page.getByTestId('join-flow-submit').click();

  await expect(page.getByTestId('join-flow-success-card')).toBeVisible({ timeout: 15_000 });
  await expect(page.getByTestId('join-flow-success-restart')).toBeVisible();
});
