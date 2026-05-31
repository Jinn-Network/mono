// client/test/dashboard/multi-op/launcher-join-flow.e2e.test.ts
import { test, expect } from './fixtures/two-substrate-ops';

test('T2.3 — op-a launches, op-b joins, both observe each other', async ({ browser, opAUrl, opBUrl }) => {
  // 8 min: this drives TWO substrate daemons against a Base Sepolia Anvil fork
  // through a full launcher-create → launch → cross-operator catalog-discovery →
  // join → observe flow. Several legs are gated on independent ~30s daemon
  // cadences (op-a's Launcher list load, op-a's on-chain launch, op-b's catalog
  // refresh) that stack on the fork, and the original 5-min budget was below
  // their realistic sum. Every step is gated by its own inner assertion, so the
  // wider budget gives a genuinely-progressing flow room without masking a hang.
  test.setTimeout(8 * 60 * 1000);

  const opACtx = await browser.newContext();
  const opBCtx = await browser.newContext();
  const opAPage = await opACtx.newPage();
  const opBPage = await opBCtx.newPage();

  try {
    // ===== op-a: Launcher Create wizard =====
    await opAPage.goto(opAUrl);
    // First load sets the jinn_ui_token cookie from the `?k=` handshake URL, so
    // later same-origin navigations (e.g. /launcher/launched) need no query param.
    const opAOrigin = new URL(opAPage.url()).origin;
    await opAPage.getByRole('link', { name: /launcher/i }).click();
    // The "Create SolverNet" CTA on the Launcher list page is a shadcn
    // `<Button asChild><Link>…</Link></Button>`, so it renders as an <a>
    // (role="link"), not a <button> — in BOTH render paths (the EmptyState
    // button and the populated-list header CTA). The prior
    // `getByRole('button', { name: /create solvernet/i })` matched nothing and
    // hung the full 300s Playwright budget (mis-filed as #525 "flake-timing";
    // it was a deterministic selector mismatch, not a slow flow). Match the
    // link role so the selector works regardless of which path renders.
    await opAPage.getByRole('link', { name: /create solvernet/i }).click();

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

    // Step 4: Configure Pricing. The wizard now has two distinct price inputs
    // (solution + verdict); `getByLabel(/price/i)` matched both and resolved to
    // an ambiguous locator that never became actionable. Target each input by
    // its stable test id. validatePricing requires at least one positive price,
    // so set both.
    await opAPage.getByTestId('launcher-create-solutionPriceWei').fill('100000000000000');
    await opAPage.getByTestId('launcher-create-verdictPriceWei').fill('50000000000000');
    await opAPage.getByRole('button', { name: /next/i }).click();

    // Step 5: Review and Launch
    await opAPage.getByRole('button', { name: /launch/i }).click();

    // Wait for state machine to reach 'launched'
    await expect(opAPage.getByText(/launched/i).first()).toBeVisible({ timeout: 120000 });
    const manifestCid = await opAPage.getByTestId('manifest-cid').textContent({ timeout: 10000 });
    // The shared mock IPFS returns a base32 CIDv1-raw (`bafkrei…`), matching the
    // real Autonolas registry's multibase form. The StatusHeader truncates the
    // CID for display, so match the prefix only — what matters is that a real
    // CIDv1 rendered, not a placeholder.
    expect(manifestCid).toMatch(/^bafkrei/);

    // ===== op-b: Catalog sees op-a's SolverNet =====
    // First load establishes the jinn_ui_token cookie (from the `?k=` handshake
    // URL), so later same-origin navigations don't need the query param.
    await opBPage.goto(opBUrl);
    const opBOrigin = new URL(opBPage.url()).origin;

    // Drive directly to the catalog route and reload on a tight cadence until
    // op-a's SolverNet appears. The reload serves two purposes:
    //   1. op-b's substrate daemon re-runs FleetBootstrapper + eviction-recovery
    //      against the fork at startup; `/v1/bootstrap` reads earning_state.json
    //      from disk, which can transiently read non-`complete` while recovery
    //      runs, briefly gating the SPA on the Onboarding screen. A reload after
    //      the daemon settles re-evaluates the gate and lands on the operating
    //      shell. (Clicking nav links instead would hang on Onboarding.)
    //   2. op-b's catalog row only surfaces after op-b's daemon catalog
    //      refresher (≤30s) enriches op-a's manifest from the shared mock IPFS;
    //      each reload forces an immediate fresh `/v1/solvernets/registry` fetch
    //      rather than waiting behind the SPA's in-page 30s poll.
    // Not a blind timeout bump — the inner getByText is the real gate; if the
    // row never enriches the loop still fails.
    await expect(async () => {
      await opBPage.goto(`${opBOrigin}/operator/registry`);
      await expect(opBPage.getByText(solverNetName)).toBeVisible({ timeout: 5000 });
    }).toPass({ timeout: 180000, intervals: [4000] });

    // ===== op-b joins =====
    // The catalog card's join CTA is a shadcn `<Button asChild><Link>Join</Link>`
    // → an <a role="link"> (data-testid registry-join-cta), not a <button>; the
    // prior `getByRole('button', {name:/^join$/i})` matched nothing and hung.
    // Target the CTA by test id, which routes to the multi-step JoinFlow.
    await opBPage.getByTestId('registry-join-cta').first().click();
    // JoinFlow is a multi-step form: pick a role, then submit. Choose the
    // evaluator role — PredictionV1Evaluator is deterministic and always
    // ready, so it never trips the solver-harness readiness gate that would
    // disable the submit button. Fall back to solver if evaluator isn't open.
    const evaluatorOption = opBPage.locator('[data-testid="join-role-option"][data-role="evaluator"]');
    const roleToggle = (await evaluatorOption.count()) > 0
      ? evaluatorOption
      : opBPage.locator('[data-testid="join-role-option"]').first();
    await roleToggle.click();
    await opBPage.getByTestId('join-flow-submit').click();
    // Success surface (#333) shows the SolverNet just joined + the restart hint.
    await expect(opBPage.getByTestId('join-flow-success')).toBeVisible({ timeout: 30000 });
    await expect(opBPage.getByTestId('join-flow-success-restart')).toBeVisible({ timeout: 5000 });

    // ===== op-a sees op-b's join =====
    await opAPage.goto(`${opAOrigin}/launcher/launched`);
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
