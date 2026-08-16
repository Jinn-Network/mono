// operator/test/dashboard/posting-status.e2e.test.ts
//
// Read-plane companion for the re-scoped `e2e:app-flow` gate (DR-2026-08-05
// decision 5). Headless §4.2 rules that posting **status** joins the read
// plane (a receipts/status projection) while posting **mutations** move to
// config + `jinn tasks` — no mutating posting routes are built. This spec
// asserts the surviving read-plane posting surface: the `/operator/network`
// "Task posts" panel renders windowed on-chain task-post counts served by
// GET /v1/discovery/task-post-counts. It is deliberately a read assertion,
// not a mutation — the mutation invariant is owned by
// claim-policy-flow.e2e.test.ts.
//
// Approach mirrors task-post-counts.e2e.test.ts / join.e2e.test.ts: a real
// daemon serves the SPA bundle, and the read-plane call is intercepted at the
// page.route() boundary. The shared mockDaemonApi registers a zero-count
// task-post-counts default, so each test registers an override AFTER it
// (Playwright checks routes last-registered-first, so the override wins).
import { test, expect, type Page } from '@playwright/test';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mockDaemonApi } from './helpers/mock-daemon-api.js';

const PORT = 17341;

let daemon: ChildProcess | null = null;
let homeDir = '';
let handshakeUrl: string | null = null;

function bucket(h1: number, h6: number, h24: number) {
  return { h1, h6, h24, windowEndBlock: 1000, windowEndTs: 1715600000 };
}

/**
 * Register a /v1/discovery/task-post-counts override that returns a chain-wide
 * bucket. Registered after mockDaemonApi so it wins.
 */
async function mockTaskPostCounts(
  page: Page,
  chain: { h1: number; h6: number; h24: number },
): Promise<void> {
  await page.route(
    (url) => url.pathname === '/v1/discovery/task-post-counts',
    (route) =>
      route.fulfill({
        contentType: 'application/json',
        body: JSON.stringify({
          windowEndBlock: 1000,
          windowEndTs: 1715600000,
          chain: bucket(chain.h1, chain.h6, chain.h24),
          byCid: {},
        }),
      }),
  );
}

/** Navigate to a SPA route, preserving the handshake token if present. */
async function gotoRoute(page: Page, path: string): Promise<void> {
  const base = handshakeUrl ?? `http://127.0.0.1:${PORT}/`;
  const u = new URL(base);
  u.pathname = path;
  await page.goto(u.toString());
}

test.beforeAll(async () => {
  homeDir = mkdtempSync(join(tmpdir(), 'jinn-posting-status-e2e-'));
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
  const capture = (chunk: Buffer): void => {
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
    if (!daemon.killed) daemon.kill('SIGKILL');
  }
  if (homeDir) {
    try {
      rmSync(homeDir, { recursive: true, force: true });
    } catch {
      // best-effort
    }
  }
});

test('Posting status: the Network "Task posts" panel renders windowed counts from the read plane', async ({
  page,
}) => {
  test.setTimeout(60_000);

  await mockDaemonApi(page);
  await mockTaskPostCounts(page, { h1: 2, h6: 5, h24: 11 });

  await gotoRoute(page, '/operator/network');

  const panel = page.getByTestId('network-task-posts');
  await expect(panel).toBeVisible({ timeout: 15_000 });
  await expect(panel).toContainText('Last 1h');
  await expect(panel).toContainText('Last 6h');
  await expect(panel).toContainText('Last 24h');
  await expect(panel).toContainText('2');
  await expect(panel).toContainText('5');
  await expect(panel).toContainText('11');
});

test('Posting status: the panel shows a visible zero-state when there are no recent posts', async ({
  page,
}) => {
  test.setTimeout(60_000);

  await mockDaemonApi(page);
  await mockTaskPostCounts(page, { h1: 0, h6: 0, h24: 0 });

  await gotoRoute(page, '/operator/network');

  const panel = page.getByTestId('network-task-posts');
  await expect(panel).toBeVisible({ timeout: 15_000 });
  await expect(panel).toContainText(/No task posts in the last 24h/i);
});
