import { test, expect, type Page } from '@playwright/test';
import { STATUS_WITH_CONTRACT } from './helpers/mock-operator-api';

const MASTER_ADDR = '0x1111111111111111111111111111111111111111';

const SETUP_BOOTSTRAP_STAGE1 = {
  schemaVersion: 1,
  mode: 'setup',
  steps: ['wallet', 'fund', 'identity'],
  currentStep: 'awaiting_funding',
  services: [],
  master_address: MASTER_ADDR,
  chain: 'base-sepolia',
  funding: {
    master_address: MASTER_ADDR,
    eth_required: '15000000000000000',
    eth_balance: '0',
    targetWei: '15000000000000000',
  },
};

const SETUP_BOOTSTRAP_STAGE2 = {
  ...SETUP_BOOTSTRAP_STAGE1,
  funding: {
    master_address: MASTER_ADDR,
    eth_required: '5000000000000000',
    eth_balance: '5000000000000000',
    targetWei: '10000000000000000',
  },
};

const RUNNING_BOOTSTRAP = {
  schemaVersion: 1,
  mode: 'running',
  onboardingComplete: true,
  steps: ['wallet', 'fund', 'identity', 'service', 'mech'],
  currentStep: 'complete',
  services: [
    { index: 1, step: 'complete', safe_address: '0x2222222222222222222222222222222222222222' },
  ],
  master_address: MASTER_ADDR,
  chain: 'base-sepolia',
};

async function installSequentialMocks(page: Page): Promise<{ dripCalls: () => number }> {
  let phase: 1 | 2 | 3 = 1;
  let dripCount = 0;

  await page.route(
    (url) => url.pathname === '/v1/status',
    (route) =>
      route.fulfill({
        contentType: 'application/json',
        body: JSON.stringify(STATUS_WITH_CONTRACT),
      }),
  );
  await page.route(
    (url) => url.pathname === '/v1/rewards',
    (route) =>
      route.fulfill({
        contentType: 'application/json',
        body: JSON.stringify({
          schemaVersion: 1,
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
  await page.route('**/v1/bootstrap', (route) => {
    const body =
      phase === 1
        ? SETUP_BOOTSTRAP_STAGE1
        : phase === 2
          ? SETUP_BOOTSTRAP_STAGE2
          : RUNNING_BOOTSTRAP;
    route.fulfill({ contentType: 'application/json', body: JSON.stringify(body) });
  });
  await page.route('**/v1/setup/drip', (route) => {
    dripCount += 1;
    if (dripCount === 1) {
      phase = 2;
      route.fulfill({
        contentType: 'application/json',
        body: JSON.stringify({ ok: true, balanceWei: '15000000000000000' }),
      });
    } else if (dripCount === 2) {
      phase = 3;
      route.fulfill({
        contentType: 'application/json',
        body: JSON.stringify({ ok: true, balanceWei: '10000000000000000' }),
      });
    } else {
      route.fulfill({
        status: 409,
        contentType: 'application/json',
        body: JSON.stringify({ ok: false, reason: 'no_more_drips_expected_in_test' }),
      });
    }
  });

  return { dripCalls: () => dripCount };
}

test('funding card auto-continues across Stage 1 → Stage 2 gate change', async ({ page }) => {
  test.setTimeout(60_000);
  const { dripCalls } = await installSequentialMocks(page);
  await page.goto('/');

  await expect(page.getByText(/fund the master eoa/i)).toBeVisible();
  await expect(page.getByText(/0\.015 ETH/i)).toBeVisible();

  await page.getByRole('button', { name: /fund from faucet/i }).click();

  await expect(page.getByTestId('activity-card')).toBeVisible({ timeout: 20_000 });
  expect(dripCalls()).toBe(2);
});
