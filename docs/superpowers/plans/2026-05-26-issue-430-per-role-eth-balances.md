# Per-role ETH balances on /v1/status (Issue #430) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Expose per-role ETH balances (master / agent / Safe) on `/v1/status` and wire them into Overview → WalletCard `perRole`, replacing the hardcoded `'—'` placeholders.

**Architecture:** Add a `balances.eth` block to `StatusV1Response` next to (not replacing) `masterGas`. Assemble inside `assembleStatusV1` from data already in `GatheredStatusRaw` — `raw.master` (master ETH) and `raw.serviceBalances[displayIndex(primary)]` (agent + Safe ETH, populated by the existing `gatherServiceBalances` cache pass in `gather-status.ts`). No new RPC calls. SPA `OverviewStatusV1` is extended in lockstep and reads the three wei strings, formatting via the existing `formatEth`.

**Tech Stack:** TypeScript, Vitest + React Testing Library (SPA tests under `src/dashboard/spa`), Hono daemon API, viem (read-only — no new viem usage).

---

## Design-note verification (read before starting)

Confirmed against actual code:
- `GatheredStatusRaw.serviceBalances` exists at `client/src/api/status-build.ts:144` with shape `{ agentNativeWei, safeNativeWei, safeBondWei }` keyed by display index.
- `GatheredStatusRaw.master.balanceWei` exists at `status-build.ts:105-109` and is populated at `gather-status.ts:1159-1174`.
- `gatherServiceBalances` (gather-status.ts:853-972) populates the cache for every fleet service every `/v1/status` call (30 s SQLite TTL).
- Overview already uses "primary = `services[0]`" convention (Overview.tsx:264-270, 515) — the same one we use for the new block. The fleet array's first element has `displayFleetServiceIndex(svc) = svc.index - 1` (clamped at 0); for the standard single-service fleet (`svc.index = 1`) that's `0`.

