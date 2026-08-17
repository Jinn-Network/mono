import { test, expect, type Page } from '@playwright/test';
import { mockOperatorApi } from './helpers/mock-operator-api';

function bucket(h1: number, h6: number, h24: number) {
  return { h1, h6, h24, windowEndBlock: 1000, windowEndTs: 1715600000 };
}

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

test('Posting status: the Network "Task posts" panel renders windowed counts from the read plane', async ({
  page,
}) => {
  test.setTimeout(60_000);
  await mockOperatorApi(page);
  await mockTaskPostCounts(page, { h1: 2, h6: 5, h24: 11 });
  await page.goto('/operator/network');

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
  await mockOperatorApi(page);
  await mockTaskPostCounts(page, { h1: 0, h6: 0, h24: 0 });
  await page.goto('/operator/network');

  const panel = page.getByTestId('network-task-posts');
  await expect(panel).toBeVisible({ timeout: 15_000 });
  await expect(panel).toContainText(/No task posts in the last 24h/i);
});
