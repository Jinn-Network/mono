import { test, expect, type Page, type Route } from '@playwright/test';
import { mockOperatorApi } from './helpers/mock-operator-api';

async function mockChangePassword(page: Page, passwordFileUpdated: boolean): Promise<void> {
  await page.route(
    (url) => url.pathname === '/v1/setup/change-password',
    async (route: Route) => {
      if (route.request().method() !== 'POST') {
        return route.fulfill({ status: 405, body: '' });
      }
      return route.fulfill({
        contentType: 'application/json',
        body: JSON.stringify({ ok: true, passwordFileUpdated }),
      });
    },
  );
}

async function submitRotation(page: Page): Promise<void> {
  await page.goto('/operator/security');
  const tab = page.getByTestId('security-tab');
  await expect(tab).toBeVisible({ timeout: 15_000 });
  await page.getByLabel('Current password').fill('old-secret');
  await page.getByLabel('New password').fill('new-secret');
  await page.getByRole('button', { name: 'Rotate password' }).click();
}

test('Security: passwordFileUpdated true leaves the host-wide-file notice hidden', async ({
  page,
}) => {
  test.setTimeout(60_000);
  await mockOperatorApi(page);
  await mockChangePassword(page, true);
  await submitRotation(page);

  await expect(page.getByTestId('security-password-file-not-updated')).toHaveCount(0);
  await expect(page.getByLabel('Current password')).toHaveValue('');
  await expect(page.getByLabel('New password')).toHaveValue('');
});

test('Security: passwordFileUpdated false names the host-wide file skip and JINN_PASSWORD', async ({
  page,
}) => {
  test.setTimeout(60_000);
  await mockOperatorApi(page);
  await mockChangePassword(page, false);
  await submitRotation(page);

  const notice = page.getByTestId('security-password-file-not-updated');
  await expect(notice).toBeVisible({ timeout: 15_000 });
  await expect(notice).toContainText('keystore-password');
  await expect(notice).toContainText('does not belong to this daemon');
  await expect(notice).toContainText('JINN_PASSWORD');
  await expect(page.getByLabel('Current password')).toHaveValue('');
  await expect(page.getByLabel('New password')).toHaveValue('');
});
