# App-Experience Coverage Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close the SPA app-experience coverage gap left by deleting T2.3 — a deterministic create→launch→join journey that gates, plus a non-gating real paired smoke that's visible on every cut.

**Architecture:** Two modes, keyed to determinism (DR-2026-06-03). Mode 1 = a net-new `join.e2e.test.ts` using the pure mocked-daemon Playwright pattern (real daemon serves the SPA + auth handshake; all `/v1/*` data calls intercepted at the `page.route()` boundary), folded into the hermetic gate via a scoped `e2e:app-flow` script alongside the existing `solvernet-flow` (create→launch). Mode 2 = a `real-paired-smoke.e2e.test.ts` that drives two real testnet operator dashboards, wired as a non-gating `continue-on-error` job in `environment-suite.yml`.

**Tech Stack:** Playwright (`@playwright/test`, chromium-only), the existing `mock-daemon-api.ts` helper, the daemon-spawn pattern from `spa.e2e.test.ts`, GitHub Actions.

**Sequencing:** Tasks 1–3 and 5 run on `next` today (test code + scripts). Tasks 4 and 6 edit the workflow files introduced by PR #960 (`hermetic-gate.yml`, `environment-suite.yml`) and land **after** #960 merges — they are marked `[after #960]`.

---

## File Structure

- **Modify** `client/test/dashboard/helpers/mock-daemon-api.ts` — add the missing `GET /v1/harnesses/:name/readiness` route (every catalog/join test needs it) and export two fixture builders (`makeRegistrySummary`, `makeRegistryManifestResponse`) so the join test and the real-smoke test share one fixture surface.
- **Create** `client/test/dashboard/join.e2e.test.ts` — the deterministic discover→join→observe journey (op-b's SPA, mocked catalog containing op-a's launched SolverNet).
- **Modify** `client/package.json` — add `e2e:join` (single-test convenience) and `e2e:app-flow` (the gating bundle: `solvernet-flow` + `join`).
- **Create** `client/test/dashboard/multi-op/real-paired-smoke.e2e.test.ts` — Mode 2; drives two real testnet operator dashboard URLs from env; `test.skip()` when env absent.
- **Modify** `.github/workflows/hermetic-gate.yml` `[after #960]` — Chromium install + `yarn e2e:app-flow` step inside the existing `hermetic-gate` job.
- **Modify** `.github/workflows/environment-suite.yml` `[after #960]` — a non-gating `continue-on-error` job running the real paired smoke + uploading screenshots/trace.

---

## Task 1: Add harness-readiness mock + registry fixture builders to the shared helper

**Files:**
- Modify: `client/test/dashboard/helpers/mock-daemon-api.ts`

- [ ] **Step 1: Add the two exported fixture builders**

Append these exports near the other `DEFAULT_*` exports (after `DEFAULT_SOLVERNETS_CATALOG`). They mirror the live `SolverNetManifestSummary`, `RegistryListResponse`, and `RegistryManifestResponse` shapes (`client/src/dashboard/spa/src/api/types.ts`):

