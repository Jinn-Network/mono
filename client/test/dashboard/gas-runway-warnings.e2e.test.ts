/**
 * Regression coverage for issue #1296 — gas runway warnings.
 *
 * Exercises the notification deriver (`src/dashboard/spa/src/notifications/derive.ts`)
 * and the WalletCard runway-severity tint (`src/dashboard/spa/src/pages/overview/WalletCard.tsx`)
 * end-to-end through the real SPA against a mocked `/v1/status`.
 *
 * Acceptance criteria under test:
 *   1. A low-but-nonzero L2 (Base Sepolia) runway surfaces a `funding_low` /
 *      `warning` notification naming the wallet address and the chain.
 *   2. A balance below `minEthWei` surfaces the higher-severity `funding_empty`
 *      / `blocking` notification instead, and `funding_low` for that chain is
 *      suppressed (empty supersedes low — see derive.ts `continue`).
 *   3. A low L1 (`l1MasterGas`, Ethereum Sepolia) runway surfaces its own
 *      `funding_low` warning naming "Ethereum Sepolia", independent of L2.
 *   4. Updating `/v1/status` to healthy values clears the warning on the next
 *      poll-driven re-render, with no page reload.
 *   5. WalletCard's runway line carries `data-runway-severity="warning"` /
 *      `"blocking"` when the corresponding severity applies (L2 only — see
 *      `Overview.tsx`'s `gasRunwaySeverity = gasSeverity(status?.masterGas)`).
 */
import { test, expect, type Page } from '@playwright/test';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  mockDaemonApi,
  DEFAULT_STATUS_PAYLOAD,
  DEFAULT_RUNNING_BOOTSTRAP,
} from './helpers/mock-daemon-api';

const PORT = 17340;

let daemon: ChildProcess | null = null;
let homeDir = '';
let handshakeUrl: string | null = null;

