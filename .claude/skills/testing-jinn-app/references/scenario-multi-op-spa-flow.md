# Scenario T2.3 — Multi-op SPA flow

**Tier:** 2 (substrate-derived workspace, Anvil-fork, runs in release-prep)
**Wall-clock budget:** 5 minutes
**Catches:** cross-op UI flows that pass with mocks but break with real daemons; SPA-side state synchronization; Launcher → Operator catalog visibility.

> **Prerequisite: Plan A's `substrate-copy.ts`.** This scenario imports
> `copyWorkspace` from `client/scripts/release/substrate-copy.ts`, a Plan A
> artifact. It does not exist on the Plan B branch — this scenario is not
> runnable until Plan A lands.

## Goal

op-a launches a SolverNet via the SPA Launcher Create wizard. op-b sees it appear in the Operator catalog. op-b joins via the SPA. op-a's launched-SolverNet dashboard shows op-b's join.

This catches a class of bug invisible to single-op tests and to mocked multi-op tests: real-daemon state propagation through the SPA.

## Implementation location

`client/test/dashboard/multi-op/launcher-join-flow.e2e.test.ts`

## Setup

- substrate workspace via `copyWorkspace({ ops: ['op-a', 'op-b'] })`
- both daemons spawned via `spawnMultiOpDaemons` against Anvil-fork RPC
- Playwright with two contexts (one per operator) — see [multi-op-playwright.md](multi-op-playwright.md)

## Steps

```typescript
import { test, expect } from '@playwright/test';
import { baseSepolia } from 'viem/chains';
import { spawnMultiOpDaemons } from '../../helpers/multi-op-daemon';
import { copyWorkspace } from '../../../scripts/release/substrate-copy';
import { spawnAnvilFork } from '../../_support/chain/anvil';

let workspace, daemons, anvil, opAUrl, opBUrl;

test.beforeAll(async () => {
  workspace = await copyWorkspace({ ops: ['op-a', 'op-b'] });
  anvil = await spawnAnvilFork({
    forkUrl: process.env['BASE_SEPOLIA_RPC_URL']!,
    chain: baseSepolia,
    silent: true,
  });
  daemons = await spawnMultiOpDaemons({
    ops: [
      { name: 'op-a', home: workspace.opPaths['op-a'], apiPort: 7732 },
      { name: 'op-b', home: workspace.opPaths['op-b'], apiPort: 7733 },
    ],
    // JINN_RPC_URL — config.ts gives it unconditional precedence over BASE_RPC_URL.
    extraEnv: { JINN_RPC_URL: anvil.rpcUrl },
  });
  opAUrl = daemons.daemons['op-a'].handshakeUrl ?? `http://127.0.0.1:7732/`;
  opBUrl = daemons.daemons['op-b'].handshakeUrl ?? `http://127.0.0.1:7733/`;
});

test.afterAll(async () => {
  await daemons?.teardown();
  await anvil?.teardown();
  await workspace?.teardown();
});

