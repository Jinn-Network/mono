# Gas Runway Warnings (issue #1296) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Surface a dashboard warning when an operator wallet's native ETH runway is low (per chain — Base Sepolia L2 *and* Ethereum Sepolia L1), a distinct higher-severity warning when the balance can no longer cover the next tx, and clear both without a page reload on top-up.

**Architecture:** The daemon already computes per-master L2 gas runway in `client/src/api/status-build.ts` (`masterGas.{balanceWei, dailyEstimateWei, runwayDaysExcess, minEthWei}`). The signal is currently discarded by a proxy in the SPA notification adapter (`mapStatusToDeriveInput`), so `funding_low` only fires at exactly zero balance. We (1) fix the adapter to consume the real runway, (2) add a higher-severity `funding_empty` notification, (3) extend the daemon to also gather the L1 master ETH balance and emit a parallel `l1MasterGas` block, and (4) make the notification deriver chain-generic so each warning names `<wallet> on <chain>`. AC#3 (clear-on-topup) is free — notifications derive from `/v1/status` on the existing 5s poll.

**Tech Stack:** TypeScript, viem (L1/L2 public clients), React + @tanstack/react-query (SPA), shadcn/ui, Vitest (both daemon-side `client/test/**` and SPA `client/src/dashboard/spa/src/**/*.test.ts(x)`).

## Global Constraints