**FLAG — scope clarification (does not block implementation):** the issue says "FundsCard.perRole drill-down" but the current `WalletCard` accepts `perRole` as a prop **and does not render it** (eslint-disabled, see `WalletCard.tsx:41-49` and the test's own comment "Per-role drill-down is commented out"). To stay inside the issue's narrow daemon-exposure framing, AC #3 is satisfied by asserting the wired values reach `WalletCard`'s `perRole` prop (data-path test). Surfacing the drill-down UI is out-of-scope and belongs in a follow-up Issue. If the reviewer disagrees, surfacing the rows is a one-block edit to `WalletCard.tsx`'s Gas section.

## Files touched

- Modify: `client/src/api/status-build.ts` — extend `StatusV1Response` with `balances.eth`; assemble in `assembleStatusV1`.
- Modify: `client/src/dashboard/spa/src/pages/Overview.tsx` — extend `OverviewStatusV1`; wire `balances` into `perRole`.
- Modify: `client/test/api/status-build.test.ts` — new test for the `balances.eth` block.
- Modify: `client/src/dashboard/spa/src/pages/overview/WalletCard.test.tsx` — new Overview-level test asserting `perRole` values reach `WalletCard`. (Test goes in a new sibling file so we don't pull React-Query / wouter into Overview-rendering territory inside the WalletCard unit-test file — see Task 5 for the exact location.)
- Create: `client/src/dashboard/spa/src/pages/Overview.balances.test.tsx` — new file (see Task 5).

---

## Task 1: Extend `StatusV1Response` with `balances.eth` (type only)

**Files:**
- Modify: `client/src/api/status-build.ts:168-233`

- [ ] **Step 1: Add the new interface and `balances` field to `StatusV1Response`**

Insert before `masterGas` in the interface (around line 211 — directly after `tJinn: TjinnStatus;`):

```ts
/** Per-role ETH balance (master / agent / Safe). Wei strings, base-10. */
balances: {
  eth: {
    master: { address: string | null; balanceWei: string | null; error?: string };
    agent:  { address: string | null; balanceWei: string | null; error?: string };
    safe:   { address: string | null; balanceWei: string | null; error?: string };
  };
};
```

- [ ] **Step 2: Run typecheck — expect failure**

Run: `yarn typecheck` (from `client/`)
Expected: FAIL — `assembleStatusV1` no longer satisfies `StatusV1Response` (missing `balances`).

- [ ] **Step 3: Commit**

```bash
git add client/src/api/status-build.ts
git commit -m "feat(#430): add balances.eth shape to StatusV1Response (typecheck-failing)"
```

## Task 2: Write the failing status-build assembly test

**Files:**
- Modify: `client/test/api/status-build.test.ts`

- [ ] **Step 1: Add a new test inside the `describe('assembleStatusV1', …)` block**

Insert before the closing `});` of the describe block:

```ts
it('exposes per-role ETH balances from serviceBalances + master', () => {
  const raw: GatheredStatusRaw = {
    ...tjinnIdentityFields,
    shutdownState: 'running',
    dbPath: '/tmp/x.db',
    activityCounts: {},
    recentActivity: [],
    lastRewardClaimTickAt: null,
    rewardClaimIntervalMs: 0,
    fleet: minimalFleet(),
    rpc: { ok: true, chainId: 8453, blockNumber: '1' },
    master: {
      address: '0x1111111111111111111111111111111111111111',
      balanceWei: '7000000000000000',
    },
    pollIntervalMs: 5000,
    masterDailyEstimateWei: '1',
    // minimalFleet has services[0].index === 1, so displayFleetServiceIndex === 0.
    serviceBalances: {
      0: {
        agentNativeWei: '2500000000000000',
        safeNativeWei: '4000000000000000',
        safeBondWei: '0',
      },
    },
  };
  const j = assembleStatusV1(raw);
  expect(j.balances.eth.master).toEqual({
    address: '0x1111111111111111111111111111111111111111',
    balanceWei: '7000000000000000',
  });
  expect(j.balances.eth.agent).toEqual({
    address: '0x2222222222222222222222222222222222222222',
    balanceWei: '2500000000000000',
  });
  expect(j.balances.eth.safe).toEqual({
    address: '0x3333333333333333333333333333333333333333',
    balanceWei: '4000000000000000',
  });
});

it('returns null balances for roles whose address or row is missing', () => {
  const raw: GatheredStatusRaw = {
    ...tjinnIdentityFields,
    shutdownState: 'running',
    dbPath: '/tmp/x.db',
    activityCounts: {},
    recentActivity: [],
    lastRewardClaimTickAt: null,
    rewardClaimIntervalMs: 0,
    fleet: null,
    rpc: { ok: true, chainId: 8453, blockNumber: '1' },
    master: { address: null },
    pollIntervalMs: 5000,
    masterDailyEstimateWei: '1',
  };
  const j = assembleStatusV1(raw);
  expect(j.balances.eth.master).toEqual({ address: null, balanceWei: null });
  expect(j.balances.eth.agent).toEqual({ address: null, balanceWei: null });
  expect(j.balances.eth.safe).toEqual({ address: null, balanceWei: null });
});

it('propagates the master read error onto balances.eth.master', () => {
  const raw: GatheredStatusRaw = {
    ...tjinnIdentityFields,
    shutdownState: 'running',
    dbPath: '/tmp/x.db',
    activityCounts: {},
    recentActivity: [],
    lastRewardClaimTickAt: null,
    rewardClaimIntervalMs: 0,
    fleet: minimalFleet(),
    rpc: { ok: true, chainId: 8453, blockNumber: '1' },
    master: {
      address: '0x1111111111111111111111111111111111111111',
      error: 'rpc timeout',
    },
    pollIntervalMs: 5000,
    masterDailyEstimateWei: '1',
    serviceBalanceErrors: { 0: { agent: 'agent rpc fail' } },
    serviceBalances: { 0: { agentNativeWei: '0', safeNativeWei: '0', safeBondWei: '0' } },
  };
  const j = assembleStatusV1(raw);
  expect(j.balances.eth.master.error).toBe('rpc timeout');
  expect(j.balances.eth.master.balanceWei).toBeNull();
  expect(j.balances.eth.agent.error).toBe('agent rpc fail');
});
```

- [ ] **Step 2: Run the new tests — expect failure**

Run: `yarn test test/api/status-build.test.ts -t "per-role ETH balances"` (from `client/`)
Expected: FAIL — `j.balances` is `undefined` (assembler doesn't build it yet).

- [ ] **Step 3: Commit**

```bash
git add client/test/api/status-build.test.ts
git commit -m "test(#430): assert balances.eth shape on /v1/status"
```

## Task 3: Implement `balances.eth` assembly in `assembleStatusV1`

**Files:**
- Modify: `client/src/api/status-build.ts` — `assembleStatusV1`, around lines 462-526.

- [ ] **Step 1: Add the assembly helper above `assembleStatusV1`**

Insert above `export function assembleStatusV1` (around line 462):

```ts
function buildEthBalances(raw: GatheredStatusRaw): StatusV1Response['balances']['eth'] {
  const primaryService = raw.fleet?.services?.[0];
  const primaryDisplayIndex =
    primaryService !== undefined
      ? Math.max(0, primaryService.index - 1) // mirrors displayFleetServiceIndex
      : null;
  const row =
    primaryDisplayIndex !== null
      ? raw.serviceBalances?.[primaryDisplayIndex]
      : undefined;
  const rowErr =
    primaryDisplayIndex !== null
      ? raw.serviceBalanceErrors?.[primaryDisplayIndex]
      : undefined;

  const master: StatusV1Response['balances']['eth']['master'] = {
    address: raw.master.address,
    balanceWei: raw.master.balanceWei ?? null,
    ...(raw.master.error !== undefined ? { error: raw.master.error } : {}),
  };
  const agent: StatusV1Response['balances']['eth']['agent'] = {
    address: primaryService?.agent_address ?? null,
    balanceWei: row?.agentNativeWei ?? null,
    ...(rowErr?.agent !== undefined ? { error: rowErr.agent } : {}),
  };
  const safe: StatusV1Response['balances']['eth']['safe'] = {
    address: primaryService?.safe_address ?? null,
    balanceWei: row?.safeNativeWei ?? null,
    ...(rowErr?.multisig !== undefined ? { error: rowErr.multisig } : {}),
  };
  return { master, agent, safe };
}
```

- [ ] **Step 2: Wire it into the return object**

Inside `assembleStatusV1` (around line 483, the `return { … }`), add a `balances` property — place it directly after `tJinn: publicTjinnStatus(...)`:

```ts
balances: { eth: buildEthBalances(raw) },
```

- [ ] **Step 3: Run the new tests — expect pass**

Run: `yarn test test/api/status-build.test.ts -t "per-role ETH balances"` (from `client/`)
Expected: PASS on all three new tests.

- [ ] **Step 4: Run full status-build test file — expect pass**

Run: `yarn test test/api/status-build.test.ts` (from `client/`)
Expected: ALL PASS (existing tests unaffected — `masterGas` retained).

- [ ] **Step 5: Run typecheck — expect pass**

Run: `yarn typecheck` (from `client/`)
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add client/src/api/status-build.ts
git commit -m "feat(#430): assemble balances.eth from serviceBalances + master"
```

## Task 4: Extend `OverviewStatusV1` and wire `perRole`

**Files:**
- Modify: `client/src/dashboard/spa/src/pages/Overview.tsx:67-154` (type) and `497-545` (WalletCard call).

- [ ] **Step 1: Add `balances` to `OverviewStatusV1`**

Inside `interface OverviewStatusV1 { … }`, alongside `masterGas`, add:

```ts
/**
 * Per-role ETH balances (master / agent / Safe) exposed on /v1/status (#430).
 * Optional: older daemons predate this field.
 */
balances?: {
  eth?: {
    master?: { balanceWei?: string | null };
    agent?: { balanceWei?: string | null };
    safe?: { balanceWei?: string | null };
  };
};
```

- [ ] **Step 2: Derive the three formatted strings**

Add directly after `const gasBalanceEth = formatEth(status?.masterGas?.balanceWei);` (around line 296):

```ts
// Per-role ETH balances (#430). formatEth() already returns '—' for missing/null input,
// so each role degrades cleanly when the daemon predates this field or a row is unresolved.
const perRoleMasterEth = formatEth(status?.balances?.eth?.master?.balanceWei ?? undefined);
const perRoleAgentEth  = formatEth(status?.balances?.eth?.agent?.balanceWei ?? undefined);
const perRoleSafeEth   = formatEth(status?.balances?.eth?.safe?.balanceWei ?? undefined);
```

- [ ] **Step 3: Replace the hardcoded `'—'` in the `WalletCard` `perRole` prop**

Edit lines ~501-508 — change the literal block to read the three derived values:

```tsx
perRole={{
  master: perRoleMasterEth,
  agent: perRoleAgentEth,
  safe: perRoleSafeEth,
}}
```

Delete the inline comment about "Only masterGas is currently exposed by /v1/status" — it no longer describes the code.

- [ ] **Step 4: Run SPA typecheck — expect pass**

Run: `yarn workspace @jinn-network/operator-spa build` (from `client/`) OR `yarn build:spa` if the alias exists. Quick alternative: `yarn typecheck` from `client/` covers daemon-side; SPA typecheck runs in `yarn build:spa` (`tsc -b && vite build`).
Expected: PASS — `OverviewStatusV1.balances` aligns with the daemon shape.

- [ ] **Step 5: Commit**

```bash
git add client/src/dashboard/spa/src/pages/Overview.tsx
git commit -m "feat(#430): wire real per-role ETH balances into WalletCard.perRole"
```

## Task 5: Add Overview-level test asserting `perRole` wiring

**Files:**
- Create: `client/src/dashboard/spa/src/pages/Overview.balances.test.tsx`

- [ ] **Step 1: Write the failing test**

```tsx
import { describe, expect, it, vi } from 'vitest';
import { render } from '@testing-library/react';
import { Router } from 'wouter';
import { memoryLocation } from 'wouter/memory-location';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { OverviewPage } from './Overview.js';

// Mock the data layer — Overview reads three useQuery sources; only `getStatus`
// carries the balances. Bootstrap / catalog return the minimum shape Overview
// destructures so the component renders without throwing.
const getStatusMock = vi.fn();
vi.mock('../api/client.js', () => ({
  api: {
    getStatus: () => getStatusMock(),
    getBootstrap: () => Promise.resolve({}),
    getSolverNets: () => Promise.resolve({ nets: [] }),
    restake: vi.fn(),
    triggerDrip: vi.fn(),
    stopDaemon: vi.fn(),
    restartDaemon: vi.fn(),
    retryAgentBinding: vi.fn(),
  },
}));

function renderOverview(): void {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const { hook } = memoryLocation({ path: '/overview' });
  render(
    <QueryClientProvider client={qc}>
      <Router hook={hook}>
        <OverviewPage />
      </Router>
    </QueryClientProvider>,
  );
}

describe('Overview — per-role ETH wiring (#430)', () => {
  it('formats master / agent / Safe wei into the WalletCard gas total when balances.eth is present', async () => {
    getStatusMock.mockResolvedValue({
      fleet: { services: [{ index: 0, step: 'complete', serviceId: 42, safeAddress: '0xSafe' }] },
      masterGas: { balanceWei: '7000000000000000' },
      balances: {
        eth: {
          master: { balanceWei: '7000000000000000' }, // 0.0070
          agent:  { balanceWei: '2500000000000000' }, // 0.0025
          safe:   { balanceWei: '4000000000000000' }, // 0.0040
        },
      },
    });
    renderOverview();
    // Resolve the suspended query.
    await new Promise((r) => setTimeout(r, 0));
    // WalletCard renders `totalEth` (master) prominently; the three perRole
    // values are passed as props. Asserting on the gas section text covers
    // the master row; the agent/Safe assertions confirm the wei→ETH derivation
    // happens for *each* role even though the WalletCard drill-down UI is
    // currently hidden (see WalletCard.tsx:41-49). When the drill-down is
    // restored, this test will already pin the formatted strings.
    const card = document.querySelector('[data-testid="wallet-card"]');
    expect(card?.textContent).toContain('0.0070');
    // The Overview-derived perRole strings — read via a hidden assertion hook.
    // We don't read DOM here for agent/Safe because the rows aren't rendered;
    // instead, the next test (Task 5 Step 2) covers the prop path directly.
  });
});
```

- [ ] **Step 2: Add a focused prop-path assertion**

Append a second test inside the same `describe` (still in `Overview.balances.test.tsx`). This test spies on `WalletCard` via `vi.mock` and asserts the `perRole` it receives:

```tsx
// Re-mock WalletCard to capture props. Place this near the top of the file,
// alongside the api mock. (Move both mocks up if test runs out of order.)
vi.mock('./overview/WalletCard.js', () => ({
  WalletCard: (props: { perRole?: { master: string; agent: string; safe: string } }) => (
    <div data-testid="wallet-card-mock">{JSON.stringify(props.perRole)}</div>
  ),
}));

it('passes the formatted per-role strings into WalletCard.perRole', async () => {
  getStatusMock.mockResolvedValue({
    fleet: { services: [{ index: 0, step: 'complete', serviceId: 42, safeAddress: '0xSafe' }] },
    masterGas: { balanceWei: '7000000000000000' },
    balances: {
      eth: {
        master: { balanceWei: '7000000000000000' },
        agent:  { balanceWei: '2500000000000000' },
        safe:   { balanceWei: '4000000000000000' },
      },
    },
  });
  renderOverview();
  await new Promise((r) => setTimeout(r, 0));
  const captured = document.querySelector('[data-testid="wallet-card-mock"]')?.textContent ?? '';
  expect(captured).toContain('"master":"0.0070"');
  expect(captured).toContain('"agent":"0.0025"');
  expect(captured).toContain('"safe":"0.0040"');
});

it('falls back to "—" for each role when /v1/status omits balances.eth', async () => {
  getStatusMock.mockResolvedValue({
    fleet: { services: [] },
    masterGas: {},
  });
  renderOverview();
  await new Promise((r) => setTimeout(r, 0));
  const captured = document.querySelector('[data-testid="wallet-card-mock"]')?.textContent ?? '';
  expect(captured).toContain('"master":"—"');
  expect(captured).toContain('"agent":"—"');
  expect(captured).toContain('"safe":"—"');
});
```

(Move the `vi.mock('./overview/WalletCard.js', …)` block to the top of the file alongside the api mock — both `vi.mock` calls are hoisted, so order doesn't matter at runtime, but the canonical convention is mocks-at-top.)

- [ ] **Step 3: Run the new tests — expect pass**

Run: `yarn test src/dashboard/spa/src/pages/Overview.balances.test.tsx` (from `client/`)
Expected: PASS on all three new tests.

- [ ] **Step 4: Run the full WalletCard test (no regression)**

Run: `yarn test src/dashboard/spa/src/pages/overview/WalletCard.test.tsx` (from `client/`)
Expected: PASS — `WalletCard` itself wasn't changed; the existing `defaultProps()` `perRole: { master: '0.0088', agent: '—', safe: '—' }` continues to satisfy its unit tests.

- [ ] **Step 5: Commit**

```bash
git add client/src/dashboard/spa/src/pages/Overview.balances.test.tsx
git commit -m "test(#430): assert real per-role ETH strings reach WalletCard.perRole"
```

## Task 6: Full verification + commit lock

- [ ] **Step 1: Full typecheck**

Run: `yarn typecheck` (from `client/`)
Expected: PASS.

- [ ] **Step 2: Full vitest**

Run: `yarn test` (from `client/`)
Expected: PASS — all tests including the three new status-build tests and three new Overview-balances tests.

- [ ] **Step 3: SPA bundle build (catches type/JSX issues vitest can miss)**

Run: `yarn workspace @jinn-network/operator-spa build` (from `client/`)
Expected: PASS — `tsc -b && vite build` clean.

- [ ] **Step 4: No additional commit needed (only verification).**

---

## Acceptance-criterion mapping

| AC | Task(s) |
|---|---|
| **1. `/v1/status` includes per-role ETH (master/agent/Safe) as wei strings.** | Task 1 (type), Task 2 (failing test), Task 3 (implementation), Task 6 Step 2 (verify). |
| **2. `OverviewStatusV1` extended; `Overview.tsx` passes real balances into `FundsCard.perRole` instead of `'—'`.** | Task 4 (extend type + replace literals), Task 5 Step 2 (assert wired prop). |
| **3. `/v1/status` fixture updated; per-role assertions exercise the wired values.** | Task 2 (`status-build.test.ts` fixture + assertions for the new block) AND Task 5 (Overview-level test capturing the three formatted strings on `perRole`). The original `WalletCard.test.tsx` per-role assertion in `defaultProps()` is intentionally left alone because the drill-down UI is still hidden — see the design-note FLAG above. |

---

## Verification

Run these from the `client/` directory:

```bash
yarn typecheck                                                # daemon-side TS, includes status-build.ts
yarn test test/api/status-build.test.ts                       # new balances.eth tests
yarn test src/dashboard/spa/src/pages/Overview.balances.test.tsx   # new Overview wiring tests
yarn test src/dashboard/spa/src/pages/overview/WalletCard.test.tsx # regression: WalletCard unit unchanged
yarn test                                                     # full vitest run (pyramid)
yarn workspace @jinn-network/operator-spa build               # SPA tsc -b + vite build (catches SPA-only type drift)
```

All commands must exit 0. If `yarn workspace …` aliasing trips, fall back to `(cd src/dashboard/spa && yarn build)`.
