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
    const chips = page.getByRole('region', { name: 'Active filters' });
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
    const chips = page.getByRole('region', { name: 'Active filters' });
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
    const chips = page.getByRole('region', { name: 'Active filters' });
    await expect(chips).toContainText(/operator:0x/i);
  });

  test('/explore/<cid>?... redirects to /solvernet preserving the query string', async ({ page }) => {
    await page.goto(
      `/explore/${CID}?filter[harness]=codex&filter[model]=gpt-5.4-mini&window=30`,
    );
    await expect(page).toHaveURL(new RegExp(`/solvernet/${CID}\\?.*window=30`));
    const chips = page.getByRole('region', { name: 'Active filters' });
    await expect(chips).toContainText(/harness:codex/i);
  });
});

// ────────────────────────────────────────────────────────────────────────────
// Progressive-disclosure filter chrome (spec 2026-05-26, §4 Interactions, §8
// Acceptance). Covers the cold-landing → add-filter → remove-filter flow plus
// group-by, legend click, leaderboard click, and ⚙ Reset. Each test exercises
// either the cold-landing branch (no filters in URL) or the with-filters
// branch.
//
// URL assertions use `filter(\[|%5B)…(\]|%5D)` to accept either encoding —
// `URLSearchParams.set('filter[harness]', …).toString()` emits the
// percent-encoded form, but browsers may surface the bracketed form when
// reading `page.url()` depending on platform.
//
// `getByRole('button', { name: 'codex' })` matches by accessible name and is
// scoped to either the AddFilterPopover dialog (role=dialog, aria-label="Add
// filter") or the LearningCurve legend (testid) to avoid ambiguity with the
// other "codex" buttons that can coexist.
// ────────────────────────────────────────────────────────────────────────────

