import { test, expect } from '@playwright/test';

/**
 * Console against a real operator daemon (no page.route mocks).
 *
 * Does not PUT claim-policy — that would mutate the operator's on-disk config.
 * Claim-policy Save → PUT stays in the mock suite.
 */
test.describe('live daemon console', () => {
  test.beforeEach(async ({ page }) => {
    test.skip(
      process.env.LIVE_OPERATOR_E2E !== '1',
      'set LIVE_OPERATOR_E2E=1 with a daemon on :7331 and console on localhost:3000',
    );
    page.on('pageerror', (err) => {
      throw err;
    });
  });

  test('Overview shows fleet identity and a real rewards payload', async ({ page }) => {
    await page.goto('/');
    await expect(page.getByTestId('overview-page-grid')).toBeVisible({ timeout: 20_000 });
    await expect(page.getByTestId('identity-master')).toHaveText(/Master 0x[0-9a-fA-F]{40}/);
    await expect(page.getByTestId('identity-agent')).toHaveText(/Agent 0x[0-9a-fA-F]{40}/);
    await expect(page.getByTestId('identity-safe')).toHaveText(/Safe 0x[0-9a-fA-F]{40}/);
    await expect(page.getByTestId('identity-service-id')).toHaveText(/Service \d+/);
    await expect(page.getByTestId('identity-agent-id')).toHaveText(/Agent ID \S+/);
    await expect(page.getByTestId('rewards-unavailable')).toHaveCount(0);
    await expect(page.getByTestId('rewards-value')).toBeVisible();
    await expect(page.getByTestId('rewards-value')).not.toHaveText(/pendingOlas/);
  });

  test('Claim policy editor loads (not the loading shell)', async ({ page }) => {
    await page.goto('/');
    await expect(page.getByTestId('overview-page-grid')).toBeVisible({ timeout: 20_000 });
    await page.getByRole('link', { name: /^Claim policy$/i }).click();
    await expect(page.getByTestId('claim-policy-tab')).toBeVisible({ timeout: 20_000 });
    await expect(page.getByTestId('claim-policy-tab-loading')).toHaveCount(0);
    await expect(page.getByTestId('claim-policy-mode')).toBeVisible();
  });

  test('Events table has unique row keys after recent+SSE backfill', async ({ page }) => {
    await page.goto('/');
    await expect(page.getByTestId('overview-page-grid')).toBeVisible({ timeout: 20_000 });
    await page.getByRole('link', { name: /^Events$/i }).click();
    await expect(page.locator('table tbody tr').first()).toBeVisible({ timeout: 20_000 });
    const texts = await page.locator('table tbody tr').allInnerTexts();
    expect(texts.length).toBeGreaterThan(0);
    expect(new Set(texts).size).toBe(texts.length);
  });
});
