import { test, expect, type Route } from '@playwright/test';
import { mockOperatorApi } from './helpers/mock-operator-api';

interface ObservedClaimPolicyPut {
  method: string;
  body: {
    claimPolicy?: { mode?: string; spendCapWei?: string; aiUnitCap?: number };
  };
}

test('Claim policy: operator edits caps and Save drives a PUT /v1/operator/claim-policy mutation that takes effect', async ({
  page,
}) => {
  test.setTimeout(60_000);
  await mockOperatorApi(page);

  const observedPuts: ObservedClaimPolicyPut[] = [];

  await page.route(
    (url) => url.pathname === '/v1/operator/claim-policy',
    async (route: Route) => {
      const req = route.request();
      if (req.method() === 'PUT') {
        const body = (req.postDataJSON?.() ?? {}) as ObservedClaimPolicyPut['body'];
        observedPuts.push({ method: req.method(), body });
        return route.fulfill({
          contentType: 'application/json',
          body: JSON.stringify({ restartRequired: true }),
        });
      }
      return route.fulfill({
        contentType: 'application/json',
        body: JSON.stringify({
          claimPolicy: { mode: 'every-runnable' },
          executionWiring: [
            {
              workKind: 'prediction.v1',
              harness: 'claude-code-learner',
              model: 'claude-haiku-4-5-20251001',
              plugins: ['jinn-prediction-plugin'],
              credentialRef: 'default',
              isolationPolicy: 'worktree',
            },
          ],
          restartRequired: false,
        }),
      });
    },
  );

  await page.goto('/operator/claim-policy');

  const tab = page.getByTestId('claim-policy-tab');
  await expect(tab).toBeVisible({ timeout: 15_000 });
  await expect(page.getByTestId('claim-policy-mode')).toHaveText('every-runnable');
  await expect(page.getByTestId('execution-wiring-row')).toHaveCount(1);
  await expect(page.getByTestId('execution-wiring-row')).toContainText('prediction.v1');

  await page.getByTestId('claim-policy-spend-cap').fill('250000000000000');
  await page.getByTestId('claim-policy-ai-unit-cap').fill('7');
  await page.getByTestId('claim-policy-save').click();

  await expect(page.getByTestId('claim-policy-restart-required')).toBeVisible({
    timeout: 15_000,
  });

  expect(observedPuts).toHaveLength(1);
  expect(observedPuts[0]?.body.claimPolicy).toEqual({
    mode: 'every-runnable',
    spendCapWei: '250000000000000',
    aiUnitCap: 7,
  });
});