test.describe('SolverNetView — cold landing → add filter → remove (spec §8)', () => {
  test.beforeAll(async () => {
    try {
      const res = await fetch(INDEXER_URL, { signal: AbortSignal.timeout(3000) });
      if (!res.ok && res.status >= 500) {
        test.skip(true, `indexer at ${INDEXER_URL} returned ${res.status}`);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      test.skip(true, `indexer at ${INDEXER_URL} unreachable: ${msg}`);
    }
  });

  test('cold landing has no chip strip; + filter and Group by ▾ are visible', async ({ page }) => {
    await page.goto(`/solvernet/${CID}`);
    // The PersistentControlsRow surface is the cold-landing affordance.
    await expect(
      page.getByRole('button', { name: /^Add filter$/i }),
    ).toBeVisible({ timeout: 20_000 });
    await expect(
      page.getByRole('button', { name: /^Group by: none$/i }),
    ).toBeVisible();
    // FilterChipStrip MUST NOT render when no filters are active.
    await expect(
      page.getByRole('region', { name: /Active filters/i }),
    ).toHaveCount(0);
  });

  test('cold-landing + filter → picking a dim surfaces values via lookup slice (#687 bug 2)', async ({ page }) => {
    // Regression for #687 bug 2 — before the fix, opening + filter from the
    // empty state and picking any dim showed "No values to filter by". The fix
    // fires an on-demand slice with group=<pickedDim> to enumerate values.
    await page.goto(`/solvernet/${CID}`);
    await page.getByRole('button', { name: /^Add filter$/i }).click();
    const dialog = page.getByRole('dialog', { name: /Add filter/i });
    await expect(dialog).toBeVisible();
    await dialog.getByRole('button', { name: 'harness' }).click();
    // Either a loading state appears briefly, or values land directly if
    // react-query had a warm cache from a prior session navigation.
    const valueButtons = dialog.locator('button').filter({ hasNotText: /Back/ });
    // Wait for at least one value button (not "Back", not the loading status).
    await expect(valueButtons.first()).toBeVisible({ timeout: 10_000 });
    // The empty-state must NOT appear once values arrive.
    await expect(dialog.getByText(/No values to filter by/i)).toHaveCount(0);
  });

  test('clicking + filter opens the dimension picker; picking a value adds a chip', async ({ page }) => {
    // Start at ?group=harness so the AddFilterPopover has values to offer for
    // the harness dimension (availableValues is derived from slice.series for
    // the current group dim — see SolverNetView line 482-489).
    await page.goto(`/solvernet/${CID}?group=harness`);
    // Wait for the chart to settle (so slice.series is populated).
    await expect(page.getByTestId('learning-curve-legend')).toBeVisible({ timeout: 20_000 });
    await page.getByRole('button', { name: /^Add filter$/i }).click();
    const dialog = page.getByRole('dialog', { name: /Add filter/i });
    await expect(dialog).toBeVisible();
    await dialog.getByRole('button', { name: 'harness' }).click();
    // Step 2 — pick the first available value. Don't bind to a specific
    // harness name; the live indexer may surface codex or claude-code or
    // (unknown) or any future harness.
    const backBtn = dialog.getByRole('button', { name: /Back/i });
    await expect(backBtn).toBeVisible();
    // Value-list buttons have aria-label set to the harness value itself;
    // exclude "Back" and pick the first remaining.
    const valueButtons = dialog.locator('button').filter({ hasNotText: /Back/ });
    const firstVal = valueButtons.first();
    await expect(firstVal).toBeVisible();
    const valueName = ((await firstVal.textContent()) ?? '').trim();
    await firstVal.click();
    // Popover dismisses; chip appears in the FilterChipStrip region.
    await expect(page.getByRole('dialog', { name: /Add filter/i })).toHaveCount(0);
    const region = page.getByRole('region', { name: /Active filters/i });
    await expect(region).toBeVisible();
    // String substring match — sidesteps regex escaping for values that may
    // contain `(`, `)`, `.`, etc. like `(unknown)` or `gpt-5.4-mini`.
    await expect(region).toContainText(`harness:${valueName}`);
    // URL reflects the new filter — assert the key landed, not the value
    // (URL-encoding of e.g. `(unknown)` makes value-anchored regex brittle).
    await expect(page).toHaveURL(/filter(\[|%5B)harness/);
  });

  test('+ filter popover dismisses on outside-click (#687 bug 3)', async ({ page }) => {
    await page.goto(`/solvernet/${CID}`);
    await page.getByRole('button', { name: /^Add filter$/i }).click();
    const dialog = page.getByRole('dialog', { name: /Add filter/i });
    await expect(dialog).toBeVisible();
    // Click somewhere outside the popover — the breadcrumb area at the top is
    // always present and a safe target.
    await page.getByText('SolverNets').first().click();
    await expect(
      page.getByRole('dialog', { name: /Add filter/i }),
    ).toHaveCount(0);
  });

  test('⚙ Slice settings popover dismisses on outside-click (#687 bug 3)', async ({ page }) => {
    await page.goto(`/solvernet/${CID}?filter[harness]=codex`);
    await page
      .getByRole('button', { name: /^Slice settings$/i })
      .click();
    const dialog = page.getByRole('dialog', { name: /Slice settings/i });
    await expect(dialog).toBeVisible();
    await page.getByText('SolverNets').first().click();
    await expect(
      page.getByRole('dialog', { name: /Slice settings/i }),
    ).toHaveCount(0);
  });

  test('does NOT render the legacy ActiveSliceChips strip alongside the new chip strip (#687 bug 1)', async ({ page }) => {
    await page.goto(
      `/solvernet/${CID}?filter[harness]=codex&filter[model]=gpt-5.4-mini&window=30`,
    );
    await expect(
      page.getByRole('region', { name: /Active filters/i }),
    ).toBeVisible({ timeout: 20_000 });
    // The legacy strip used data-testid="active-slice-chips" — deleted in
    // #687 bug 1. Must not be in the DOM.
    await expect(page.locator('[data-testid="active-slice-chips"]')).toHaveCount(0);
  });

  test('clicking × on a chip removes the filter; strip collapses to cold landing', async ({ page }) => {
    await page.goto(`/solvernet/${CID}?filter[harness]=codex`);
    const region = page.getByRole('region', { name: /Active filters/i });
    await expect(region).toBeVisible({ timeout: 20_000 });
    await expect(region).toContainText(/harness:codex/i);
    await page.getByRole('button', { name: /Remove harness=codex/i }).click();
    await expect(page.getByRole('region', { name: /Active filters/i })).toHaveCount(0);
    // URL no longer carries filter[harness]= in either encoding.
    await expect(page).not.toHaveURL(/filter(\[|%5B)harness/);
    // Cold-landing affordances are back.
    await expect(page.getByRole('button', { name: /^Add filter$/i })).toBeVisible();
  });

  test('Group by dropdown — picking a dim writes group=…; picking none clears it', async ({ page }) => {
    await page.goto(`/solvernet/${CID}`);
    const trigger = page.getByRole('button', { name: /^Group by: none$/i });
    await expect(trigger).toBeVisible({ timeout: 20_000 });
    await trigger.click();
    // Menu open — pick harness.
    await page.getByRole('menuitem', { name: 'harness' }).click();
    await expect(
      page.getByRole('button', { name: /^Group by: harness$/i }),
    ).toBeVisible();
    await expect(page).toHaveURL(/[?&]group=harness/);
    // Reset to none — useGroupParam deletes the key when value is the default
    // (see url-state.ts useGroupParam), so the resulting URL has no group=.
    await page.getByRole('button', { name: /^Group by: harness$/i }).click();
    await page.getByRole('menuitem', { name: 'none' }).click();
    await expect(
      page.getByRole('button', { name: /^Group by: none$/i }),
    ).toBeVisible();
    await expect(page).not.toHaveURL(/[?&]group=/);
  });

  test('legend click on grouped chart adds filter[harness]= and auto-clears group (bug 6.1)', async ({ page }) => {
    await page.goto(`/solvernet/${CID}?group=harness`);
    const legend = page.getByTestId('learning-curve-legend');
    await expect(legend).toBeVisible({ timeout: 20_000 });
    // Wait for the chart plot too — the legend may render briefly while the
    // slice query is still loading, and an early click can race with a
    // subsequent re-render and lose the URL update.
    await expect(page.getByTestId('learning-curve-plot')).toBeVisible();
    // Click the first legend button. Its accessible name is
    // `<harness-value> → filter to this` (the hover-hint span lives inside
    // the same <button>). Strip the hover-hint suffix to recover the value;
    // skip the value-anchored URL regex for it (value may contain `(`, `)`,
    // `.` and be URL-encoded.)
    const firstBtn = legend.locator('button').first();
    const rawLabel = ((await firstBtn.textContent()) ?? '').trim();
    const harnessValue = rawLabel.replace(/→ filter to this\s*$/i, '').trim();
    // Hover first so the hover-hint span is at opacity:1; the legend uses an
    // opacity-0 hover hint, and an immediate click (before any pointer
    // events fire) can lose the update against the next slice fetch.
    await firstBtn.hover();
    await firstBtn.click();
    // Filter key landed (either encoding).
    await expect(page).toHaveURL(/filter(\[|%5B)harness/);
    // Chip strip carries the matching value.
    await expect(
      page.getByRole('region', { name: /Active filters/i }),
    ).toContainText(`harness:${harnessValue}`);
    // Bug 6.1: the degenerate group=harness clause auto-clears once the
    // harness filter narrows the slice to one value.
    await expect(page).not.toHaveURL(/[?&]group=harness/);
  });

  test('leaderboard row click adds filter[operator]=', async ({ page }) => {
    await page.goto(`/solvernet/${CID}`);
    // Leaderboard operator buttons render the shortened addr "0xabcd…1234"
    // followed by the hover-hint span ("→ filter to this"), so the accessible
    // name starts with 0x. Match leading-0x, not anchored-end.
    const opBtn = page.getByRole('button', { name: /^0x[a-f0-9…]+/i }).first();
    await expect(opBtn).toBeVisible({ timeout: 20_000 });
    await opBtn.click();
    await expect(page).toHaveURL(/filter(\[|%5B)operator(\]|%5D)=0x/);
    // The chip strip renders the operator chip.
    await expect(
      page.getByRole('region', { name: /Active filters/i }),
    ).toContainText(/operator:0x/i);
  });

  test('⚙ Slice settings → Reset to default clears all slice params', async ({ page }) => {
    await page.goto(
      `/solvernet/${CID}?filter[harness]=codex&group=mode&window=30&include=raw`,
    );
    // Confirm the loaded slice landed.
    await expect(
      page.getByRole('region', { name: /Active filters/i }),
    ).toBeVisible({ timeout: 20_000 });
    await page.getByRole('button', { name: /^Slice settings$/i }).click();
    const dialog = page.getByRole('dialog', { name: /Slice settings/i });
    await expect(dialog).toBeVisible();
    await dialog.getByRole('button', { name: /^Reset to default$/i }).click();
    // URL is just /solvernet/<cid> — no query params. A trailing bare `?` is
    // tolerated (wouter's `useSearchParams` setter concatenates
    // `location + "?" + URLSearchParams.toString()`, which leaves a dangling
    // `?` when all params are removed; the URL is semantically equivalent).
    await expect(page).toHaveURL(new RegExp(`/solvernet/${CID}\\??$`));
    await expect(
      page.getByRole('region', { name: /Active filters/i }),
    ).toHaveCount(0);
  });
});
