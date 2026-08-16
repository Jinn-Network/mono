/**
 * Regression coverage for issue #288 — "misleading days-runway display after
 * bootstrap when default master ETH daily-spend estimate is used".
 *
 * Pre-fix: with a fresh-bootstrap master EOA at ~0.008 ETH and the 0.005 ETH
 * minimum gate, the poll-based blend in `resolveMasterDailyEstimateWei`
 * produced a daily estimate of ~0.0036 ETH/day, which floored `(balance - min)
 * / daily` to 0 or 1 — surfaced in the operator dashboard's Wallet card as
 * "1d runway" in alarming red. The fix lowers the default daily estimate to
 * 0.0005 ETH/day and drops the poll-based blend, so the same balance now
 * resolves to ~5 days runway.
 *
 * This test mocks /v1/status with the exact wei amounts from the user-
 * reported scenario (master 0.008 ETH = 7991886719184102 wei, min 0.005 ETH,
 * post-fix daily 0.0005 ETH/day = 500000000000000 wei → 5 days excess) and
 * asserts the Wallet card renders "5d runway". The API-layer regression
 * already exists in `test/api/status-build.test.ts`; this test pins the
 * SPA-side verbatim render of `runwayDaysExcess` so a SPA-side transform
 * regression (e.g. coercing the string to a number and re-flooring) would
 * also fail loudly.
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

const PORT = 17335;

let daemon: ChildProcess | null = null;
let homeDir = '';
let handshakeUrl: string | null = null;

test.beforeAll(async () => {
  homeDir = mkdtempSync(join(tmpdir(), 'jinn-runway-display-e2e-'));
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

test('Wallet card renders post-fix runway (5d) at the #288 boundary scenario', async ({ page }) => {
  // Install the shared baseline route mocks first, then override /v1/status
  // with the exact boundary scenario from #288. Playwright's first-match-wins
  // semantics put the most-recently-registered route in front, so the override
  // here takes precedence over the DEFAULT_STATUS_PAYLOAD registered above.
  await mockDaemonApi(page);

  // Issue scenario: master balance ≈ 0.008 ETH, min 0.005 ETH, post-fix daily
  // 0.0005 ETH/day. Excess = 0.003 ETH, runway = 0.003 / 0.0005 = 6 days
  // (BigInt-floored to '5' because (7991886719184102 - 5000000000000000) /
  // 500000000000000 = 5.98... → '5'). This is the exact wei amount captured
  // in operator/test/api/status-build.test.ts:122.
  const boundaryStatus = {
    ...DEFAULT_STATUS_PAYLOAD,
    masterGas: {
      ...DEFAULT_STATUS_PAYLOAD.masterGas,
      address: '0xE64bAf0073a71b0Cb2C0558bB16f24b45E1FB5CF',
      balanceWei: '7991886719184102',
      dailyEstimateWei: '500000000000000',
      runwayDaysExcess: '5',
      minEthWei: '5000000000000000',
    },
  };
  await page.route(
    (url) => url.pathname === '/v1/status',
    (route) =>
      route.fulfill({
        contentType: 'application/json',
        body: JSON.stringify(boundaryStatus),
      }),
  );

  // Pin the bootstrap mode to running so Overview renders WalletCard rather
  // than the onboarding takeover.
  await page.route(
    (url) => url.pathname === '/v1/bootstrap',
    (route) =>
      route.fulfill({
        contentType: 'application/json',
        body: JSON.stringify(DEFAULT_RUNNING_BOOTSTRAP),
      }),
  );

  await page.goto(handshakeUrl ?? `http://127.0.0.1:${PORT}/`);
  await expect(page).toHaveURL(/\/overview$/);

  // WalletCard renders `{runwayDays}d runway` verbatim from
  // status.masterGas.runwayDaysExcess (see Overview.tsx line ~297 and
  // pages/overview/WalletCard.tsx line ~256). At the #288 boundary the
  // dashboard must read "5d runway", not the pre-fix "1d runway" / "0d
  // runway".
  const walletCard = page.getByTestId('wallet-card');
  await expect(walletCard).toBeVisible();
  const gasSection = walletCard.getByTestId('wallet-section-gas');
  await expect(gasSection).toContainText('5d runway');
  // Belt-and-braces: assert that the buggy pre-fix display is NOT what the
  // operator sees. If a future change re-introduces a transform on runwayDays
  // (e.g. coercing '5' → 5 then formatting with two-digit precision), this
  // negative check still fires.
  await expect(gasSection).not.toContainText(/\b[01]d runway\b/);
});
