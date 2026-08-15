/**
 * Task-post-rate surfaces (#918) — rendered E2E.
 *
 * Two operator-visible surfaces gained windowed on-chain task-post counts:
 *   1. /operator/network — a "Task posts" Card (network-task-posts) with
 *      last-1h/6h/24h counts, a zero-state, and rate-limited / unavailable
 *      error states.
 *   2. /launcher — a per-row "Recent posts" cell (launcher-owned-row-postcounts)
 *      filtered by the row's manifest CID, fed by ONE batched query.
 *
 * Both are backed by GET /v1/discovery/task-post-counts via
 * api.discovery.getTaskPostCounts(cids?).
 *
 * Pattern: spawn the real daemon to serve the SPA bundle (same as
 * spa-config.e2e.test.ts), then mock the daemon API at the page level.
 * The shared mockDaemonApi registers a generic /v1/discovery/ catch-all that
 * returns `{ items, total }` — NOT a valid task-post-counts body — so each
 * test registers a task-post-counts override AFTER mockDaemonApi (Playwright
 * checks routes last-registered-first, so the override wins).
 */
import { test, expect } from '@playwright/test';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  mockDaemonApi,
  DEFAULT_OWNED_LAUNCHED_LIST,
} from './helpers/mock-daemon-api';
import type { Page } from '@playwright/test';

const PORT = 17338;

let daemon: ChildProcess | null = null;
let homeDir = '';
let handshakeUrl: string | null = null;

function bucket(h1: number, h6: number, h24: number) {
  return { h1, h6, h24, windowEndBlock: 1000, windowEndTs: 1715600000 };
}

/**
 * Register a /v1/discovery/task-post-counts override that echoes whichever
 * cids the query requested, returning per-cid buckets from `byCid` plus a
 * chain-wide bucket. Registered after mockDaemonApi so it wins.
 */
async function mockTaskPostCounts(
  page: Page,
  opts: {
    chain: { h1: number; h6: number; h24: number };
    byCid?: Record<string, { h1: number; h6: number; h24: number }>;
  },
): Promise<void> {
  await page.route(
    (url) => url.pathname === '/v1/discovery/task-post-counts',
    (route) => {
      const byCid: Record<string, ReturnType<typeof bucket>> = {};
      for (const [cid, c] of Object.entries(opts.byCid ?? {})) {
        byCid[cid] = bucket(c.h1, c.h6, c.h24);
      }
      return route.fulfill({
        contentType: 'application/json',
        body: JSON.stringify({
          windowEndBlock: 1000,
          windowEndTs: 1715600000,
          chain: bucket(opts.chain.h1, opts.chain.h6, opts.chain.h24),
          byCid,
        }),
      });
    },
  );
}

/** Navigate to a SPA route, preserving the handshake token query if present. */
async function gotoRoute(page: Page, path: string): Promise<void> {
  const base = handshakeUrl ?? `http://127.0.0.1:${PORT}/`;
  const u = new URL(base);
  u.pathname = path;
  await page.goto(u.toString());
}

test.beforeAll(async () => {
  homeDir = mkdtempSync(join(tmpdir(), 'jinn-task-post-counts-e2e-'));
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

test.describe('Network "Task posts" panel (#918)', () => {
  test('AC#1 — renders three windowed counts (1h/6h/24h)', async ({ page }) => {
    await mockDaemonApi(page);
    await mockTaskPostCounts(page, { chain: { h1: 2, h6: 5, h24: 11 } });
    await gotoRoute(page, '/operator/network');

    const panel = page.getByTestId('network-task-posts');
    await expect(panel).toBeVisible();
    await expect(panel).toContainText('Last 1h');
    await expect(panel).toContainText('Last 6h');
    await expect(panel).toContainText('Last 24h');
    await expect(panel).toContainText('2');
    await expect(panel).toContainText('5');
    await expect(panel).toContainText('11');
  });

  test('AC#3 — renders a visible zero-state message when h24 is 0', async ({ page }) => {
    await mockDaemonApi(page);
    await mockTaskPostCounts(page, { chain: { h1: 0, h6: 0, h24: 0 } });
    await gotoRoute(page, '/operator/network');

    const panel = page.getByTestId('network-task-posts');
    await expect(panel).toBeVisible();
    await expect(panel).toContainText(/No task posts in the last 24h/i);
  });

  // NOTE: error-state rendering (rpc_rate_limited / discovery_unavailable) is
  // covered deterministically in the NetworkTab + Launcher component tests
  // (vitest with `retry: false`). It is intentionally NOT re-asserted here:
  // the real SPA QueryClient retries failed queries with backoff, so a 503
  // mock leaves the panel in "Loading…" well past a reasonable E2E timeout.
  // The three acceptance criteria (populated counts, zero-state on both
  // surfaces) are the rendered-app checks this file owns.
});

test.describe('Launcher "Recent posts" cell (#918)', () => {
  test('AC#2 — renders per-row windowed counts filtered by CID', async ({ page }) => {
    await mockDaemonApi(page);
    // Two owned rows with distinct manifest CIDs.
    await page.route(
      (url) => url.pathname === '/v1/solvernets/launched',
      (route) =>
        route.fulfill({
          contentType: 'application/json',
          body: JSON.stringify({
            records: [
              {
                ...buildOwned('net-a', 'cid-a'),
              },
              {
                ...buildOwned('net-b', 'cid-b'),
              },
            ],
          }),
        }),
    );
    // Only cid-a has counts; cid-b should fall back to the zero-state.
    await mockTaskPostCounts(page, {
      chain: { h1: 0, h6: 0, h24: 0 },
      byCid: { 'cid-a': { h1: 2, h6: 5, h24: 9 } },
    });
    await gotoRoute(page, '/launcher');

    const rows = page.getByTestId('launcher-owned-row');
    await expect(rows).toHaveCount(2);

    const cells = page.getByTestId('launcher-owned-row-postcounts');
    await expect(cells).toHaveCount(2);
    // Row A (cid-a) shows the windowed counts.
    await expect(cells.nth(0)).toContainText('2');
    await expect(cells.nth(0)).toContainText('9');
    // AC#3 — Row B (cid-b, no counts) shows the visible zero-state, not blank.
    await expect(cells.nth(1)).toContainText(/No recent posts/i);
  });
});

function buildOwned(solverNetId: string, manifestCid: string) {
  return {
    ...DEFAULT_OWNED_LAUNCHED_LIST,
    schemaVersion: 'solvernet.launched.v1' as const,
    solverNetId,
    manifestCid,
    manifestHash:
      '0x0000000000000000000000000000000000000000000000000000000000000000' as const,
    launcherAgentId: '5474',
    launcherSafeAddress:
      '0x0e767E28C6889CcD0DfB88E631a3702D56Ce24FC' as const,
    launchedAt: '2026-05-05T15:00:00Z',
    status: 'launched' as const,
    statusUpdatedAt: '2026-05-05T15:00:00Z',
    generatorEnabled: true,
    registry: {},
  };
}
