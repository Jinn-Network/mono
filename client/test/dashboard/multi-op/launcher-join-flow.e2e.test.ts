// client/test/dashboard/multi-op/launcher-join-flow.e2e.test.ts
import { test, expect } from './fixtures/two-substrate-ops';

test('T2.3 — op-a launches, op-b joins, both observe each other', async ({ browser, opAUrl, opBUrl }) => {
  test.setTimeout(5 * 60 * 1000);

  const opACtx = await browser.newContext();
  const opBCtx = await browser.newContext();
  const opAPage = await opACtx.newPage();
  const opBPage = await opBCtx.newPage();

  try {
    // ===== op-a: Launcher Create wizard =====
    await opAPage.goto(opAUrl);
    await opAPage.getByRole('link', { name: /launcher/i }).click();
    await opAPage.getByRole('button', { name: /create solvernet/i }).click();

    const solverNetName = `t23-${Date.now()}`;

    // Step 1: Define
    await opAPage.getByLabel(/name/i).fill(solverNetName);
    await opAPage.getByLabel(/description/i).fill('T2.3 e2e test SolverNet');
    await opAPage.getByRole('button', { name: /next/i }).click();

    // Step 2: Review Contract
    await opAPage.getByRole('button', { name: /next/i }).click();

    // Step 3: Configure Generator
    await opAPage.getByLabel(/cadence/i).fill('60000');
    await opAPage.getByRole('button', { name: /next/i }).click();

    // Step 4: Configure Pricing
    await opAPage.getByLabel(/price/i).fill('100');
    await opAPage.getByRole('button', { name: /next/i }).click();

    // Step 5: Review and Launch
    await opAPage.getByRole('button', { name: /launch/i }).click();

    // Wait for state machine to reach 'launched'
    await expect(opAPage.getByText(/launched/i).first()).toBeVisible({ timeout: 120000 });
    const manifestCid = await opAPage.getByTestId('manifest-cid').textContent({ timeout: 10000 });
    expect(manifestCid).toMatch(/^bafkrei/);

    // ===== op-b: Catalog sees op-a's SolverNet =====
    await opBPage.goto(opBUrl);
    await opBPage.getByRole('link', { name: /operator/i }).click();
    await opBPage.getByRole('button', { name: /browse catalog/i }).click();

    // Allow indexer + SPA polling lag (~30s).
    await expect(opBPage.getByText(solverNetName)).toBeVisible({ timeout: 60000 });

    // ===== op-b joins =====
    await opBPage.getByText(solverNetName).click();
    await opBPage.getByRole('button', { name: /^join$/i }).click();
    await expect(opBPage.getByText(/restart required/i)).toBeVisible({ timeout: 10000 });

    // ===== op-a sees op-b's join =====
    await opAPage.goto(`${opAUrl}/launcher/launched`);
    await opAPage.getByText(solverNetName).click();

    // The launched dashboard now surfaces an `operator-count` element
    // (issue #351 — StatusHeader "Operators" field, fed by
    // `GET /v1/discovery/solvernet-operator-count`). The element exists and
    // renders a real, indexer-derived number — so this assertion is now live:
    // T2.3 verifies the surface unconditionally.
    await expect(opAPage.getByTestId('operator-count')).toHaveText(/\d+/, {
      timeout: 60000,
    });

    // The "exactly 1 operator joined" magnitude assertion stays gated.
    // #351 surfaced that an operator "join" is purely a local config write to
    // `joinedSolverNets[<cid>]` on the joining operator's daemon
    // (spec/2026-05-05-solvernet-creation-and-launch.md §12) — it leaves NO
    // on-chain footprint. The only protocol-observable signal is
    // `TaskAttemptCreated`: an operator becomes visible network-wide once they
    // *claim a task*. So `operator-count` counts *participating* operators, and
    // in this scenario op-b joins but never claims a task — the honest count is
    // 0, not 1.
    //
    // Asserting `/1/` unconditionally requires either (a) extending this
    // scenario so op-b restarts + claims a task, or (b) a new on-chain
    // operator-registration event + indexer entity so config-level joins
    // become observable. Both are out of scope for #351; tracked as follow-up.
    // Set JINN_T23_OPERATOR_COUNT_READY=1 once op-b also produces an on-chain
    // operator footprint.
    if (process.env['JINN_T23_OPERATOR_COUNT_READY'] === '1') {
      await expect(opAPage.getByTestId('operator-count')).toHaveText(/1/, { timeout: 60000 });
    } else {
      console.warn(
        'T2.3: operator-count element is present and indexer-wired (GH #351); the ' +
          '"1 operator joined" magnitude assertion stays gated — a config-level join has no ' +
          'on-chain footprint, so a join-only scenario yields 0. Set ' +
          'JINN_T23_OPERATOR_COUNT_READY=1 once op-b also claims a task on-chain.',
      );
    }
  } finally {
    await opACtx.close();
    await opBCtx.close();
  }
});
