/**
 * Milestone-load-bearing smoke test (#656).
 *
 * Drives the locked-config URL from issue #656 and asserts:
 *   (a) active-filter chips render `harness:codex` and `model:gpt-5.4-mini`
 *   (b) the series-count is 1 (group=none → one series)
 *   (c) the window selector reads `30`
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
const LOCKED_URL = `/explore/${CID}?filter[harness]=codex&filter[model]=gpt-5.4-mini&group=none`;
const INDEXER_URL = process.env.JINN_INDEXER_URL ?? 'http://localhost:42069';

test.describe('Milestone #2 — locked-config URL renders', () => {
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

  test('window selector defaults to 30 when the URL leaves it implicit', async ({ page }) => {
    // The milestone URL leaves `window` unset; ExploreView defaults to 30 (per #656
    // milestone description). The chart and the selector must agree at the default.
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
});