```ts
/**
 * Build a registry-catalog summary row (the shape RegistryCatalog renders).
 * Mirrors `SolverNetManifestSummary`. Override any field per-test.
 */
export function makeRegistrySummary(
  overrides: Partial<{
    manifestCid: string;
    name: string;
    launcherAgentId: string;
    launcherSafeAddress: string;
    status: 'launched' | 'paused' | 'retired';
    solutionPriceWei: string;
    verdictPriceWei: string;
    openRoles: Array<'solver' | 'evaluator'>;
  }> = {},
) {
  return {
    manifestCid: 'bafkreiopalaunchedsolvernet0000000000000000000000000000',
    name: 'Prediction Markets',
    launcherAgentId: '5474',
    launcherSafeAddress: '0xE64bAf0073a71b0Cb2C0558bB16f24b45E1FB5CF',
    status: 'launched' as const,
    solutionPriceWei: '1000000000000000',
    verdictPriceWei: '500000000000000',
    openRoles: ['solver', 'evaluator'] as Array<'solver' | 'evaluator'>,
    ...overrides,
  };
}

/**
 * Build a `RegistryManifestResponse` for the per-CID GET the JoinFlow form
 * fetches (`GET /v1/solvernets/registry/:cid`). The manifest fields below are
 * the minimum JoinFlow reads (name, contract.evaluationFunction.implementation,
 * openRoles, prices).
 */
export function makeRegistryManifestResponse(
  overrides: Partial<{ manifestCid: string; name: string }> = {},
) {
  const manifestCid = overrides.manifestCid ?? 'bafkreiopalaunchedsolvernet0000000000000000000000000000';
  return {
    manifest: {
      schemaVersion: 'solvernet.manifest.v1' as const,
      solverNetId: 'agent5474_prediction.v1-1_aaaaaaaa',
      network: 'base-sepolia' as const,
      name: overrides.name ?? 'Prediction Markets',
      description: 'Forecast resolved outcomes; rewarded by Brier score.',
      launcher: {
        safeAddress: '0xE64bAf0073a71b0Cb2C0558bB16f24b45E1FB5CF',
        agentEoa: '0x1111111111111111111111111111111111111111',
        agentId: '5474',
      },
      contract: {
        id: 'prediction',
        version: 'v1',
        schemas: { task: {}, solution: {}, verdict: {} },
        claimPolicyDefaults: {
          mode: 'parallel' as const,
          maxClaims: 5,
          maxClaimsPerOperator: 1,
          claimLeaseTtlSeconds: 600,
        },
        credentialRequirements: { creator: [], solver: [], evaluator: [] },
        evaluationFunction: {
          id: 'predictionV1Eval',
          deterministic: true,
          inputs: ['solution.predictionPbool'],
          output: 'verdict.brierScore',
          implementation: 'jinn-builtin/prediction-v1-eval@1.0',
        },
        aggregationFunction: {
          id: 'predictionV1Agg',
          deterministic: true,
          inputs: ['verdict.brierScore'],
          output: 'aggregate.score',
        },
      },
      solutionPriceWei: '1000000000000000',
      verdictPriceWei: '500000000000000',
      openRoles: ['solver', 'evaluator'] as Array<'solver' | 'evaluator'>,
      createdAt: '2026-05-05T00:00:00Z',
      launchedAt: '2026-05-05T00:01:00Z',
    },
    lifecycle: {
      status: 'launched' as const,
      statusUpdatedAt: '2026-05-05T00:01:00Z',
      sourceBlock: 1,
    },
    manifestCid,
  };
}
```

- [ ] **Step 2: Add the harness-readiness route inside `mockDaemonApi`**

Insert this route in the `mockDaemonApi` body, immediately after the `// ---- Harness status ... ----` block (the `/api/harness/` route). It mirrors `HarnessReadinessEntry` (`{ harnessName, manifestCids, ready }`) — defaulting every harness to ready, the deterministic happy path:

```ts
  // ---- Per-harness readiness (#332) — probed by the JoinFlow form ----
  // GET /v1/harnesses/:name/readiness. Default every harness to ready so the
  // join form's Save & Join gate is open. Catalog/join tests that exercise the
  // not-ready path override this route per-test (registered after mockDaemonApi).
  await page.route(
    (url) => /^\/v1\/harnesses\/[^/]+\/readiness$/.test(url.pathname),
    (route) => {
      const name = decodeURIComponent(url(route.request().url()).pathname.split('/')[3] ?? '');
      return route.fulfill({
        contentType: 'application/json',
        body: JSON.stringify({ harnessName: name, manifestCids: [], ready: true }),
      });
    },
  );
```

Note: the route predicate receives a parsed `URL`; inside the handler use `route.request().url()` and re-parse with the global `URL` to recover the harness name. Replace the `url(...)` helper call with `new URL(route.request().url())`:

```ts
    (route) => {
      const name = decodeURIComponent(new URL(route.request().url()).pathname.split('/')[3] ?? '');
      return route.fulfill({
        contentType: 'application/json',
        body: JSON.stringify({ harnessName: name, manifestCids: [], ready: true }),
      });
    },
```

- [ ] **Step 3: Typecheck the helper**

Run: `cd client && yarn typecheck`
Expected: zero errors. (The helper is a `.ts` test file; the new exports must compile.)

- [ ] **Step 4: Commit**

```bash
git add client/test/dashboard/helpers/mock-daemon-api.ts
git commit -m "test(dashboard): add harness-readiness mock + registry fixture builders (#1014)"
```

---

## Task 2: Author the deterministic join journey test

**Files:**
- Create: `client/test/dashboard/join.e2e.test.ts`