- **No new config keys.** Thresholds stay env-overridable via existing keys only: L2 daily estimate `JINN_MASTER_ETH_DAILY_WEI` → `StatusGatherConfig.masterEthDailyEstimateWei`; L1 reuses the same machinery with L1-appropriate defaults sourced through the existing env. (CLAUDE.md Config table; issue #1296 "no new config keys".)
- **Thresholds (keep shipped defaults):** `funding_low` (severity `warning`) at `runwayDaysExcess < 3` days; `funding_empty` (severity `blocking`) at `balanceWei < minEthWei`. The `< 3` threshold is already `RUNWAY_LOW_THRESHOLD_DAYS` in `client/src/dashboard/spa/src/notifications/derive.ts:23`.
- **No new shadcn primitives.** `NotificationItem`/`NotificationsList` already render all three severities (`blocking`/`warning`/`info`) using `--severity-blocking-fg` / `--severity-warning-fg` tokens that already exist in `client/src/dashboard/spa/src/styles/globals.css:83-88`. The WalletCard "Nd runway" line reuses those same tokens.
- **Human-surface rule:** the spec update (`client/OPERATOR-APP-SPEC.md` §2.3 + §2.10) MUST land in this PR.
- **Visual parity:** the implementation must match the Claude Design artifact (`Gas Runway Warnings.html`, project `019e2715-c4bc-7eae-af28-e178b95e5156`), imported via the `claude_design` MCP during implementation.
- **TDD for this `fix`:** regression test first (assert the broken behaviour fails), then the fix. Per CLAUDE.md handbook `fix` shape.
- **Test commands:** `cd client && yarn typecheck && yarn test`. The SPA tests run under the same `yarn test` (Vitest picks up `client/src/dashboard/spa/src/**/*.test.ts(x)`); no separate SPA test command. Run the focused file with `yarn test <path>` for fast loops.

## File Structure

| File | Responsibility | Change |
|------|----------------|--------|
| `client/src/dashboard/spa/src/notifications/derive.ts` | Pure notification deriver. Add chain-generic `funds` shape + `funding_empty` branch. | Modify |
| `client/src/dashboard/spa/src/notifications/taxonomy.ts` | Canonical notification kinds. Add `funding_empty`. | Modify (`:3-14`) |
| `client/src/dashboard/spa/src/notifications/useNotifications.ts` | Adapter `mapStatusToDeriveInput`: replace the runway proxy with real `masterGas`/`l1MasterGas` mapping. | Modify (`:57-119`) |
| `client/src/api/status-build.ts` | `StatusV1Response` types + `assembleStatusV1`. Add `l1MasterGas` block + `GatheredStatusRaw.l1Master` / `minL1MasterEthWei` / `l1MasterDailyEstimateWei`. | Modify |
| `client/src/api/gather-status.ts` | Fetch L1 master native balance via `createJinnL1PublicClient`; populate the new raw fields. | Modify |
| `client/src/dashboard/spa/src/pages/Overview.tsx` | Local `StatusV1`-ish type (`:76-79`) + WalletCard prop wiring (`:255-256`, `:449-451`). Add `l1MasterGas` type + severity to runway line. | Modify |
| `client/src/dashboard/spa/src/pages/overview/WalletCard.tsx` | Severity-tinted "Nd runway" text/border. | Modify |
| `client/OPERATOR-APP-SPEC.md` | §2.3 state messages + §2.10 taxonomy. | Modify |
| Tests (co-located / `client/test/`) | see each task | Modify/Create |

---

### Task 1: Fix the runway-proxy bug in the deriver (L2 low-runway warning)

This is the core regression. The deriver's `funds.runwayDays` is currently fed a proxy (`Infinity` if balance > 0, else 0) by the adapter, so a low-but-nonzero runway never fires `funding_low`. We first prove the deriver already handles a real low value correctly (it does — `derive.ts:39`), then prove the *adapter* discards it (Task 2). This task adds the regression test that locks the deriver contract for the new `funding_empty` case and the chain-generic message.

**Files:**
- Modify: `client/src/dashboard/spa/src/notifications/derive.ts`
- Modify: `client/src/dashboard/spa/src/notifications/taxonomy.ts:3-14`
- Test: `client/src/dashboard/spa/src/notifications/derive.test.ts`

**Interfaces:**
- Consumes: nothing new.
- Produces: a new `DeriveInput['status']['funds']` shape:
  ```ts
  funds: {
    eth: string;            // rolled-up display total (unchanged)
    chains: Array<{
      chain: string;        // human label, e.g. "Base Sepolia" | "Ethereum Sepolia"
      wallet: string | null;// master wallet address for this chain, or null
      runwayDays: number;   // POSITIVE_INFINITY when not computable
      empty: boolean;       // balanceWei < minEthWei
    }>;
  }
  ```
  `deriveNotifications` emits one `funding_low` (warning) per chain with `runwayDays < 3` and one `funding_empty` (blocking) per chain with `empty === true`. `funding_empty` for a chain suppresses the same chain's `funding_low` (empty is the stronger, more specific signal). Message format: ``Runway is N day(s) on <chain>. Top up gas (<wallet>) to keep claiming work.`` and ``<chain> wallet (<wallet>) can no longer cover the next transaction. Top up now.``

- [ ] **Step 1: Add `funding_empty` to the canonical taxonomy**

In `client/src/dashboard/spa/src/notifications/taxonomy.ts`, add `'funding_empty'` to `CANONICAL_KINDS` immediately after `'funding_low'`:

```ts
export const CANONICAL_KINDS = [
  'funding_low',
  'funding_empty',
  'password_rotation_due',
  'harness_not_ready',
  'bootstrap_blocked',
  'restart_required',
  'update_available',
  'rpc_unreachable',
  'no_solvernets_joined',
  'safe_binding_pending',
  'claim_failed',
] as const;
```

- [ ] **Step 2: Write the failing deriver test**

Append to `client/src/dashboard/spa/src/notifications/derive.test.ts`. Use the existing test's base-input builder pattern (read the top of the file first to reuse its `baseInput()`/`runningStatus()` helper; if none exists, construct a minimal `DeriveInput` inline with `bootstrap: { mode: 'running' }` and all non-triggering defaults). The test must reference the *new* `funds.chains` shape:

```ts
describe('funding notifications (issue #1296)', () => {
  function fundsStatus(chains: DeriveInput['status']['funds']['chains']): DeriveInput {
    return {
      bootstrap: { mode: 'running' },
      status: {
        funds: { eth: '0.01', chains },
        harness: { ready: true, name: null, reason: null },
        rpc: { reachable: true },
        restartPending: false,
        daemonVersion: '1.0.0',
        latestVersion: undefined,
        services: [],
        joinedSolverNets: { cid1: {} },
        passwordRotatedAt: undefined,
      },
    };
  }

  it('fires funding_low (warning) for a low-but-nonzero runway, naming wallet and chain', () => {
    const out = deriveNotifications(
      fundsStatus([
        { chain: 'Base Sepolia', wallet: '0xMASTER', runwayDays: 1, empty: false },
      ]),
    );
    const low = out.find((n) => n.kind === 'funding_low');
    expect(low).toBeDefined();
    expect(low!.severity).toBe('warning');
    expect(low!.message).toContain('Base Sepolia');
    expect(low!.message).toContain('0xMASTER');
  });

  it('fires funding_empty (blocking) when balance cannot cover the next tx, and suppresses funding_low for that chain', () => {
    const out = deriveNotifications(
      fundsStatus([
        { chain: 'Base Sepolia', wallet: '0xMASTER', runwayDays: 0, empty: true },
      ]),
    );
    const empty = out.find((n) => n.kind === 'funding_empty');
    expect(empty).toBeDefined();
    expect(empty!.severity).toBe('blocking');
    expect(empty!.message).toContain('Base Sepolia');
    expect(out.find((n) => n.kind === 'funding_low')).toBeUndefined();
  });

  it('fires a separate warning per chain (L1 + L2)', () => {
    const out = deriveNotifications(
      fundsStatus([
        { chain: 'Base Sepolia', wallet: '0xL2', runwayDays: 2, empty: false },
        { chain: 'Ethereum Sepolia', wallet: '0xL1', runwayDays: 1, empty: false },
      ]),
    );
    expect(out.filter((n) => n.kind === 'funding_low')).toHaveLength(2);
  });

  it('clears all funding notices when both chains are above threshold', () => {
    const out = deriveNotifications(
      fundsStatus([
        { chain: 'Base Sepolia', wallet: '0xL2', runwayDays: 99, empty: false },
        { chain: 'Ethereum Sepolia', wallet: '0xL1', runwayDays: 99, empty: false },
      ]),
    );
    expect(out.find((n) => n.kind === 'funding_low')).toBeUndefined();
    expect(out.find((n) => n.kind === 'funding_empty')).toBeUndefined();
  });
});
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `cd client && yarn test src/dashboard/spa/src/notifications/derive.test.ts`
Expected: FAIL — the deriver still reads `s.funds.runwayDays` (a scalar) and has no `funding_empty` branch; the new `funds.chains` field is unused, so no `funding_low`/`funding_empty` is produced and the existing single-`runwayDays` block likely throws on `s.funds.runwayDays` being `undefined` or emits the wrong message.

- [ ] **Step 4: Rewrite the deriver's funds block**

In `client/src/dashboard/spa/src/notifications/derive.ts`, replace the `DeriveInput` `funds` field and the single `funding_low` block. Change the interface (lines 15):

```ts
    funds: {
      eth: string;
      chains: Array<{
        chain: string;
        wallet: string | null;
        runwayDays: number;
        empty: boolean;
      }>;
    };
```

Replace the block at `derive.ts:39-46` with a per-chain loop:

```ts
  for (const c of s.funds.chains) {
    const walletLabel = c.wallet ?? 'wallet';
    if (c.empty) {
      out.push({
        kind: 'funding_empty',
        severity: 'blocking',
        message: `${c.chain} wallet (${walletLabel}) can no longer cover the next transaction. Top up now.`,
        jumpTo: '/overview',
      });
      continue; // empty supersedes low for this chain
    }
    if (c.runwayDays < RUNWAY_LOW_THRESHOLD_DAYS) {
      out.push({
        kind: 'funding_low',
        severity: 'warning',
        message: `Runway is ${c.runwayDays} day(s) on ${c.chain}. Top up gas (${walletLabel}) to keep claiming work.`,
        jumpTo: '/overview',
      });
    }
  }
```

Keep `RUNWAY_LOW_THRESHOLD_DAYS = 3` (`derive.ts:23`).

- [ ] **Step 5: Run the deriver test to verify it passes**

Run: `cd client && yarn test src/dashboard/spa/src/notifications/derive.test.ts`
Expected: PASS (all new cases + the pre-existing deriver tests; if any pre-existing test built `funds: { eth, runwayDays }` it must be migrated to the `chains` shape — update those call sites in the same file).

- [ ] **Step 6: Commit**

```bash
git add client/src/dashboard/spa/src/notifications/derive.ts \
        client/src/dashboard/spa/src/notifications/taxonomy.ts \
        client/src/dashboard/spa/src/notifications/derive.test.ts
git commit -m "fix(operator-app): chain-generic funding notices + funding_empty kind (#1296)"
```

**Satisfies:** AC#1 (low-runway warning naming wallet + chain) and AC#2 (distinct blocking warning) at the deriver layer.

---

### Task 2: Fix the adapter so the real runway reaches the deriver

The deriver is now correct but still starved: `mapStatusToDeriveInput` substitutes the `Infinity`/`0` proxy (`useNotifications.ts:57-69`) and emits the old scalar `runwayDays`. Map the real `masterGas.runwayDaysExcess` + `minEthWei` + `balanceWei` (and, once Task 4 lands, `l1MasterGas`) into the new `funds.chains` shape.

**Files:**
- Modify: `client/src/dashboard/spa/src/notifications/useNotifications.ts:57-119`
- Test: `client/src/dashboard/spa/src/notifications/useNotifications.test.ts`

**Interfaces:**
- Consumes: `StatusV1Response.masterGas.{address, balanceWei, runwayDaysExcess, minEthWei}` (from `status-build.ts:303-311`) and (after Task 4) `StatusV1Response.l1MasterGas.{address, balanceWei, runwayDaysExcess, minEthWei}`.
- Produces: a populated `DeriveInput['status']['funds'].chains` array.

- [ ] **Step 1: Write the failing adapter test**

In `client/src/dashboard/spa/src/notifications/useNotifications.test.ts` (currently a 24-line file), add a unit test against the exported `mapStatusToDeriveInput`:

```ts
import { describe, expect, it } from 'vitest';
import { mapStatusToDeriveInput } from './useNotifications.js';

describe('mapStatusToDeriveInput funds mapping (issue #1296)', () => {
  it('maps a low-but-nonzero L2 runway to a low chain entry (not Infinity)', () => {
    const status = {
      masterGas: {
        address: '0xL2MASTER',
        balanceWei: '5000000000000000', // 0.005 ETH, > 0
        runwayDaysExcess: '1',
        minEthWei: '1000000000000000',
      },
    };
    const mapped = mapStatusToDeriveInput(status, {}, false);
    const l2 = mapped.funds.chains.find((c) => c.wallet === '0xL2MASTER');
    expect(l2).toBeDefined();
    expect(l2!.runwayDays).toBe(1);     // NOT Infinity
    expect(l2!.empty).toBe(false);
  });

  it('flags empty when balanceWei < minEthWei', () => {
    const status = {
      masterGas: {
        address: '0xL2MASTER',
        balanceWei: '500000000000000',   // 0.0005 ETH
        runwayDaysExcess: '0',
        minEthWei: '1000000000000000',   // 0.001 ETH min
      },
    };
    const mapped = mapStatusToDeriveInput(status, {}, false);
    const l2 = mapped.funds.chains.find((c) => c.wallet === '0xL2MASTER');
    expect(l2!.empty).toBe(true);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd client && yarn test src/dashboard/spa/src/notifications/useNotifications.test.ts`
Expected: FAIL — `mapped.funds.chains` is `undefined` (the adapter still returns `funds: { eth, runwayDays }`).

- [ ] **Step 3: Rewrite the adapter's funds mapping**

In `client/src/dashboard/spa/src/notifications/useNotifications.ts`, delete the proxy block (`:57-69`) and replace the returned `funds` (`:86-89`) with a chain-builder. Add a helper above `mapStatusToDeriveInput`:

```ts
function gasChain(
  chain: string,
  gas: { address?: string | null; balanceWei?: string; runwayDaysExcess?: string | number | null; minEthWei?: string } | undefined,
): DeriveInput['status']['funds']['chains'][number] | null {
  if (!gas || gas.balanceWei === undefined) return null;
  let runwayDays = Number.POSITIVE_INFINITY;
  if (gas.runwayDaysExcess !== undefined && gas.runwayDaysExcess !== null) {
    const n = Number(gas.runwayDaysExcess);
    if (Number.isFinite(n)) runwayDays = n;
  }
  let empty = false;
  try {
    if (gas.minEthWei !== undefined) {
      empty = BigInt(gas.balanceWei) < BigInt(gas.minEthWei);
    }
  } catch {
    // non-numeric — leave empty=false
  }
  return { chain, wallet: gas.address ?? null, runwayDays, empty };
}
```

In `mapStatusToDeriveInput`, compute the chains and the rolled-up eth, and return them. The L2 label is `'Base Sepolia'`, the L1 label `'Ethereum Sepolia'` (Task 4 supplies `s.l1MasterGas`; until then the L1 chain is simply absent, which is correct):

```ts
  const chains: DeriveInput['status']['funds']['chains'] = [];
  const l2 = gasChain('Base Sepolia', s.masterGas);
  if (l2) chains.push(l2);
  const l1 = gasChain('Ethereum Sepolia', s.l1MasterGas);
  if (l1) chains.push(l1);

  // ... in the returned object:
  funds: {
    eth: String(s.masterGas?.balanceWei ?? '0'),
    chains,
  },
```

Remove the now-unused `masterEth` / `masterRunwayDays` locals.

- [ ] **Step 4: Run the adapter test to verify it passes**

Run: `cd client && yarn test src/dashboard/spa/src/notifications/useNotifications.test.ts`
Expected: PASS.

- [ ] **Step 5: Run the notifications suite to catch fallout**

Run: `cd client && yarn test src/dashboard/spa/src/notifications/`
Expected: PASS — including `useNotifications.test.tsx` (the integration test). If that test asserted the old `funding_low`-at-zero behaviour, update its fixtures to the `masterGas` shape.

- [ ] **Step 6: Commit**

```bash
git add client/src/dashboard/spa/src/notifications/useNotifications.ts \
        client/src/dashboard/spa/src/notifications/useNotifications.test.ts
git commit -m "fix(operator-app): map real masterGas runway into funding notices (#1296)"
```

**Satisfies:** AC#1 + AC#2 end-to-end for L2 (the daemon already emits `masterGas`). The clear-on-topup transition (AC#3) is now derivable from the next poll — locked by the test in Task 7.

---

### Task 3: Daemon types — add the `l1MasterGas` block to `StatusV1Response`

L1 master ETH is never gathered today. Introduce the wire shape and the assembler logic *before* the gatherer that fills it, so the gatherer compiles against the new raw fields.

**Files:**
- Modify: `client/src/api/status-build.ts`
- Test: `client/test/api/status-build.test.ts`

**Interfaces:**
- Produces, on `GatheredStatusRaw`:
  ```ts
  l1Master?: { address: string | null; balanceWei?: string; error?: string };
  minL1MasterEthWei?: string;
  l1MasterDailyEstimateWei?: string;
  ```
  and on `StatusV1Response`:
  ```ts
  l1MasterGas?: {
    address: string | null;
    balanceWei?: string;
    dailyEstimateWei: string;
    runwayDaysExcess?: string;
    minEthWei?: string;
    error?: string;
  };
  ```
  `assembleStatusV1` emits `l1MasterGas` only when `raw.l1Master` is present (mainnet / sqlite-only / older callers omit it). `runwayDaysExcess` is computed with the existing `computeRunwayDaysExcess` helper (`status-build.ts:419`).

- [ ] **Step 1: Write the failing assembler test**

Append to `client/test/api/status-build.test.ts`. Reuse `minimalFleet()` and `tjinnIdentityFields` already in the file:

```ts
describe('assembleStatusV1 l1MasterGas (issue #1296)', () => {
  function rawWithL1(over: Partial<GatheredStatusRaw> = {}): GatheredStatusRaw {
    return {
      ...tjinnIdentityFields,
      shutdownState: null,
      dbPath: '/tmp/x.db',
      activityCounts: {},
      recentActivity: [],
      lastRewardClaimTickAt: null,
      rewardClaimIntervalMs: 0,
      fleet: minimalFleet(),
      rpc: { ok: true },
      master: { address: '0xL2MASTER', balanceWei: '10000000000000000' },
      pollIntervalMs: 5000,
      masterDailyEstimateWei: '500000000000000',
      minMasterEthWei: '1000000000000000',
      l1Master: { address: '0xL1MASTER', balanceWei: '2000000000000000' },
      minL1MasterEthWei: '1000000000000000',
      l1MasterDailyEstimateWei: '500000000000000',
      ...over,
    };
  }

  it('emits an l1MasterGas block with computed runway when raw.l1Master is present', () => {
    const body = assembleStatusV1(rawWithL1());
    expect(body.l1MasterGas).toBeDefined();
    expect(body.l1MasterGas!.address).toBe('0xL1MASTER');
    expect(body.l1MasterGas!.balanceWei).toBe('2000000000000000');
    expect(body.l1MasterGas!.minEthWei).toBe('1000000000000000');
    // (2e15 - 1e15) / 5e14 = 2 days
    expect(body.l1MasterGas!.runwayDaysExcess).toBe('2');
  });

  it('omits l1MasterGas when raw.l1Master is absent', () => {
    const body = assembleStatusV1(rawWithL1({ l1Master: undefined }));
    expect(body.l1MasterGas).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `cd client && yarn test test/api/status-build.test.ts`
Expected: FAIL — `body.l1MasterGas` is `undefined` for both cases (and TypeScript errors on the unknown `l1Master` raw fields).

- [ ] **Step 3: Add the raw + response types**

In `client/src/api/status-build.ts`:

In `GatheredStatusRaw` (after the `minMasterEthWei?: string;` field near `:207`), add:

```ts
  /** L1 (Ethereum Sepolia) master native balance for the L1 gas-runway warning (#1296). */
  l1Master?: { address: string | null; balanceWei?: string; error?: string };
  /** Minimum L1 master ETH floor (wei string). Absent ⇒ no l1MasterGas runway. */
  minL1MasterEthWei?: string;
  /** Resolved L1 daily burn estimate for runway (wei string). */
  l1MasterDailyEstimateWei?: string;
```

In `StatusV1Response`, after the `masterGas` block (`:303-311`), add:

```ts
  /**
   * L1 (Ethereum Sepolia) master gas runway — parallel to `masterGas` but for
   * the L1 governance chain (#1296). Present only when the L1 master balance
   * was gathered (testnet with an ethereumRpcUrl); omitted on mainnet /
   * sqlite-only / older callers.
   */
  l1MasterGas?: {
    address: string | null;
    balanceWei?: string;
    dailyEstimateWei: string;
    runwayDaysExcess?: string;
    minEthWei?: string;
    error?: string;
  };
```

- [ ] **Step 4: Emit `l1MasterGas` in `assembleStatusV1`**

In `assembleStatusV1` (near the existing `runway` const at `:603`), compute the L1 runway and conditionally spread the block into the returned object. Add before the `return`:

```ts
  const l1Runway =
    raw.l1Master?.balanceWei !== undefined && raw.l1MasterDailyEstimateWei !== undefined
      ? computeRunwayDaysExcess(
          BigInt(raw.l1Master.balanceWei),
          raw.minL1MasterEthWei !== undefined ? BigInt(raw.minL1MasterEthWei) : undefined,
          BigInt(raw.l1MasterDailyEstimateWei),
        )
      : undefined;
```

Then in the returned object literal, after the `masterGas: { … }` block, add:

```ts
    ...(raw.l1Master !== undefined
      ? {
          l1MasterGas: {
            address: raw.l1Master.address,
            balanceWei: raw.l1Master.balanceWei,
            dailyEstimateWei: raw.l1MasterDailyEstimateWei ?? '0',
            runwayDaysExcess:
              raw.l1Master.balanceWei !== undefined && l1Runway !== undefined ? l1Runway : undefined,
            minEthWei: raw.minL1MasterEthWei,
            error: raw.l1Master.error,
          },
        }
      : {}),
```

- [ ] **Step 5: Run to verify pass**

Run: `cd client && yarn test test/api/status-build.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add client/src/api/status-build.ts client/test/api/status-build.test.ts
git commit -m "feat(api): l1MasterGas block on /v1/status (#1296)"
```

**Satisfies:** scaffolding for AC#1/AC#2 on L1 (no operator-visible change yet).

---

### Task 4: Daemon gatherer — fetch the L1 master native balance

Populate `raw.l1Master` / `raw.minL1MasterEthWei` / `raw.l1MasterDailyEstimateWei` in `gatherGatheredStatusRaw`. The L1 master wallet is the same key as the L2 master (`createJinnL1WalletClient` doc: "same key that pays for L2 stOLAS reward claims and bootstrap"), so the address is `fleet.master_address`; the balance is read on the L1 chain via `createJinnL1PublicClient(ethereumRpcUrl, 'sepolia')` — the helper already imported and used at `gather-status.ts:526`.

**Files:**
- Modify: `client/src/api/gather-status.ts`
- Test: `client/test/api/gather-status*.test.ts` (create `client/test/api/gather-status-l1-gas.test.ts` if no suitable host exists)

**Interfaces:**
- Consumes: `status.config?.ethereumRpcUrl` (testnet only), `fleet.master_address`, existing `daily`/min machinery.
- Produces: the three new `raw.l1*` fields (consumed by Task 3's assembler).

- [ ] **Step 1: Decide the L1 daily-estimate + min source (no new config key)**

The L1 daily estimate reuses `resolveMasterDailyEstimateWei` — but L1 gas burn differs from L2, so do NOT reuse the L2 `masterEthDailyEstimateWei` env value verbatim. Per the issue ("L1 reuses the same machinery with L1-appropriate defaults via existing env `JINN_MASTER_ETH_DAILY_WEI`"), resolve the L1 daily estimate from the *same* config value when set, else the default constant. For `minL1MasterEthWei`, reuse the L1 floor already used by the cross-chain claim path. Confirm the source by grepping before coding:

Run: `cd client && grep -rn "minL1\|L1.*minEth\|ethereum.*min\|stage1MinMasterEth\|minEoaGasEth" src/earning/ | head`

Use the L1-appropriate floor surfaced there (e.g. an L1 `minEoaGasEth` on the L1 chain config). If no distinct L1 floor exists, default `minL1MasterEthWei` to the same `stage1MinMasterEth`/`minEoaGasEth` value already computed for L2 — but compute it from the L1 chain config, not the L2 one. Document the chosen source in a code comment citing #1296.

- [ ] **Step 2: Write the failing gatherer test**

Create `client/test/api/gather-status-l1-gas.test.ts`. Mirror the existing `gather-status` test setup (read a sibling `client/test/api/gather-status*.test.ts` first for the Store mock + `StatusGatherConfig` fixture conventions). The test stubs the viem L1 client's `getBalance` and asserts the raw block:

```ts
// Pattern (adapt mocks to the existing gather-status test harness):
// - mock createJinnL1PublicClient to return a client whose getBalance resolves 2e15
// - call gatherGatheredStatusRaw with network:'testnet', config.ethereumRpcUrl set,
//   a fleet that has master_address
// - assert raw.l1Master?.balanceWei === '2000000000000000'
// - assert raw.minL1MasterEthWei is defined and raw.l1MasterDailyEstimateWei is defined
```

- [ ] **Step 3: Run to verify failure**

Run: `cd client && yarn test test/api/gather-status-l1-gas.test.ts`
Expected: FAIL — `raw.l1Master` is `undefined`.

- [ ] **Step 4: Gather the L1 balance**

In `gatherGatheredStatusRaw`, after the L2 master balance read (`gather-status.ts:1255-1270`), add an L1 read guarded on testnet + ethereumRpcUrl + master address. It must be error-safe (a failed L1 read sets `error`, never throws the endpoint):

```ts
  // L1 (Ethereum Sepolia) master gas runway (#1296). Same master key as L2;
  // balance read on the L1 chain. Testnet-only — mainnet has no L1 gas surface here.
  if (
    status.network === 'testnet' &&
    status.config?.ethereumRpcUrl &&
    fleet?.master_address
  ) {
    const l1DailyWei = resolveMasterDailyEstimateWei(
      status.masterEthDailyEstimateWei, // existing env (JINN_MASTER_ETH_DAILY_WEI)
      status.pollIntervalMs,
    ).toString();
    raw.l1MasterDailyEstimateWei = l1DailyWei;
    raw.minL1MasterEthWei = /* L1 floor resolved in Step 1 */;
    try {
      const l1Client = createJinnL1PublicClient(status.config.ethereumRpcUrl, 'sepolia');
      const l1Bal = await l1Client.getBalance({
        address: fleet.master_address as `0x${string}`,
      });
      raw.l1Master = { address: fleet.master_address, balanceWei: l1Bal.toString() };
    } catch (e) {
      raw.l1Master = {
        address: fleet.master_address,
        error: e instanceof Error ? e.message : String(e),
      };
    }
  }
```

Place this read so it does not serialize behind the tJINN await unnecessarily; mirror the existing "start early, await late" pattern only if it measurably helps — otherwise a plain sequential read after the L2 fan-out is acceptable (the endpoint already awaits several reads). Keep it simple (Rule 2).

- [ ] **Step 5: Run to verify pass**

Run: `cd client && yarn test test/api/gather-status-l1-gas.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add client/src/api/gather-status.ts client/test/api/gather-status-l1-gas.test.ts
git commit -m "feat(api): gather L1 master gas balance for runway warning (#1296)"
```

**Satisfies:** AC#1 + AC#2 for L1 at the daemon layer. With Task 2's adapter already reading `s.l1MasterGas`, the L1 chain now appears in `funds.chains` and fires notifications.

---

### Task 5: WalletCard — severity-tinted runway line

The Wallet card's inline "Nd runway" (`WalletCard.tsx:242`) is currently flat `statAux`. Tint it warning/blocking when the runway is low/empty, using the same `--severity-warning-fg` / `--severity-blocking-fg` tokens (`globals.css:83-88`). The existing `Top up from faucet` Button stays as the low-emphasis top-up link.

**Files:**
- Modify: `client/src/dashboard/spa/src/pages/overview/WalletCard.tsx`
- Test: `client/src/dashboard/spa/src/pages/overview/WalletCard.test.tsx`

**Interfaces:**
- Consumes: a new optional prop `runwaySeverity?: 'warning' | 'blocking' | null` (default `null` ⇒ flat). Overview computes it from `masterGas` (Task 6).

- [ ] **Step 1: Write the failing WalletCard test**

Append to `client/src/dashboard/spa/src/pages/overview/WalletCard.test.tsx` (reuse its `defaultProps()` + `wrap()`):

```ts
it('tints the runway line warning when runwaySeverity is warning', () => {
  const { ui } = wrap(<WalletCard {...defaultProps()} runwayDays={1} runwaySeverity="warning" />);
  const el = ui.getByTestId('wallet-runway');
  expect(el.getAttribute('data-runway-severity')).toBe('warning');
});

it('tints the runway line blocking when runwaySeverity is blocking', () => {
  const { ui } = wrap(<WalletCard {...defaultProps()} runwayDays="—" runwaySeverity="blocking" />);
  expect(ui.getByTestId('wallet-runway').getAttribute('data-runway-severity')).toBe('blocking');
});

it('leaves the runway line untinted by default', () => {
  const { ui } = wrap(<WalletCard {...defaultProps()} />);
  expect(ui.getByTestId('wallet-runway').getAttribute('data-runway-severity')).toBe('none');
});
```

- [ ] **Step 2: Run to verify failure**

Run: `cd client && yarn test src/dashboard/spa/src/pages/overview/WalletCard.test.tsx`
Expected: FAIL — no `wallet-runway` testid / no `runwaySeverity` prop.

- [ ] **Step 3: Add the prop + tinted span**

In `WalletCard.tsx`, add `runwaySeverity?: 'warning' | 'blocking' | null;` to `WalletCardProps`, accept it in the destructure (default `null`), and replace the runway span (`:242`):

```tsx
            <span
              data-testid="wallet-runway"
              data-runway-severity={runwaySeverity ?? 'none'}
              className={statAux}
              style={
                runwaySeverity === 'blocking'
                  ? { color: 'var(--severity-blocking-fg)' }
                  : runwaySeverity === 'warning'
                    ? { color: 'var(--severity-warning-fg)' }
                    : undefined
              }
            >
              {runwayDays}d runway
            </span>
```

- [ ] **Step 4: Run to verify pass**

Run: `cd client && yarn test src/dashboard/spa/src/pages/overview/WalletCard.test.tsx`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add client/src/dashboard/spa/src/pages/overview/WalletCard.tsx \
        client/src/dashboard/spa/src/pages/overview/WalletCard.test.tsx
git commit -m "feat(operator-app): severity-tinted runway line on WalletCard (#1296)"
```

**Satisfies:** AC#1/AC#2 visual reinforcement on the Wallet card (the banner is the primary surface; this is the in-card echo per the design note).

---

### Task 6: Overview wiring — feed severity + verify L1 type

Wire the new `runwaySeverity` prop from `masterGas`, and add the `l1MasterGas` field to the page-local status type so it type-checks (the deriver/adapter already consume it; Overview only needs the type for the WalletCard severity computation).

**Files:**
- Modify: `client/src/dashboard/spa/src/pages/Overview.tsx` (`:76-79`, `:255-256`, `:449-451`)

**Interfaces:**
- Consumes: `status.masterGas.{runwayDaysExcess, balanceWei, minEthWei}`.
- Produces: `runwaySeverity` passed to `<WalletCard>`.

- [ ] **Step 1: Extend the page-local masterGas type + add l1MasterGas**

In `Overview.tsx:76-79`, extend the `masterGas` shape and add `l1MasterGas`:

```ts
  masterGas?: {
    balanceWei?: string;
    runwayDaysExcess?: string | number | null;
    minEthWei?: string;
  };
  l1MasterGas?: {
    balanceWei?: string;
    runwayDaysExcess?: string | number | null;
    minEthWei?: string;
  };
```

- [ ] **Step 2: Compute runwaySeverity**

Near `Overview.tsx:255-256`, after `gasRunwayDays`, derive the worst severity across the master (L2) wallet — the Wallet card shows the L2 master:

```ts
  const gasRunwaySeverity: 'warning' | 'blocking' | null = (() => {
    const mg = status?.masterGas;
    if (!mg || mg.balanceWei === undefined) return null;
    try {
      if (mg.minEthWei !== undefined && BigInt(mg.balanceWei) < BigInt(mg.minEthWei)) {
        return 'blocking';
      }
    } catch { /* non-numeric */ }
    const days = Number(mg.runwayDaysExcess);
    if (Number.isFinite(days) && days < 3) return 'warning';
    return null;
  })();
```

- [ ] **Step 3: Pass the prop**

At `<WalletCard … />` (`:449-451`), add `runwaySeverity={gasRunwaySeverity}`.

- [ ] **Step 4: Typecheck + run Overview test if present**

Run: `cd client && yarn typecheck && yarn test src/dashboard/spa/src/pages/Overview`
Expected: zero type errors; any Overview test passes (update fixtures only if a test asserts the runway line).

- [ ] **Step 5: Commit**

```bash
git add client/src/dashboard/spa/src/pages/Overview.tsx
git commit -m "feat(operator-app): wire runway severity + l1MasterGas type into Overview (#1296)"
```

**Satisfies:** AC#1/AC#2 (Wallet-card surface).

---

### Task 7: Clear-on-topup regression test (AC#3)

AC#3 is mechanically free — notifications recompute every poll from `/v1/status` — but the issue requires an explicit test asserting the cleared transition. Drive it through the deriver (pure, deterministic) and/or `mapStatusToDeriveInput` to prove a topped-up status produces no funding notice.

**Files:**
- Test: `client/src/dashboard/spa/src/notifications/derive.test.ts` (covered in Task 1 Step 2's "clears all funding notices" case) — add a transition assertion here if not already explicit.

- [ ] **Step 1: Add the transition test**

In `derive.test.ts`, add:

```ts
it('clears funding_low and funding_empty after a top-up above threshold (AC#3)', () => {
  const before = deriveNotifications(
    fundsStatus([{ chain: 'Base Sepolia', wallet: '0xM', runwayDays: 0, empty: true }]),
  );
  expect(before.some((n) => n.kind === 'funding_empty')).toBe(true);

  const after = deriveNotifications(
    fundsStatus([{ chain: 'Base Sepolia', wallet: '0xM', runwayDays: 99, empty: false }]),
  );
  expect(after.some((n) => n.kind === 'funding_empty' || n.kind === 'funding_low')).toBe(false);
});
```

- [ ] **Step 2: Run to verify pass**

Run: `cd client && yarn test src/dashboard/spa/src/notifications/derive.test.ts`
Expected: PASS (the deriver is stateless; a higher-balance input yields no notice — this is exactly the per-poll re-render behaviour in production).

- [ ] **Step 3: Commit**

```bash
git add client/src/dashboard/spa/src/notifications/derive.test.ts
git commit -m "test(operator-app): assert funding notices clear after top-up (#1296)"
```

**Satisfies:** AC#3.

---

### Task 8: Spec update (human-surface — MUST land in this PR)

**Files:**
- Modify: `client/OPERATOR-APP-SPEC.md` §2.3 (`:86-90`) + §2.10 (`:302-313`)

- [ ] **Step 1: §2.3 Funds — replace the single `runway low` state message**

In the §2.3 **State messages** list (`:86-90`), replace the bare `- runway low` line with the two-severity, per-chain version:

```markdown
  - runway low — **warning**. Native ETH runway is below the low threshold (under 3 days at the daily burn estimate) on a given chain. Raised per chain — both the L2 (Base Sepolia) and L1 (Ethereum Sepolia) master wallets carry their own threshold. Names the wallet and chain. Maps to the faucet top-up action.
  - cannot cover next transaction — **blocking**. The wallet's balance has fallen below the configured minimum (`balanceWei < minEthWei`) on a given chain, so it can no longer fund the next transaction. Distinct, higher-severity counterpart to *runway low*; surfaces `funding_empty` (§2.10).
```

- [ ] **Step 2: §2.10 taxonomy — add `funding_empty`**

In the §2.10 list (`:302`), add immediately after `- \`funding_low\``:

```markdown
- `funding_empty` — a wallet's native balance can no longer cover the next transaction (`balanceWei < minEthWei`), per chain (L2 Base Sepolia and L1 Ethereum Sepolia). Severity: **blocking**. Distinct higher-severity counterpart to `funding_low`. Names the wallet and chain. Derived from `/v1/status` `masterGas` / `l1MasterGas`; clears on the next poll after top-up (§3.4).
```

- [ ] **Step 3: Verify no other §2.3/§2.10 line contradicts the new copy**

Run: `cd /Users/gcd/Repositories/main/jinn-mono_worktrees/1296 && grep -n "funding_low\|funding_empty\|runway low" client/OPERATOR-APP-SPEC.md`
Expected: the new lines present; the §2.13 launcher-Safe `runway low` (`:370`) is the separate launcher-budget message and stays untouched.

- [ ] **Step 4: Commit**

```bash
git add client/OPERATOR-APP-SPEC.md
git commit -m "docs(operator-app): spec funding_empty + per-chain runway messages (#1296)"
```

**Satisfies:** human-surface rule; documents AC#1/AC#2 domain model.

---

### Task 9: Import + match the Claude Design artifact

The notification banner and WalletCard must match `Gas Runway Warnings.html` (Claude Design project `019e2715-c4bc-7eae-af28-e178b95e5156`).

- [ ] **Step 1: Import the artifact**

Use the `claude_design` MCP to fetch the file `Gas Runway Warnings.html` from project `019e2715-c4bc-7eae-af28-e178b95e5156`. (If the MCP tool is deferred, load it via ToolSearch first: `select:` the claude_design tool by name.)

- [ ] **Step 2: Reconcile copy + tokens against the artifact**

Compare the artifact's exact warning copy, severity colours, and layout against the implemented `funding_low`/`funding_empty` messages, `NotificationItem` rendering, and the WalletCard runway line. Adjust message strings and any token usage to match the artifact. Do NOT introduce new shadcn primitives — if the artifact implies a layout the current `NotificationItem` cannot express with existing tokens, request snowflake approval per CLAUDE.md §Frontends rather than hand-rolling.

- [ ] **Step 3: Update message-asserting tests if copy changed**

If Step 2 changed any message string, update the corresponding `derive.test.ts` `.toContain(...)` assertions to the final copy and re-run.

Run: `cd client && yarn test src/dashboard/spa/src/notifications/`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add -A
git commit -m "feat(operator-app): match Gas Runway Warnings design artifact (#1296)"
```

**Satisfies:** the visual-parity requirement.

---

### Task 10: Full verification + branch finish

- [ ] **Step 1: Full typecheck + test**

Run: `cd client && yarn typecheck && yarn test`
Expected: zero type errors; all suites green (daemon `client/test/**` + SPA `client/src/dashboard/spa/src/**`).

- [ ] **Step 2: Confirm acceptance criteria against the diff**

- AC#1: low-but-nonzero runway fires `funding_low` naming wallet + chain, for both L2 (`masterGas`) and L1 (`l1MasterGas`). Proven by `derive.test.ts` + `useNotifications.test.ts` + `gather-status-l1-gas.test.ts`.
- AC#2: `balanceWei < minEthWei` fires `funding_empty` at `blocking`. Proven by `derive.test.ts` + `status-build.test.ts`.
- AC#3: a topped-up status yields no funding notice on the next poll. Proven by the `derive.test.ts` transition test (Task 7).

- [ ] **Step 3: Finish the branch**

Use `superpowers:finishing-a-development-branch`. PR title prefix `fix:` per the issue shape; PR targets `next` (CLAUDE.md AI rule 10). Reference #1296.

---

## Self-Review

**Spec coverage:**
- AC#1 (low-runway, per chain, names wallet+chain): Tasks 1, 2 (L2), 3, 4 (L1) — covered.
- AC#2 (distinct blocking warning): Tasks 1 (`funding_empty` branch), 3 (`l1MasterGas`/`minEthWei`) — covered.
- AC#3 (clears on top-up without reload): Task 7 + the inherent per-poll derivation — covered.
- Visual artifact: Task 9 — covered.
- Spec delta (human-surface): Task 8 — covered.
- No new config keys / env-overridable thresholds: Global Constraints + Task 4 Step 1 — covered.

**Placeholder scan:** Task 4 Step 4 contains one deliberate fill-in (`raw.minL1MasterEthWei = /* L1 floor resolved in Step 1 */;`) because the exact L1 floor source must be confirmed by the grep in Task 4 Step 1 — the step that resolves it is explicit and runs first. No other placeholders.

**Type consistency:** `funds.chains[]` entry shape (`chain`, `wallet`, `runwayDays`, `empty`) is identical across `derive.ts` (Task 1), the `gasChain` helper (Task 2), and the tests. `l1MasterGas` field name + sub-fields (`address`, `balanceWei`, `dailyEstimateWei`, `runwayDaysExcess`, `minEthWei`, `error`) match across `status-build.ts` (Task 3), `gather-status.ts` raw fields (Task 4), `useNotifications.ts` consumption (Task 2), and `Overview.tsx` type (Task 6). `runwaySeverity` (`'warning' | 'blocking' | null`) matches between WalletCard (Task 5) and Overview (Task 6).
