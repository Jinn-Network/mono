# Scenario T1.4 — SPA route smoke

**Tier:** 1 (single-op, route-mocked, runs on every push)
**Wall-clock budget:** 30s
**Catches:** broken routes, missing endpoint mocks, JS errors introduced by new SPA code, React error boundary firings.

## Goal

Load every SPA route against a mocked daemon API. For each route, assert:
1. No JS error in `page.on('pageerror', ...)`.
2. No React error boundary visible (no `[data-error-boundary]` element).
3. No "endpoint not mocked" console error from missing route intercepts.
4. The page renders past the initial spinner (some recognizable DOM element appears within 5s).

## Implementation location

`operator/test/dashboard/release-prep/spa-route-smoke.e2e.test.ts`

## Inputs

- Routes list: extracted from `operator/src/dashboard/spa/src/App.tsx` (the React Router config). The test imports the route table from a single source of truth.
- Mocked daemon API: reuses the existing `mockDaemonApi(page)` helper from single-op tests (e.g. `operator/test/dashboard/spa-config.e2e.test.ts`).

## Setup

```typescript
import { test, expect, type Page } from '@playwright/test';
// `mockDaemonApi` is currently private inside `operator/test/dashboard/spa-config.e2e.test.ts`.
// Plan C/D should extract it to a shared module before this test can import.
import { mockDaemonApi } from '../helpers/mock-daemon-api';
import { ROUTES } from '../../../src/dashboard/spa/src/routes';   // exported list of route paths

let consoleErrors: string[] = [];
let pageErrors: Error[] = [];

test.beforeEach(async ({ page }) => {
  consoleErrors = [];
  pageErrors = [];
  page.on('console', (msg) => {
    if (msg.type() === 'error') consoleErrors.push(msg.text());
  });
  page.on('pageerror', (err) => pageErrors.push(err));
  await mockDaemonApi(page);
});

for (const route of ROUTES) {
  test(`SPA renders clean at ${route}`, async ({ page }) => {
    await page.goto(`http://127.0.0.1:7332${route}`);
    await page.waitForSelector('main, [data-page-loaded], [data-app-shell]', { timeout: 5000 });
    expect(pageErrors).toHaveLength(0);
    expect(consoleErrors.filter((e) => !e.includes('expected harmless pattern'))).toHaveLength(0);
    await expect(page.locator('[data-error-boundary]')).toHaveCount(0);
  });
}
```

## Routes to cover (initial)

Derived from the existing SPA routes; the actual implementation should import a shared `ROUTES` constant rather than hardcoding here:

- `/` (root → overview redirect)
- `/overview`
- `/configuration`
- `/configuration#network`
- `/configuration#security`
- `/launcher`
- `/launcher/create`
- `/launcher/launched/:placeholder-id`  (with a known mock id)
- `/operator/join/:placeholder-cid` (with a known mock cid)
- `/network`
- `/build`

The test parameterizes over this list; one test per route.

## Failure semantics

- `pageerror` array non-empty → fail with the captured error stack
- React error boundary visible → fail with the boundary's text content (helps debugging)
- Console errors non-empty (after filtering known harmless patterns) → fail with all error messages
- Route doesn't reach the "rendered" sentinel within 5s → fail with "route did not render"

The "known harmless" filter list lives in the test file (e.g. ResizeObserver loop warnings). It starts empty and gets entries added when needed, each with a comment explaining why.

## What this scenario does NOT catch

- Real-daemon behavior (uses mocks)
- Cross-operator state synchronization
- Integration bugs between SPA and real daemon API
- Visual regressions (no screenshot comparison)

These belong in T2.x (cross-op) and Tier 3 (real testnet) scenarios.

## Wall-clock

~30 seconds total: ~3 seconds per route × ~11 routes. Runs in parallel within Playwright's default worker count.

## Dependencies

- The SPA must export a `ROUTES` constant from a single module so this test parameterizes correctly. If `ROUTES` doesn't exist yet, Plan C/D's implementation should add it (small refactor — extract route table from App.tsx).
- `mockDaemonApi` helper — currently a private function inside `operator/test/dashboard/spa-config.e2e.test.ts:~130` (single-arg, hardcoded port 7332). Plan C/D should extract it to a shared module (e.g. `operator/test/dashboard/helpers/mock-daemon-api.ts`) before the multi-op tests can import it.