This test reuses the daemon-spawn harness from `spa.e2e.test.ts` (real daemon serves the SPA + handshake; data calls are mocked). It is the discover→join→observe leg — the only real deterministic gap.

- [ ] **Step 1: Write the test file**

```ts
// client/test/dashboard/join.e2e.test.ts
//
// Deterministic op-b join journey (DR-2026-06-03, #1014). A real daemon serves
// the SPA bundle + auth handshake; every /v1/* data call is intercepted at the
// page.route() boundary. "op-b discovers op-a's launched SolverNet in the
// catalog → joins it → sees the success affordance." The cross-operator
// catalog is a FIXTURE (op-b's registry response contains op-a's manifest) —
// not a real cross-daemon round-trip, which is exactly the T2.3 flake source
// this replaces.
import { test, expect } from '@playwright/test';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  mockDaemonApi,
  makeRegistrySummary,
  makeRegistryManifestResponse,
} from './helpers/mock-daemon-api.js';

const PORT = 17334;
const OP_A_CID = 'bafkreiopalaunchedsolvernet0000000000000000000000000000';

let daemon: ChildProcess | null = null;
let homeDir = '';
let handshakeUrl: string | null = null;

test.beforeAll(async () => {
  homeDir = mkdtempSync(join(tmpdir(), 'jinn-join-e2e-'));
  const distBin = join(process.cwd(), 'dist', 'bin', 'jinn.js');
  if (!existsSync(distBin)) {
    throw new Error('dist/bin/jinn.js missing — run `yarn build` first');
  }
  daemon = spawn('node', [distBin, 'run', '--no-ui'], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      HOME: homeDir,
      JINN_PASSWORD: 'test-password',
      JINN_API_PORT: String(PORT),
      BASE_RPC_URL: 'http://127.0.0.1:65000',
      JINN_NETWORK: 'testnet',
      JINN_DISABLE_TESTNET_FAUCET: '1',
    },
    stdio: 'pipe',
  });
  const capture = (chunk: Buffer) => {
    const m = /UI handshake URL:\s+(\S+)/.exec(chunk.toString('utf-8'));
    if (m && !handshakeUrl) handshakeUrl = m[1];
  };
  daemon.stderr?.on('data', capture);
  daemon.stdout?.on('data', capture);

  for (let i = 0; i < 60; i++) {
    try {
      const res = await fetch(`http://127.0.0.1:${PORT}/v1/bootstrap`, {
        headers: { 'x-jinn-ui-token': 'unused-but-required' },
      });
      if (res.status === 200 || res.status === 401) break;
    } catch {
      // not yet
    }
    await new Promise((r) => setTimeout(r, 500));
  }
});

test.afterAll(async () => {
  if (daemon) {
    daemon.kill('SIGTERM');
    await new Promise((r) => setTimeout(r, 500));
  }
  if (homeDir) {
    try {
      rmSync(homeDir, { recursive: true, force: true });
    } catch {
      // best-effort
    }
  }
});

