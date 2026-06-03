// client/test/dashboard/multi-op/real-paired-smoke.e2e.test.ts
//
// Mode 2 (DR-2026-06-03, #1014): NON-GATING real paired app smoke. Two real
// testnet operator dashboards — op-a creates+launches a SolverNet, op-b
// discovers it in the catalog and joins. Real SPA + real testnet (NOT an Anvil
// fork — so no live-fork browser E2E enters any blocking gate). This file is
// classified non-gating: it runs in environment-suite.yml's continue-on-error
// job and never blocks the cut. Skips cleanly when the operator URLs are absent.
import { test, expect } from '@playwright/test';

const OP_A_URL = process.env.JINN_SMOKE_OP_A_URL;
const OP_B_URL = process.env.JINN_SMOKE_OP_B_URL;

test.describe('real paired app smoke (non-gating)', () => {
  test.skip(
    !OP_A_URL || !OP_B_URL,
    'JINN_SMOKE_OP_A_URL / JINN_SMOKE_OP_B_URL not set — real paired smoke skipped',
  );

  test('op-a launches a SolverNet on real testnet; op-b discovers + joins it', async ({ browser }) => {
    // Real testnet launch crosses several ~30s daemon cadences + on-chain
    // confirmation; budget generously. Non-gating, so a timeout is a neutral
    // signal, never a blocked cut.
    test.setTimeout(12 * 60 * 1000);

    const opACtx = await browser.newContext();
    const opBCtx = await browser.newContext();
    const opA = await opACtx.newPage();
    const opB = await opBCtx.newPage();

    try {
      // ===== op-a: create + launch via the Launcher wizard =====
      await opA.goto(OP_A_URL!);
      const opAOrigin = new URL(opA.url()).origin;
      await opA.goto(`${opAOrigin}/launcher`);
      await opA.getByRole('link', { name: /create solvernet/i }).click();

      const solverNetName = `smoke-${Date.now()}`;
      // Step 1: Define
      await opA.getByLabel(/name/i).fill(solverNetName);
      await opA.getByLabel(/description/i).fill('Real paired smoke SolverNet');
      await opA.getByRole('button', { name: /next/i }).click();
      // Step 2: Review Contract
      await opA.getByRole('button', { name: /next/i }).click();
      // Step 3: Configure Generator
      await opA.getByLabel(/cadence/i).fill('60000');
      await opA.getByRole('button', { name: /next/i }).click();
      // Step 4: Pricing (both inputs; validatePricing needs at least one > 0)
      await opA.getByTestId('launcher-create-solutionPriceWei').fill('100000000000000');
      await opA.getByTestId('launcher-create-verdictPriceWei').fill('50000000000000');
      await opA.getByRole('button', { name: /next/i }).click();
      // Step 5: Review + Launch
      await opA.getByRole('button', { name: /launch/i }).click();

      await expect(opA.getByText(/launched/i).first()).toBeVisible({ timeout: 180_000 });
      const manifestCid = (await opA.getByTestId('manifest-cid').textContent({ timeout: 15_000 }))?.trim();
      expect(manifestCid).toMatch(/^bafk?rei/);

      // ===== op-b: discover in catalog + join =====
      await opB.goto(OP_B_URL!);
      const opBOrigin = new URL(opB.url()).origin;

      // op-b's substrate refreshes its catalog on its own cadence; reload until
      // op-a's SolverNet appears (real cross-operator propagation).
      let found = false;
      for (let i = 0; i < 20 && !found; i++) {
        await opB.goto(`${opBOrigin}/operator/registry`);
        const card = opB.locator(`[data-testid="registry-card"] [data-manifest-cid="${manifestCid}"]`);
        if (await card.count()) found = true;
        else await opB.waitForTimeout(15_000);
      }
      expect(found, 'op-b should discover op-a\'s SolverNet in the catalog').toBe(true);

      await opB.getByTestId('registry-join-cta').first().click();
      await expect(opB.getByTestId('join-flow')).toBeVisible({ timeout: 30_000 });
      await opB.getByTestId('join-flow').getByLabel('Solver').check();
      await opB.getByTestId('join-flow-submit').click();
      await expect(opB.getByTestId('join-flow-success-card')).toBeVisible({ timeout: 60_000 });
    } finally {
      // Always capture screenshots for per-cut visibility (uploaded by CI).
      await opA.screenshot({ path: 'test-results/smoke-op-a.png', fullPage: true }).catch(() => {});
      await opB.screenshot({ path: 'test-results/smoke-op-b.png', fullPage: true }).catch(() => {});
      await opACtx.close();
      await opBCtx.close();
    }
  });
});
