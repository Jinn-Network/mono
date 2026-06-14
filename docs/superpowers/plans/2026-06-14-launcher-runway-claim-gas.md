# Launcher Runway — Claim-Gas-Inclusive Projection Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the Launcher "Spend & runway" panel project runway from a per-Task cost that includes the claim-tx gas (not just manifest solution + verdict prices), and surface a low-runway state message under 100 Tasks.

**Architecture:** This is an entirely client-side SPA fix (`fix` shape — regression test first). `projectRunwayTasks` in `helpers.ts` gains two named gas constants and an optional `claimGasWei` param, folding a claim-gas term into `perTaskWei`. It also returns a `lowRunway` flag (true when `tasks < 100`). `SpendPanel.tsx` renders the low-runway state message inside its Card. The OPERATOR-APP-SPEC §2.13 Launcher entry gains a "Spend & runway" sub-entry in the same PR.

**Tech Stack:** TypeScript, React, Vitest (`node` project for `helpers.test.ts`, `spa-jsdom` project for `SpendPanel.test.tsx`), Testing Library, BigInt arithmetic.

**Constant values (arithmetic done — claim gas ≈ 2,000 gwei):**
- `CLAIM_TX_GAS = 175000n` — mid of the 150k–200k `execTransaction` range. Honest-conservative.
- `CLAIM_GAS_PRICE_WEI = 11_500_000n` — 0.0115 gwei. Chosen so `175000 × 11_500_000 = 2_012_500_000_000 wei = 2,012.5 gwei ≈ 2,000 gwei` per claim (the issue's figure).
- `LOW_RUNWAY_TASKS = 100` — per AC3.
- Default `claimGasWei = CLAIM_TX_GAS * CLAIM_GAS_PRICE_WEI = 2_012_500_000_000n`.

**Regression proof (the issue's numbers):** with the old code, `safeBalance = 0.002 ETH (2_000_000_000_000_000 wei)` and `perTask = 15 gwei (15_000_000_000 wei)` yields `133,333` Tasks. With the gas term it yields `986` Tasks (matches the issue's "~1,000"). The breaking existing test is `SpendPanel.test.tsx:162` ("projects runway as Safe balance / per-Task cost"), which currently asserts `10 Tasks` / `150 wei` — those assertions MUST change (see Task 3); that breakage is the regression-proof for AC1/AC2.

**Acceptance-criteria → task map:**
- **AC1** (runway includes claim-tx gas) → Task 1 (helpers regression test) + Task 2 (helpers impl).
- **AC2** (displayed runway reflects combined per-Task cost) → Task 3 (SpendPanel test rewrite) + Task 4 (no SpendPanel logic change needed — it already renders `projection.perTaskWei` / `projection.tasks`; verify).
- **AC3** (low-runway state message < 100 claims) → Task 5 (SpendPanel low-runway test) + Task 6 (SpendPanel low-runway render).
- **Spec** (same PR) → Task 7 (OPERATOR-APP-SPEC §2.13).

---

## File Structure

- **Modify** `client/src/dashboard/spa/src/pages/launcher-launched/helpers.ts:107-137` — add 4 constants; extend `projectRunwayTasks` signature + return shape (`perTaskWei`, `tasks`, **new** `lowRunway`).
- **Create** `client/src/dashboard/spa/src/pages/launcher-launched/helpers.test.ts` — new unit test for `projectRunwayTasks` (runs in the `node` vitest project, per `vitest.config.ts:9` `*.test.ts` glob — helpers.ts has no React/DOM imports, so node env is correct).
- **Modify** `client/src/dashboard/spa/src/pages/launcher-launched/SpendPanel.tsx:74-78,143-166` — render a low-runway state message inside the Card.
- **Modify** `client/src/dashboard/spa/src/pages/launcher-launched/SpendPanel.test.tsx:162-180` — rewrite the breaking runway test with gas-inclusive numbers; add a low-runway render case.
- **Modify** `client/OPERATOR-APP-SPEC.md:357` — add "Spend & runway" sub-entry to §2.13 Launcher.

**Run command for a single SPA test file:** from the `client/` directory,
`yarn vitest run src/dashboard/spa/src/pages/launcher-launched/<file>` (vitest picks the matching project by include-glob). Use `--reporter verbose` to see per-test names.

---

### Task 1: helpers — failing regression test for claim-gas-inclusive per-Task cost

**Files:**
- Create: `client/src/dashboard/spa/src/pages/launcher-launched/helpers.test.ts`

- [ ] **Step 1: Write the failing test**

Create `client/src/dashboard/spa/src/pages/launcher-launched/helpers.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import {
  projectRunwayTasks,
  CLAIM_TX_GAS,
  CLAIM_GAS_PRICE_WEI,
  LOW_RUNWAY_TASKS,
} from './helpers.js';

describe('projectRunwayTasks', () => {
  it('exposes claim-gas + low-runway constants', () => {
    expect(CLAIM_TX_GAS).toBe(175000n);
    expect(CLAIM_GAS_PRICE_WEI).toBe(11_500_000n);
    expect(LOW_RUNWAY_TASKS).toBe(100);
  });

  it('returns null when any input is missing or non-numeric', () => {
    expect(projectRunwayTasks(undefined, '100', '50')).toBeNull();
    expect(projectRunwayTasks('1500', undefined, '50')).toBeNull();
    expect(projectRunwayTasks('1500', '100', undefined)).toBeNull();
    expect(projectRunwayTasks('1.5', '100', '50')).toBeNull();
    expect(projectRunwayTasks('abc', '100', '50')).toBeNull();
  });

  it('folds the claim-tx gas term into per-Task cost', () => {
    // solution 1000 gwei + verdict 500 gwei + claim gas 2012.5 gwei
    const result = projectRunwayTasks(
      '14050000000000', // balance = 4 × per-Task cost
      '1000000000000', // 1000 gwei
      '500000000000', // 500 gwei
    );
    expect(result).not.toBeNull();
    // 1000000000000 + 500000000000 + (175000 * 11_500_000) = 3_512_500_000_000
    expect(result!.perTaskWei).toBe(3_512_500_000_000n);
    expect(result!.tasks).toBe(4);
  });

  it('no longer returns the wildly optimistic 133,333 from the issue', () => {
    // The exact regression: 0.002 ETH safe balance, 15 gwei manifest per-Task.
    const result = projectRunwayTasks(
      '2000000000000000', // 0.002 ETH
      '10000000000', // 10 gwei
      '5000000000', // 5 gwei
    );
    expect(result).not.toBeNull();
    expect(result!.tasks).not.toBe(133333);
    expect(result!.tasks).toBe(986); // gas-inclusive reality, ~1,000
  });

  it('accepts an explicit claimGasWei override', () => {
    const result = projectRunwayTasks('300', '100', '50', 0n);
    // With zero claim gas, per-Task = 150, 300 / 150 = 2.
    expect(result!.perTaskWei).toBe(150n);
    expect(result!.tasks).toBe(2);
  });

  it('flags lowRunway true below the threshold, false at/above it', () => {
    // per-Task cost = 3_512_500_000_000.
    const below = projectRunwayTasks(
      '347737500000000', // 99 × per-Task
      '1000000000000',
      '500000000000',
    );
    expect(below!.tasks).toBe(99);
    expect(below!.lowRunway).toBe(true);

    const at = projectRunwayTasks(
      '351250000000000', // 100 × per-Task
      '1000000000000',
      '500000000000',
    );
    expect(at!.tasks).toBe(100);
    expect(at!.lowRunway).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run (from `client/`): `yarn vitest run src/dashboard/spa/src/pages/launcher-launched/helpers.test.ts`
Expected: FAIL — `CLAIM_TX_GAS`, `CLAIM_GAS_PRICE_WEI`, `LOW_RUNWAY_TASKS` are not exported, and `projectRunwayTasks` has no `lowRunway` in its return / no 4th param, so the gas-inclusive and low-runway assertions fail (TypeScript/import errors + assertion failures).

- [ ] **Step 3: Commit the failing test**

```bash
git add "client/src/dashboard/spa/src/pages/launcher-launched/helpers.test.ts"
git commit -m "test(launcher): failing regression for claim-gas-inclusive runway (#573)"
```

---

### Task 2: helpers — extend `projectRunwayTasks` with the claim-gas term and lowRunway flag (AC1)

**Files:**
- Modify: `client/src/dashboard/spa/src/pages/launcher-launched/helpers.ts:107-137`

- [ ] **Step 1: Add the constants and replace the function**

Replace the existing block (current lines 107-137, the doc-comment through the end of `projectRunwayTasks`) with:

```ts
/**
 * Expected gas cost of an average Safe `execTransaction` claim tx, folded into
 * the per-Task runway so the projection is not wildly optimistic (#573).
 *
 * There is no live gas-price feed in the SPA, so these are honest-conservative
 * named constants rather than a plumbed estimate. They err toward a SHORTER
 * runway. The daemon's real fee estimation lives in
 * `client/src/adapters/mech/safe.ts`; revisit these if that path changes.
 *
 *   CLAIM_TX_GAS        — 175,000 gas, mid of the 150k–200k execTransaction range.
 *   CLAIM_GAS_PRICE_WEI — 0.0115 gwei, chosen so claim gas ≈ 2,000 gwei/claim
 *                         (175,000 × 11,500,000 = 2,012,500,000,000 wei).
 */
export const CLAIM_TX_GAS = 175000n;
export const CLAIM_GAS_PRICE_WEI = 11_500_000n;
export const DEFAULT_CLAIM_GAS_WEI = CLAIM_TX_GAS * CLAIM_GAS_PRICE_WEI;

/** Runway at or below this many Tasks surfaces a low-runway state message (#573). */
export const LOW_RUNWAY_TASKS = 100;

/**
 * Compute the projected number of Tasks the Safe can fund. Per-Task cost is
 * `solutionPriceWei + verdictPriceWei + claimGasWei`, where `claimGasWei`
 * defaults to the expected claim-tx gas (`DEFAULT_CLAIM_GAS_WEI`). Excluding
 * the gas term was the #573 bug. Returns `null` when inputs are missing or
 * non-numeric. `lowRunway` is true when `tasks < LOW_RUNWAY_TASKS`.
 */
export function projectRunwayTasks(
  safeBalanceWei: string | null | undefined,
  solutionPriceWei: string | undefined,
  verdictPriceWei: string | undefined,
  claimGasWei: bigint = DEFAULT_CLAIM_GAS_WEI,
): { tasks: number; perTaskWei: bigint; lowRunway: boolean } | null {
  if (
    !safeBalanceWei ||
    !/^\d+$/.test(safeBalanceWei) ||
    !solutionPriceWei ||
    !/^\d+$/.test(solutionPriceWei) ||
    !verdictPriceWei ||
    !/^\d+$/.test(verdictPriceWei)
  ) {
    return null;
  }
  let bal: bigint;
  try {
    bal = BigInt(safeBalanceWei);
  } catch {
    return null;
  }
  const perTaskWei =
    BigInt(solutionPriceWei) + BigInt(verdictPriceWei) + claimGasWei;
  if (perTaskWei <= 0n) return null;
  const tasks = Number(bal / perTaskWei);
  return { tasks, perTaskWei, lowRunway: tasks < LOW_RUNWAY_TASKS };
}
```

- [ ] **Step 2: Run the helpers test to verify it passes**

Run (from `client/`): `yarn vitest run src/dashboard/spa/src/pages/launcher-launched/helpers.test.ts`
Expected: PASS (all 6 tests).

- [ ] **Step 3: Typecheck**

Run (from `client/`): `yarn typecheck`
Expected: zero errors. (Confirms the new optional param + return-shape change does not break existing `projectRunwayTasks` callers.)

- [ ] **Step 4: Commit**

```bash
git add "client/src/dashboard/spa/src/pages/launcher-launched/helpers.ts"
git commit -m "fix(launcher): include claim-tx gas in runway per-Task cost (#573)"
```

---

### Task 3: SpendPanel — rewrite the breaking runway test with gas-inclusive numbers (AC2)

**Files:**
- Modify: `client/src/dashboard/spa/src/pages/launcher-launched/SpendPanel.test.tsx:162-180`

This test currently encodes the OLD (gas-excluding) behavior and WILL fail after Task 2. Updating it to gas-inclusive numbers is the AC2 regression-proof.

- [ ] **Step 1: Replace the `projects runway as Safe balance / per-Task cost` test**

Replace the test body at `SpendPanel.test.tsx:162-180` (the whole `it('projects runway as Safe balance / per-Task cost', ...)` block) with:

```ts
  it('projects runway from a claim-gas-inclusive per-Task cost', async () => {
    const fetchLauncherStatus = vi.fn().mockResolvedValue(
      // balance = 4 × per-Task cost (3_512_500_000_000 wei).
      buildStatusResponse('Polymarket', '14050000000000'),
    );
    wrap(
      <SpendPanel
        record={buildRecord()}
        manifest={buildManifest({
          solutionPriceWei: '1000000000000', // 1000 gwei
          verdictPriceWei: '500000000000', // 500 gwei
        })}
        fetchLauncherStatus={fetchLauncherStatus}
      />,
    );
    await waitFor(() =>
      expect(
        screen.getByTestId('launcher-launched-spend-runway').textContent,
      ).toContain('4 Tasks'),
    );
    // Per-Task cost = 1000 gwei + 500 gwei + 2012.5 gwei claim gas = 3512.5 gwei.
    expect(
      screen.getByTestId('launcher-launched-spend-per-task').textContent,
    ).toContain('3,512.5 gwei');
  });
```

(Note: `formatWeiAmount(3_512_500_000_000n)` renders `3,512.5 gwei` — `formatDecimalUnits(value, 9, 4)` with thousands separators via `.toLocaleString()` only on the sub-gwei `wei` branch; the gwei branch uses `formatDecimalUnits`, which returns `3512.5`. **Verify the exact string** by running the test — if the renderer emits `3512.5 gwei` without the comma, change the assertion to `.toContain('3512.5 gwei')`. The `4 Tasks` runway assertion is the load-bearing AC2 check and is comma-free.)

- [ ] **Step 2: Run the SpendPanel test to verify the runway test passes**

Run (from `client/`): `yarn vitest run src/dashboard/spa/src/pages/launcher-launched/SpendPanel.test.tsx --reporter verbose`
Expected: the rewritten `projects runway from a claim-gas-inclusive per-Task cost` PASSES. If the per-Task assertion fails only on the comma, fix per the note above and re-run.

- [ ] **Step 3: Confirm the other existing SpendPanel tests still pass**

Same command. Verify in particular:
- `formats small live prices as gwei...` (line 211) — prices 10 gwei + 5 gwei. Per-Task now = 10 + 5 + 2012.5 = **2027.5 gwei**, so its `toBe('15 gwei')` assertion on `launcher-launched-spend-per-task` (line 236) **will fail**. Update that assertion to `.toBe('2027.5 gwei')` and the comment to reflect the gas term. It still proves the no-scientific-notation property (line 240).
- `uses the launched record summary for prices...` (line 243) — same 10+5 gwei prices; its `toBe('15 gwei')` per-Task assertion (line 256) **will fail**. Update to `.toBe('2027.5 gwei')`.
- The other tests (safe-balance / address / `unavailable` / error / no-manifest) do not assert per-Task or runway and should stay green.

Make those two assertion edits (lines ~236 and ~256), re-run, expect PASS.

- [ ] **Step 4: Commit**

```bash
git add "client/src/dashboard/spa/src/pages/launcher-launched/SpendPanel.test.tsx"
git commit -m "test(launcher): SpendPanel runway numbers go gas-inclusive (#573)"
```

---

### Task 4: SpendPanel — verify no render-logic change is needed for AC2

**Files:**
- Read-only check: `client/src/dashboard/spa/src/pages/launcher-launched/SpendPanel.tsx:74-78,133-151`

- [ ] **Step 1: Confirm SpendPanel already renders the projection fields**

`SpendPanel.tsx:74-78` calls `projectRunwayTasks(safeBalanceWei, solutionPriceWei, verdictPriceWei)` (no 4th arg → uses the new `DEFAULT_CLAIM_GAS_WEI`). Lines 133-151 render `projection.perTaskWei` (Per-Task cost field) and `projection.tasks` (Projected runway field). Because the per-Task math now lives in `projectRunwayTasks`, **no logic change is required here for AC1/AC2** — the panel transparently shows the gas-inclusive numbers. Task 3's green tests are the proof. No commit for this task.

---

### Task 5: SpendPanel — failing test for the low-runway state message (AC3)

**Files:**
- Modify: `client/src/dashboard/spa/src/pages/launcher-launched/SpendPanel.test.tsx` (add two `it` blocks)

- [ ] **Step 1: Add the low-runway render tests**

Add these two tests inside the `describe('SpendPanel', ...)` block (e.g. directly after the rewritten runway test):

```ts
  it('surfaces a low-runway state message below 100 Tasks', async () => {
    const fetchLauncherStatus = vi.fn().mockResolvedValue(
      // 99 × per-Task cost (3_512_500_000_000) = 347_737_500_000_000.
      buildStatusResponse('Polymarket', '347737500000000'),
    );
    wrap(
      <SpendPanel
        record={buildRecord()}
        manifest={buildManifest({
          solutionPriceWei: '1000000000000',
          verdictPriceWei: '500000000000',
        })}
        fetchLauncherStatus={fetchLauncherStatus}
      />,
    );
    await waitFor(() =>
      expect(
        screen.getByTestId('launcher-launched-spend-low-runway'),
      ).toBeTruthy(),
    );
    expect(
      screen.getByTestId('launcher-launched-spend-low-runway').textContent,
    ).toMatch(/runway low/i);
  });

  it('hides the low-runway message at or above 100 Tasks', async () => {
    const fetchLauncherStatus = vi.fn().mockResolvedValue(
      // 100 × per-Task cost = 351_250_000_000_000.
      buildStatusResponse('Polymarket', '351250000000000'),
    );
    wrap(
      <SpendPanel
        record={buildRecord()}
        manifest={buildManifest({
          solutionPriceWei: '1000000000000',
          verdictPriceWei: '500000000000',
        })}
        fetchLauncherStatus={fetchLauncherStatus}
      />,
    );
    await waitFor(() =>
      expect(
        screen.getByTestId('launcher-launched-spend-runway').textContent,
      ).toContain('100 Tasks'),
    );
    expect(
      screen.queryByTestId('launcher-launched-spend-low-runway'),
    ).toBeNull();
  });
```

- [ ] **Step 2: Run to verify both new tests fail**

Run (from `client/`): `yarn vitest run src/dashboard/spa/src/pages/launcher-launched/SpendPanel.test.tsx --reporter verbose`
Expected: the `surfaces a low-runway state message...` test FAILS — there is no `launcher-launched-spend-low-runway` element yet. (The `hides...` test passes vacuously since `queryByTestId` returns null — that is fine; it locks the absence path.)

- [ ] **Step 3: Commit the failing test**

```bash
git add "client/src/dashboard/spa/src/pages/launcher-launched/SpendPanel.test.tsx"
git commit -m "test(launcher): failing low-runway state-message test (#573)"
```

---

### Task 6: SpendPanel — render the low-runway state message (AC3)

**Files:**
- Modify: `client/src/dashboard/spa/src/pages/launcher-launched/SpendPanel.tsx:154-166`

- [ ] **Step 1: Add the low-runway message inside the Card**

In `SpendPanel.tsx`, insert a new block immediately AFTER the existing `{isError && (...)}` span (currently lines 154-161) and BEFORE the caveat `<p>` (currently line 163):

```tsx
        {projection?.lowRunway && (
          <span
            data-testid="launcher-launched-spend-low-runway"
            className="font-mono text-[12px] text-[var(--wane)]"
          >
            Runway low — under {LOW_RUNWAY_TASKS.toLocaleString()} Tasks remain
            at current prices. Top up the Safe from the Overview wallet faucet;
            this panel has no local top-up action.
          </span>
        )}
```

- [ ] **Step 2: Import `LOW_RUNWAY_TASKS`**

Update the helpers import at `SpendPanel.tsx:15` from:

```tsx
import { formatWeiAmount, projectRunwayTasks, truncateAddress } from './helpers.js';
```

to:

```tsx
import {
  formatWeiAmount,
  projectRunwayTasks,
  truncateAddress,
  LOW_RUNWAY_TASKS,
} from './helpers.js';
```

- [ ] **Step 3: Run the SpendPanel test to verify all pass**

Run (from `client/`): `yarn vitest run src/dashboard/spa/src/pages/launcher-launched/SpendPanel.test.tsx --reporter verbose`
Expected: PASS — including both Task 5 low-runway tests.

- [ ] **Step 4: Typecheck**

Run (from `client/`): `yarn typecheck`
Expected: zero errors.

- [ ] **Step 5: Commit**

```bash
git add "client/src/dashboard/spa/src/pages/launcher-launched/SpendPanel.tsx"
git commit -m "fix(launcher): surface low-runway state message under 100 Tasks (#573)"
```

---

### Task 7: OPERATOR-APP-SPEC — add the "Spend & runway" sub-entry (spec, same PR)

**Files:**
- Modify: `client/OPERATOR-APP-SPEC.md:357` (§2.13 Launcher bullet)

- [ ] **Step 1: Append a Spend & runway sub-entry to the Launcher bullet**

In `client/OPERATOR-APP-SPEC.md`, the §2.13 Launcher bullet ends at line 357. Append, as a nested sub-entry under the **Launcher** bullet (after the existing per-row recent-posts sentence), the following four-axis description:

```markdown
  - **Spend & runway** (per launched-SolverNet detail view; `SpendPanel.tsx`).
    - **State** — Safe address, Safe balance, solution price, verdict price, **per-Task cost** (`solutionPriceWei + verdictPriceWei + claim-tx gas`), and **projected runway** (Safe balance ÷ per-Task cost, in Tasks at current prices). The claim-tx gas term is a fixed honest-conservative estimate (~175,000 gas × ~0.0115 gwei ≈ 2,000 gwei/claim, #573); there is no live gas feed in the SPA. Excluding it previously over-stated runway by ~100× (133,333 vs ~1,000 Tasks).
    - **State messages** — `runway low` — **info** severity. Raised when projected runway is under 100 Tasks. Maps to **no local action**: top-up lives on §2.3 Funds' operator-wallet faucet, not this panel. Distinct from §2.3 Funds' own `runway low` (which is about the operator's gas wallet, not the launcher Safe's Task budget).
    - **Collections** — none.
    - **Actions** — none; read-only projection.
```

(Place it as a sibling sub-bullet under **Launcher**, mirroring how §2.14 Generator panel is described as a launched-detail panel. Keep two-space indentation to nest under the `- **Launcher**` list item.)

- [ ] **Step 2: Verify the spec still reads coherently**

Read `client/OPERATOR-APP-SPEC.md:353-378` and confirm the new sub-entry sits inside §2.13, uses only the three sanctioned severities (info), and explicitly states the distinct-from-§2.3 relationship and the no-local-action mapping. No emoji.

- [ ] **Step 3: Commit**

```bash
git add "client/OPERATOR-APP-SPEC.md"
git commit -m "docs(operator-app-spec): add Spend & runway sub-entry to §2.13 (#573)"
```

---

### Task 8: Full verification pass

- [ ] **Step 1: Run both affected test files together**

Run (from `client/`):
`yarn vitest run src/dashboard/spa/src/pages/launcher-launched/helpers.test.ts src/dashboard/spa/src/pages/launcher-launched/SpendPanel.test.tsx --reporter verbose`
Expected: ALL pass (node project picks up helpers.test.ts, spa-jsdom picks up SpendPanel.test.tsx).

- [ ] **Step 2: Typecheck the whole client**

Run (from `client/`): `yarn typecheck`
Expected: zero errors.

- [ ] **Step 3: Run the full launcher-launched suite to catch collateral breakage**

Run (from `client/`): `yarn vitest run src/dashboard/spa/src/pages/launcher-launched`
Expected: ALL pass (GeneratorPanel, PauseRetireDialog, StatusHeader, TasksPanel, SpendPanel).

- [ ] **Step 4: Confirm acceptance criteria are met**

- AC1 — `projectRunwayTasks` folds `claimGasWei` (default `DEFAULT_CLAIM_GAS_WEI`) into `perTaskWei` (Task 2; proven by Task 1's `folds the claim-tx gas term` + `no longer returns 133,333` tests).
- AC2 — SpendPanel's Per-Task cost and Projected runway fields render the gas-inclusive numbers (Task 4 verification; proven by Task 3's `4 Tasks` / per-Task assertions).
- AC3 — low-runway `runway low` state message renders under 100 Tasks and is absent at/above 100 (Tasks 5+6).

---

## Self-Review

**Spec coverage:**
- AC1 → Tasks 1, 2. ✔
- AC2 → Tasks 3, 4. ✔
- AC3 → Tasks 5, 6. ✔
- Spec update (same PR) → Task 7. ✔
- Regression-test-first (fix shape) → Task 1 writes the failing helpers regression before Task 2's impl; Task 3 converts the existing breaking test into the AC2 proof; Task 5 fails before Task 6. ✔

**Placeholder scan:** No TBD/TODO/"handle edge cases"/"similar to". Every code step shows full code. ✔

**Type consistency:** `projectRunwayTasks` return shape `{ tasks: number; perTaskWei: bigint; lowRunway: boolean }` is identical across Task 1 (test), Task 2 (impl), and Task 6 (`projection?.lowRunway`). Constants `CLAIM_TX_GAS` / `CLAIM_GAS_PRICE_WEI` / `DEFAULT_CLAIM_GAS_WEI` / `LOW_RUNWAY_TASKS` named identically in helpers.ts, helpers.test.ts, and SpendPanel.tsx import. ✔

**Known-fragile assertion:** the `3,512.5 gwei` / `2027.5 gwei` per-Task strings depend on `formatWeiAmount`'s exact gwei formatting — Task 3 Step 1/Step 3 explicitly instruct verifying the rendered string and adjusting the assertion if the thousands-separator differs. The load-bearing `N Tasks` runway assertions are separator-free. ✔