test('op-b discovers op-a\'s launched SolverNet in the catalog, joins it, and sees the success affordance', async ({ page }) => {
  test.setTimeout(60_000);

  // Base mocks: empty everywhere…
  await mockDaemonApi(page);

  // …then per-test overrides (registered AFTER mockDaemonApi so they win —
  // Playwright checks routes last-registered-first).
  //
  // 1. op-b's catalog contains op-a's launched SolverNet.
  await page.route(
    (url) => url.pathname === '/v1/solvernets/registry',
    (route) =>
      route.fulfill({
        contentType: 'application/json',
        body: JSON.stringify({
          summaries: [makeRegistrySummary({ manifestCid: OP_A_CID })],
          lastRefreshedAt: '2026-06-03T00:00:00Z',
          lastError: null,
        }),
      }),
  );
  // 2. the per-CID manifest the JoinFlow form fetches.
  await page.route(
    (url) => url.pathname === `/v1/solvernets/registry/${OP_A_CID}`,
    (route) =>
      route.fulfill({
        contentType: 'application/json',
        body: JSON.stringify(makeRegistryManifestResponse({ manifestCid: OP_A_CID })),
      }),
  );
  // 3. the join POST succeeds.
  await page.route(
    (url) => url.pathname === `/v1/operator/join/${OP_A_CID}`,
    (route) =>
      route.fulfill({
        contentType: 'application/json',
        body: JSON.stringify({
          ok: true,
          restartRequired: true,
          manifestCid: OP_A_CID,
          config: { manifestCid: OP_A_CID, name: 'Prediction Markets', roles: ['solver'] },
        }),
      }),
  );

  // Establish the auth cookie via the handshake URL, then drive to the catalog.
  if (!handshakeUrl) throw new Error('daemon did not print a UI handshake URL');
  await page.goto(handshakeUrl);
  const origin = new URL(page.url()).origin;
  await page.goto(`${origin}/operator`);

  // Discover: op-a's card is in the catalog.
  const card = page.getByTestId('registry-card').filter({ has: page.locator(`[data-manifest-cid="${OP_A_CID}"]`) });
  await expect(card.first()).toBeVisible({ timeout: 15_000 });

  // Click Join → routes to /operator/join/:cid.
  await page.getByTestId('registry-join-cta').first().click();
  await expect(page).toHaveURL(new RegExp(`/operator/join/${OP_A_CID}`));
  await expect(page.getByTestId('join-flow')).toBeVisible({ timeout: 15_000 });

  // Select the Solver role and confirm a harness is selected.
  await page.getByLabel('Solver').check();
  const harnessSelect = page.getByTestId('join-harness-select');
  await expect(harnessSelect).toBeVisible();
  await harnessSelect.selectOption('claude-code');

  // Submit the join.
  await page.getByTestId('join-flow-submit').click();

  // Observe: the explicit success affordance renders (only appears on a
  // resolved join — deterministic evidence the POST fired and succeeded).
  await expect(page.getByTestId('join-flow-success-card')).toBeVisible({ timeout: 15_000 });
  await expect(page.getByTestId('join-flow-success-restart')).toBeVisible();
});
```

- [ ] **Step 2: Build the dist bundle the test serves**

Run: `cd client && yarn build`
Expected: completes; `dist/bin/jinn.js` and `dist/dashboard/` exist.

- [ ] **Step 3: Run the test — iterate to green**

Run: `cd client && yarn playwright test --config=playwright.config.ts test/dashboard/join.e2e.test.ts`
Expected: PASS. If a selector or mock mismatches, the trace (`test-results/`) shows where the flow stalled — fix the mock/selector against the live SPA (`client/src/dashboard/spa/src/pages/operator-catalog/`) and re-run. Common fix points:
- `getByLabel('Solver')` must match the role checkbox label exactly (see `JoinFlow.tsx` `data-testid="join-role-option"`).
- If the harness select has no `claude-code` option, read the option values rendered (`join-harness-option`) and select the available solver harness.
- If a cost-confirmation gate appears, check `join-flow-cost-confirmation-checkbox` before submit.

- [ ] **Step 4: Commit**

```bash
git add client/test/dashboard/join.e2e.test.ts
git commit -m "test(dashboard): deterministic op-b join journey (#1014)"
```

---

## Task 3: Add the scoped `e2e:app-flow` script

**Files:**
- Modify: `client/package.json`

- [ ] **Step 1: Add the two scripts**

In the `scripts` block, next to `e2e:solvernet-flow` (around line 106), add:

```json
    "e2e:join": "yarn build && playwright test --config=playwright.config.ts test/dashboard/join.e2e.test.ts",
    "e2e:app-flow": "yarn build && playwright test --config=playwright.config.ts test/dashboard/solvernet-flow.e2e.test.ts test/dashboard/join.e2e.test.ts",
