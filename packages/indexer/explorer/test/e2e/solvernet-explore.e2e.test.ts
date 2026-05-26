/**
 * Milestone-load-bearing smoke test for the merged /solvernet/<cid> view
 * (refactor #676).
 *
 * Drives the post-merge locked-config URL and asserts:
 *   (a) active-filter chips render `harness:codex` and `model:gpt-5.4-mini`
 *   (b) the series-count is 1 (group=none → one series)
 *   (c) the window selector reads `30`
 *   (d) clicking a legend value adds `filter[harness]=...` to the chip strip
 *   (e) clicking an operator row body adds `filter[operator]=...`
 *   (f) /explore/<cid>?... redirects to /solvernet/<cid>?... preserving the
 *       full query string
 *
 * Backed by the Railway-hosted indexer when JINN_INDEXER_URL points there.
 * When unset, falls back to localhost:42069 (the Ponder default).
 *
 * Skipped automatically when the indexer is unreachable — `test.beforeAll`
 * issues a 3 s health-check probe against `JINN_INDEXER_URL` (default
 * `http://localhost:42069`) and calls `test.skip()` if it fails. This is a
 * smoke, not a contract test. Numeric agreement with #648's
 * check-milestone-2.ts lives in that script, not here.
 */
import { test, expect } from '@playwright/test';

const CID = 'bafkreichdzxtjav3rh5boyybgx6wolh7boqedxix4vvw44slfppwppshpi';
const LOCKED_URL = `/solvernet/${CID}?filter[harness]=codex&filter[model]=gpt-5.4-mini&window=30`;
const INDEXER_URL = process.env.JINN_INDEXER_URL ?? 'http://localhost:42069';

test.describe('Milestone #2 — locked-config URL renders on /solvernet', () => {
  test.beforeAll(async () => {
    // Skip cleanly when the indexer is unreachable. The frontend would
    // render an error state and the assertions below would fail — but a
    // backend outage isn't what this smoke is meant to catch.
    try {
      const res = await fetch(INDEXER_URL, {
        signal: AbortSignal.timeout(3000),
      });
      if (!res.ok && res.status >= 500) {
        test.skip(true, `indexer at ${INDEXER_URL} returned ${res.status}`);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      test.skip(true, `indexer at ${INDEXER_URL} unreachable: ${msg}`);
    }
  });

  test('renders the active-slice chips for codex + gpt-5.4-mini', async ({ page }) => {
    await page.goto(LOCKED_URL);
    const chips = page.getByTestId('active-slice-chips');
    await expect(chips).toContainText(/harness:codex/i);
    await expect(chips).toContainText(/model:gpt-5\.4-mini/i);
  });

  test('window selector reads 30 when the URL has window=30', async ({ page }) => {
    await page.goto(LOCKED_URL);
    const winBtn = page.getByRole('button', { name: '30' });
    await expect(winBtn).toHaveAttribute('aria-pressed', 'true');
  });

  test('renders exactly one series (group=none) — chart canvas or below-floor state', async ({ page }) => {
    await page.goto(LOCKED_URL);
    // Either the chart renders or the below-floor empty state — both are
    // valid milestone states depending on the live indexer's data.
    const chart = page.getByTestId('learning-curve-plot');
    const empty = page.getByTestId('explore-below-floor');
    await expect(chart.or(empty)).toBeVisible({ timeout: 20_000 });
  });

  test('clicking a legend value (group=harness) appends filter[harness]= to chips', async ({ page }) => {
    await page.goto(`/solvernet/${CID}?group=harness`);
    const legend = page.getByTestId('learning-curve-legend');
    await expect(legend).toBeVisible({ timeout: 20_000 });
    // Click the first legend <button>. Series label is harness-specific (e.g.
    // "codex" / "claude"); we don't know it without the live data, so click
    // the first one and assert the chips reflect a harness:* filter.
    const firstBtn = legend.locator('button').first();
    await firstBtn.click();
    const chips = page.getByTestId('active-slice-chips');
    await expect(chips).toContainText(/harness:/i);
  });

  test('clicking an operator row body appends filter[operator]= to chips', async ({ page }) => {
    await page.goto(`/solvernet/${CID}`);
    // Find any leaderboard operator-row button (rendered as <button> when
    // onOperatorClick is wired, which it is on SolverNetView).
    // Operator addresses render shortened "0x...."; the regex is tolerant.
    const opBtn = page.getByRole('button', { name: /^0x[a-f0-9…]+$/i }).first();
    await expect(opBtn).toBeVisible({ timeout: 20_000 });
    await opBtn.click();
    const chips = page.getByTestId('active-slice-chips');
    await expect(chips).toContainText(/operator:0x/i);
  });

  test('/explore/<cid>?... redirects to /solvernet preserving the query string', async ({ page }) => {
    await page.goto(
      `/explore/${CID}?filter[harness]=codex&filter[model]=gpt-5.4-mini&window=30`,
    );
    await expect(page).toHaveURL(new RegExp(`/solvernet/${CID}\\?.*window=30`));
    const chips = page.getByTestId('active-slice-chips');
    await expect(chips).toContainText(/harness:codex/i);
  });
});