test.beforeAll(async () => {
  homeDir = mkdtempSync(join(tmpdir(), 'jinn-gas-runway-e2e-'));
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

const L2_ADDRESS = '0xL2MASTER';
const L1_ADDRESS = '0xL1MASTER';

/** Healthy L2 masterGas block — well above minEthWei, high runway. */
const HEALTHY_MASTER_GAS = {
  address: L2_ADDRESS,
  balanceWei: '5000000000000000000',
  runwayDaysExcess: '30',
  minEthWei: '1000000000000000',
};

/** Low-but-nonzero L2 runway — above minEthWei, but under the 3-day threshold. */
const LOW_MASTER_GAS = {
  address: L2_ADDRESS,
  balanceWei: '5000000000000000',
  runwayDaysExcess: '1',
  minEthWei: '1000000000000000',
};

/** L2 balance below minEthWei — can't cover the next transaction. */
const EMPTY_MASTER_GAS = {
  address: L2_ADDRESS,
  balanceWei: '500000000000000',
  runwayDaysExcess: '0',
  minEthWei: '1000000000000000',
};

/** Low-but-nonzero L1 (Ethereum Sepolia) runway. */
const LOW_L1_MASTER_GAS = {
  address: L1_ADDRESS,
  balanceWei: '2000000000000000',
  runwayDaysExcess: '1',
  minEthWei: '500000000000000',
};

/**
 * Registers the `/v1/status` route with a handler that reads the *current*
 * value of `state.status` on every request — lets a single test mutate the
 * mocked payload mid-flight (AC4: clearing on the next poll) without a fresh
 * `page.route` registration or a page reload.
 */
function mockStatusRoute(page: Page, state: { status: Record<string, unknown> }): Promise<void> {
  return page.route(
    (url) => url.pathname === '/v1/status',
    (route) =>
      route.fulfill({ contentType: 'application/json', body: JSON.stringify(state.status) }),
  );
}

test('low-but-nonzero L2 runway shows funding_low / warning naming the wallet and chain (AC1, AC5)', async ({
  page,
}) => {
  await mockDaemonApi(page);
  const state = {
    status: { ...DEFAULT_STATUS_PAYLOAD, masterGas: LOW_MASTER_GAS },
  };
  await mockStatusRoute(page, state);
  await page.route(
    (url) => url.pathname === '/v1/bootstrap',
    (route) =>
      route.fulfill({ contentType: 'application/json', body: JSON.stringify(DEFAULT_RUNNING_BOOTSTRAP) }),
  );

  await page.goto(handshakeUrl ?? `http://127.0.0.1:${PORT}/`);
  await expect(page).toHaveURL(/\/overview$/);

  const fundingLow = page.locator('[data-kind="funding_low"]');
  await expect(fundingLow).toBeVisible({ timeout: 15_000 });
  await expect(fundingLow).toHaveAttribute('data-severity', 'warning');
  await expect(fundingLow).toContainText(
    'Gas runway low — 0xL2MASTER on Base Sepolia below threshold; top up soon.',
  );

  // AC5: WalletCard's runway line carries the matching severity tint.
  const runwayLine = page.getByTestId('wallet-runway');
  await expect(runwayLine).toHaveAttribute('data-runway-severity', 'warning');

  await page.screenshot({ path: 'e2e-artifacts/1296/funding-low-warning.png', fullPage: true });
  // AppShell is viewport-locked (height: 100vh; overflow: hidden — see
  // shell/AppShell.tsx), so the WalletCard sits below the fold in the
  // full-page capture above. Grab it directly so the severity-tinted runway
  // line is visible in the artifact.
  await page.getByTestId('wallet-card').screenshot({
    path: 'e2e-artifacts/1296/funding-low-warning-wallet-card.png',
  });
});

test('L2 balance below minEthWei shows funding_empty / blocking and suppresses funding_low (AC2, AC5)', async ({
  page,
}) => {
  await mockDaemonApi(page);
  const state = {
    status: { ...DEFAULT_STATUS_PAYLOAD, masterGas: EMPTY_MASTER_GAS },
  };
  await mockStatusRoute(page, state);
  await page.route(
    (url) => url.pathname === '/v1/bootstrap',
    (route) =>
      route.fulfill({ contentType: 'application/json', body: JSON.stringify(DEFAULT_RUNNING_BOOTSTRAP) }),
  );

  await page.goto(handshakeUrl ?? `http://127.0.0.1:${PORT}/`);
  await expect(page).toHaveURL(/\/overview$/);

  const fundingEmpty = page.locator('[data-kind="funding_empty"]');
  await expect(fundingEmpty).toBeVisible({ timeout: 15_000 });
  await expect(fundingEmpty).toHaveAttribute('data-severity', 'blocking');
  await expect(fundingEmpty).toContainText(
    "Gas exhausted — 0xL2MASTER on Base Sepolia can't cover the next transaction.",
  );

  // Empty supersedes low for the same chain — funding_low must not also appear.
  await expect(page.locator('[data-kind="funding_low"]')).toHaveCount(0);

  // AC5: blocking severity tint on the WalletCard runway line.
  const runwayLine = page.getByTestId('wallet-runway');
  await expect(runwayLine).toHaveAttribute('data-runway-severity', 'blocking');
});

test('low L1 (Ethereum Sepolia) runway shows its own funding_low warning, independent of a healthy L2 (AC3)', async ({
  page,
}) => {
  await mockDaemonApi(page);
  const state = {
    status: {
      ...DEFAULT_STATUS_PAYLOAD,
      masterGas: HEALTHY_MASTER_GAS,
      l1MasterGas: LOW_L1_MASTER_GAS,
    },
  };
  await mockStatusRoute(page, state);
  await page.route(
    (url) => url.pathname === '/v1/bootstrap',
    (route) =>
      route.fulfill({ contentType: 'application/json', body: JSON.stringify(DEFAULT_RUNNING_BOOTSTRAP) }),
  );

  await page.goto(handshakeUrl ?? `http://127.0.0.1:${PORT}/`);
  await expect(page).toHaveURL(/\/overview$/);

  const fundingLow = page.locator('[data-kind="funding_low"]');
  await expect(fundingLow).toBeVisible({ timeout: 15_000 });
  await expect(fundingLow).toHaveCount(1);
  await expect(fundingLow).toContainText('Ethereum Sepolia');
  await expect(fundingLow).toContainText(L1_ADDRESS);
  // The healthy L2 chain must not also trigger a notice.
  await expect(fundingLow).not.toContainText('Base Sepolia');

  // Severity tint on WalletCard is driven by L2 (masterGas) only per
  // Overview.tsx's `gasRunwaySeverity = gasSeverity(status?.masterGas)` — a
  // low L1 runway must not tint the L2 runway line.
  const runwayLine = page.getByTestId('wallet-runway');
  await expect(runwayLine).toHaveAttribute('data-runway-severity', 'none');
});

test('warning clears on the next poll-driven re-render once funding recovers, no page reload (AC4)', async ({
  page,
}) => {
  await mockDaemonApi(page);
  const state = {
    status: { ...DEFAULT_STATUS_PAYLOAD, masterGas: LOW_MASTER_GAS },
  };
  await mockStatusRoute(page, state);
  await page.route(
    (url) => url.pathname === '/v1/bootstrap',
    (route) =>
      route.fulfill({ contentType: 'application/json', body: JSON.stringify(DEFAULT_RUNNING_BOOTSTRAP) }),
  );

  await page.goto(handshakeUrl ?? `http://127.0.0.1:${PORT}/`);
  await expect(page).toHaveURL(/\/overview$/);

  const fundingLow = page.locator('[data-kind="funding_low"]');
  await expect(fundingLow).toBeVisible({ timeout: 15_000 });
  const runwayLine = page.getByTestId('wallet-runway');
  await expect(runwayLine).toHaveAttribute('data-runway-severity', 'warning');

  // Mutate the mocked payload in place — the route handler reads `state.status`
  // fresh on every request, so no new `page.route` registration or reload is
  // needed. Overview's own `['status']` query polls every 5s (see
  // `pages/Overview.tsx`), which the notifications hook shares the cache key
  // with — the next scheduled poll picks up the healthy values.
  state.status = { ...DEFAULT_STATUS_PAYLOAD, masterGas: HEALTHY_MASTER_GAS };

  await expect(fundingLow).toHaveCount(0, { timeout: 15_000 });
  await expect(runwayLine).toHaveAttribute('data-runway-severity', 'none', { timeout: 15_000 });

  await page.screenshot({ path: 'e2e-artifacts/1296/funding-low-cleared.png', fullPage: true });
  await page.getByTestId('wallet-card').screenshot({
    path: 'e2e-artifacts/1296/funding-low-cleared-wallet-card.png',
  });
});