```

Note: `e2e:app-flow` is a deliberate **allowlist** of the two gating journeys — NOT `yarn e2e:dashboard`, which drags in the quarantined stale-failure tests (`spa`, `spa-config`, `HarnessSection`). `yarn build` runs once and both tests reuse the bundle.

- [ ] **Step 2: Run the bundle green locally**

Run: `cd client && yarn e2e:app-flow`
Expected: both `solvernet-flow.e2e.test.ts` and `join.e2e.test.ts` PASS. If `solvernet-flow` is already red on `next` for unrelated reasons, note it in the PR and scope `e2e:app-flow` to `join` only until `solvernet-flow` is repaired (separate from this issue).

- [ ] **Step 3: Commit**

```bash
git add client/package.json
git commit -m "test(dashboard): add scoped e2e:app-flow script (solvernet-flow + join) (#1014)"
```

---

## Task 4 `[after #960]`: Wire `e2e:app-flow` into the hermetic gate

**Files:**
- Modify: `.github/workflows/hermetic-gate.yml` (introduced by PR #960)

This task edits the file PR #960 adds. Do it once #960 is merged to `next` (or rebase this branch onto #960's branch).

- [ ] **Step 1: Add a Chromium-install step before the hermetic test step**

In the `hermetic-gate` job, immediately before the `run: yarn test:hermetic` step, add:

```yaml
      # App-flow determinism (#1014): the deterministic mocked-daemon Playwright
      # flow tests run in THIS gate per DR-2026-06-03 (deterministic → hermetic).
      # Chromium is the only browser playwright.config.ts targets.
      - name: Install Playwright Chromium for app-flow tests
        run: yarn playwright install --with-deps chromium
```

- [ ] **Step 2: Add the app-flow run step after `yarn test:hermetic`**

Immediately after the `run: yarn test:hermetic` step, add:

```yaml
      # Deterministic SPA journeys: create→launch (solvernet-flow) + discover→
      # join→observe (join). Mocked-daemon, no fork, no live daemon data path —
      # deterministic by construction, so it cannot reintroduce T2.3 flake.
      # Scoped allowlist (NOT yarn e2e:dashboard, which includes quarantined
      # stale tests).
      - name: App-flow determinism (Playwright, mocked daemon)
        run: yarn e2e:app-flow
      - if: failure()
        uses: actions/upload-artifact@v7
        with:
          name: app-flow-traces
          path: client/test-results/
          retention-days: 7
```

- [ ] **Step 3: Validate the workflow locally**

Run: `cd client && yarn e2e:app-flow` (the exact command the gate runs)
Expected: PASS. (CI YAML can't be unit-tested; the binding check is that the command the step invokes is green.)

- [ ] **Step 4: Commit**

```bash
git add .github/workflows/hermetic-gate.yml
git commit -m "ci(hermetic-gate): run deterministic app-flow Playwright tests (#1014)"
```

---

## Task 5 & 6 — SUPERSEDED (Mode 2 automated smoke dropped)

> **Superseded 2026-06-04 (see DR-2026-06-03 §Mode 2).** Tasks 5 and 6 (the
> automated `real-paired-smoke` test + the `environment-suite.yml` non-gating
> job) were built and validated on real testnet, then **dropped**: a real
> two-operator browser flow is irreducibly flaky, and a flaky non-gating test
> carries cost without trustworthy signal — the un-gateable shape #960 deleted
> T2.3 to escape. The real paired flow is now a **manual runbook** in the
> `testing-jinn-app` skill (`references/scenario-multi-op-spa-flow.md`). The
> task text below is retained for history only; do not implement it.

## Task 5 (historical): Author the non-gating real paired smoke

**Files:**
- Create: `client/test/dashboard/multi-op/real-paired-smoke.e2e.test.ts`

This drives two **real testnet** operator dashboards through create→launch→join. It is non-gating: it `test.skip()`s when the env URLs are absent, and in CI it runs in a `continue-on-error` job (Task 6). It reuses the wizard selectors from `solvernet-flow`/`launcher-create` and the catalog/join selectors from Task 2.

- [ ] **Step 1: Write the test file**

```ts
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
        await opB.goto(`${opBOrigin}/operator`);
        const card = opB.locator(`[data-testid="registry-card"] [data-manifest-cid="${manifestCid}"]`);
        if (await card.count()) found = true;
        else await opB.waitForTimeout(15_000);
      }
      expect(found, 'op-b should discover op-a\'s SolverNet in the catalog').toBe(true);

      await opB.getByTestId('registry-join-cta').first().click();
      await expect(opB.getByTestId('join-flow')).toBeVisible({ timeout: 30_000 });
      await opB.getByLabel('Solver').check();
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
```

- [ ] **Step 2: Verify it skips cleanly with no env**

Run: `cd client && yarn playwright test --config=playwright.config.ts test/dashboard/multi-op/real-paired-smoke.e2e.test.ts`
Expected: 1 skipped, 0 failed (env URLs absent locally).

- [ ] **Step 3: Typecheck**

Run: `cd client && yarn typecheck`
Expected: zero errors.

- [ ] **Step 4: Commit**

```bash
git add client/test/dashboard/multi-op/real-paired-smoke.e2e.test.ts
git commit -m "test(smoke): non-gating real paired app smoke (#1014)"
```

---

## Task 6 `[after #960]`: Wire the real paired smoke as a non-gating job

**Files:**
- Modify: `.github/workflows/environment-suite.yml` (introduced by PR #960)
- Modify: `client/package.json`

- [ ] **Step 1: Add a smoke script**

In `client/package.json` `scripts`, next to `e2e:app-flow`, add:

```json
    "e2e:real-paired-smoke": "yarn build && playwright test --config=playwright.config.ts test/dashboard/multi-op/real-paired-smoke.e2e.test.ts",
```

- [ ] **Step 2: Add the non-gating job to `environment-suite.yml`**

Add a new job at the end of `environment-suite.yml`'s `jobs:` map. It runs against the warm operators' real dashboards (URLs from the `testnet-gate` Environment), is `continue-on-error: true`, and uploads screenshots/trace. Its outcome never feeds the `environment-suite` check-run verdict.

```yaml
  real-paired-smoke:
    name: Real paired app smoke (non-gating)
    runs-on: ubuntu-latest
    # Non-gating: a flake or timeout here is a NEUTRAL signal, never a blocked
    # cut (DR-2026-06-03). The environment-suite check-run verdict is posted by
    # the gating jobs only; this job's conclusion is advisory.
    continue-on-error: true
    environment: testnet-gate
    steps:
      - uses: actions/checkout@v6
      - uses: actions/setup-node@v6
        with:
          node-version: 22
      - run: corepack enable
      - run: yarn install --immutable
        working-directory: client
      - run: yarn playwright install --with-deps chromium
        working-directory: client
      - name: Drive the real paired app smoke
        working-directory: client
        env:
          JINN_SMOKE_OP_A_URL: ${{ secrets.JINN_SMOKE_OP_A_URL }}
          JINN_SMOKE_OP_B_URL: ${{ secrets.JINN_SMOKE_OP_B_URL }}
        run: yarn e2e:real-paired-smoke
      - name: Upload smoke artifacts (screenshots + trace)
        if: always()
        uses: actions/upload-artifact@v7
        with:
          name: real-paired-smoke
          path: client/test-results/
          retention-days: 14
```

Note: add `JINN_SMOKE_OP_A_URL` and `JINN_SMOKE_OP_B_URL` to the protected `testnet-gate` Environment secrets (the two warm operators' dashboard URLs). When absent, the test self-skips (Task 5 Step 2) — the job stays green and uploads nothing.

- [ ] **Step 3: Commit**

```bash
git add .github/workflows/environment-suite.yml client/package.json
git commit -m "ci(environment-suite): non-gating real paired app smoke job (#1014)"
```

---

## Self-Review

**Spec coverage (DR-2026-06-03):**
- Mode 1 deterministic gating create→launch→join → `solvernet-flow` (existing) + `join.e2e` (Task 2), bundled by `e2e:app-flow` (Task 3), run in the hermetic gate (Task 4). ✓
- Mode 2 real paired flow → **dropped as an automated test; replaced by a manual runbook** (`testing-jinn-app/references/scenario-multi-op-spa-flow.md`). Tasks 5 & 6 superseded — see DR-2026-06-03 §Mode 2. ✓ (decision recorded, not an automated deliverable)
- No live-fork browser E2E in any blocking gate → join is fully mocked; the paired flow is manual, not automated. ✓
- Net-new join, extend nothing in `solvernet-flow` → Task 2 is net-new; `solvernet-flow` untouched. ✓
- Scoped allowlist, not `e2e:dashboard` → Task 3 note. ✓

**Type consistency:** `makeRegistrySummary`/`makeRegistryManifestResponse` (Task 1) are consumed by name in Task 2. The readiness shape `{ harnessName, manifestCids, ready }` matches `HarnessReadinessEntry`. `OP_A_CID` is shared between the summary fixture default and the per-test route overrides. The `manifest-cid` testid (op-a launched dashboard) and `registry-card`/`registry-join-cta`/`join-flow-*` testids are the live SPA selectors verified against source.

**Placeholder scan:** none — every step has concrete code/commands. The two `[after #960]` tasks edit files that exist only post-#960 by design (DR sequencing), with exact YAML given.

**Sequencing caveat:** Task 4 (hermetic-gate wiring) gated on PR #960 (now merged; shipped). Tasks 5 & 6 (the automated Mode 2 smoke) were dropped — the paired flow is a manual runbook, not a CI test.