test('op-a launches → op-b sees → op-b joins → op-a sees join', async ({ browser }) => {
  const opACtx = await browser.newContext();
  const opBCtx = await browser.newContext();
  const opAPage = await opACtx.newPage();
  const opBPage = await opBCtx.newPage();

  // === op-a: Launcher Create wizard ===
  await opAPage.goto(opAUrl);
  await opAPage.getByRole('link', { name: /launcher/i }).click();
  await opAPage.getByRole('button', { name: /create solvernet/i }).click();

  // Step 1: Define
  const solverNetName = `t23-test-${Date.now()}`;
  await opAPage.getByLabel(/name/i).fill(solverNetName);
  await opAPage.getByLabel(/description/i).fill('T2.3 e2e test SolverNet');
  await opAPage.getByRole('button', { name: /next/i }).click();

  // Step 2: Review Contract
  await opAPage.getByRole('button', { name: /next/i }).click();

  // Step 3: Configure Generator
  await opAPage.getByLabel(/cadence/i).fill('60000');   // 60s
  await opAPage.getByRole('button', { name: /next/i }).click();

  // Step 4: Configure Pricing
  await opAPage.getByLabel(/price/i).fill('100');
  await opAPage.getByRole('button', { name: /next/i }).click();

  // Step 5: Review and Launch
  await opAPage.getByRole('button', { name: /launch/i }).click();

  // Wait for launch state machine to reach 'launched'
  await expect(opAPage.getByText(/launched/i)).toBeVisible({ timeout: 120000 });
  const manifestCid = await opAPage.getByTestId('manifest-cid').textContent();
  expect(manifestCid).toMatch(/^bafkrei/);

  // === op-b: Operator catalog sees op-a's SolverNet ===
  await opBPage.goto(opBUrl);
  await opBPage.getByRole('link', { name: /operator/i }).click();
  await opBPage.getByRole('button', { name: /browse catalog/i }).click();
  await expect(opBPage.getByText(solverNetName)).toBeVisible({ timeout: 30000 });

  // === op-b joins via SPA ===
  await opBPage.getByText(solverNetName).click();
  await opBPage.getByRole('button', { name: /join/i }).click();
  // Restart banner should appear (operator.join writes config; daemon doesn't hot-reload SolverNet config)
  await expect(opBPage.getByText(/restart required/i)).toBeVisible({ timeout: 10000 });

  // === op-a's launched dashboard reflects op-b's join ===
  await opAPage.goto(opAUrl + '/launcher/launched');
  await opAPage.getByText(solverNetName).click();
  // Operator join is on-chain; SPA should poll and reflect within 30s
  await expect(opAPage.getByText(/1 operator joined/i)).toBeVisible({ timeout: 30000 });

  await opACtx.close();
  await opBCtx.close();
});
```

## Assertions (summary)

| # | Assertion | Why |
|---|---|---|
| A1 | op-a wizard launch reaches `launched` state within 120s | Launcher state machine end-to-end |
| A2 | manifest CID matches `bafkrei...` shape | pinning + on-chain registry write succeeded |
| A3 | op-b's catalog shows the new SolverNet within 30s | global registry indexing works |
| A4 | op-b's join writes operator-side config | operator.join RPC + restart banner |
| A5 | op-a's launched dashboard shows "1 operator joined" within 30s | cross-op SPA polling correctness |

## Failure modes

| Failure | Class | Triage |
|---|---|---|
| Wizard step doesn't advance | real-bug | BLOCKING — wizard UI regression |
| Launch state machine times out before `launched` | could be: pinning hang, broadcast fail, indexer fail | inspect launch-progress record; flake on first |
| op-b's catalog doesn't show within 30s | indexer slow OR catalog query broken | check Discovery API directly; if working, SPA-side bug |
| op-b's join doesn't write config | real-bug | BLOCKING — operator.join broken |
| Restart banner missing | real-bug | BLOCKING — restart semantics regression |
| op-a's "1 operator joined" never appears | could be: on-chain operator-join missed, indexer lag, SPA polling broken | check on-chain first, then indexer, then SPA |

## Wall-clock

~5 minutes:
- 30s daemon spawn + Anvil fork
- 120s op-a launch
- 30s op-b catalog lookup
- 60s op-b join + restart banner
- 30s op-a sees join
- 30s setup/teardown

## Dependencies

- Substrate workspace from Plan A
- `spawnAnvilFork` helper at `client/test/_support/chain/anvil.ts` (pass `forkUrl: BASE_SEPOLIA_RPC_URL` + `chain: baseSepolia` for a Base Sepolia fork)
- The SPA Launcher Create wizard's data-testid attributes (`manifest-cid` etc.) — may need to be added to the SPA in Plan C/D if missing
- The Operator catalog page at `/operator/...` (existing in v0.1.6)
- The launched-SolverNet dashboard at `/launcher/launched/:id` (existing in v0.1.6)

## What this scenario does NOT catch

- UX paper cuts (Tier 3 manual walkthrough covers these)
- Real-network economics
- Visual regressions
- Operator's actual claim/solve flow (T2.2 covers that)
