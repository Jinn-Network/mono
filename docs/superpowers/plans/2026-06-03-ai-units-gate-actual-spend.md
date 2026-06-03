# AI-units Gate — Meter Actual USD Spend (issue #1004) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the #815 claim gate compare a per-credential **actual USD** accumulator against a USD ceiling, so the throttle bounds real token spend instead of a flat per-task projection.

**Architecture:** The honest-cost path already exists end to end (`usage.ts` harvests real cost → `record.ts` writes `actual_cost_usd_micros` + `claim_status='delivered'`). The bug is that the accumulator (`aiUnitsThisBlock/Week`) sums the *projection* column `ai_units`, never the delivered cost. We switch the accumulator and the gate comparison to USD-micros: sum `COALESCE(actual_cost_usd_micros, estimated_cost_usd_micros, 0)` over `claim_status IN ('claimed','delivered')` (delivered rows contribute real cost; in-flight claimed rows contribute their estimate; failed claims contribute 0). The ceiling is derived from the existing peg (`units × GPT_5_4_MINI_USD_PER_BLOCK ÷ 100`) so the default 100 units/block = $0.50/block ($14/week) — calibration preserved, only the comparison unit changes.

**SCOPE (decided by coordinator + user):** Daemon/API only. **Do NOT edit `client/src/dashboard/`** — the SPA changes are spun out to **#1006**. The `/v1/status` payload **must stay backward-compatible**: keep the existing unit-denominated `aiUnits` fields the SPA reads today (`unitsThisBlock`, `unitsThisWeek`, `capPerBlock`, `capPerWeek`), but derive them from the new USD accumulator via the peg so the displayed numbers track the real gate. **Additionally** add USD fields + an `estimated: boolean` flag to the payload for #1006 to consume. Keep `GPT_5_4_MINI_USD_PER_BLOCK` exported (the SPA's `HarnessFootprintPanel.tsx` imports it). Tag legacy unit fields with a `// #1006:` comment so the follow-up is discoverable.

**Tech Stack:** TypeScript, Vitest, better-sqlite3 (synchronous), viem (not touched here).

---

## File Structure

| File | Responsibility | Change |
|---|---|---|
| `client/src/store/store.ts` | SQLite aggregation. | **Add** USD-micros accumulators `usdMicrosThisBlock` / `usdMicrosThisWeek` (sum `COALESCE(actual, estimated, 0)`), each returning `{ usdMicros, estimated }` where `estimated` is true iff any contributing row lacked `actual_cost_usd_micros`. Keep `aiUnitsThisBlock/Week` (SPA-facing via status). Update `finalizeClaimDelivered` comment. |
| `client/src/spend/ai-units.ts` | Calibration + projection. | **Add** `REFERENCE_CEILING_USD_MICROS` (block/week, derived from peg), `projectTaskUsdMicros(harness, model, cred?)`, `resolveReferenceCeilingUsdMicros(env)`. Keep `GPT_5_4_MINI_USD_PER_BLOCK`, `projectAiUnits`, `REFERENCE_CEILING`, `resolveReferenceCeiling` (SPA + status still use units). Add proxy-budget caveat comment. |
| `client/src/spend/ai-units-config.ts` | Build daemon gate config. | **Add** USD caps + `manifestProjectedUsdMicros` to `AiUnitsDaemonConfig`, keep unit caps + `manifestProjectedAiUnits`. |
| `client/src/daemon/ai-units-gate.ts` | Pure decision fn. | Switch the comparison to USD: rename gate args to `projectedUsdMicros` / `usdMicrosThisBlock` / `usdMicrosThisWeek` / `capPerBlockUsdMicros` / `capPerWeekUsdMicros`; retain memo/pause/event/hydration logic verbatim. Reason string in USD. |
| `client/src/daemon/daemon.ts` | Claim-site wiring. | Pass USD accumulator + USD projection + USD caps to the gate; keep writing `aiUnits` + `estimatedCostUsdMicros` on the row (the latter now comes straight from the USD projection, dropping the peg-inversion). |
| `client/src/spend/record.ts` | Per-run cost record. | Replace the "never recomputed" comment with the proxy-budget caveat. |
| `client/src/api/status-build.ts` | Status payload shape. | **Add** USD fields (`usdMicrosThisBlock`, `usdMicrosThisWeek`, `capPerBlockUsdMicros`, `capPerWeekUsdMicros`, `estimated`) to `AiUnitsCredentialRow`; keep unit fields (mark `// #1006`). |
| `client/src/api/gather-status.ts` | Status payload assembly. | Populate the new USD fields + `estimated` from the USD accumulator; derive the legacy unit fields from the USD accumulator via the peg. |
| `client/src/main.ts` | Boot log. | Reads `aiUnits.capPerBlock/capPerWeek` (units) for its log line — **unchanged** if unit caps are retained on the config. Verify only. |

`usage.ts`, `cost-estimates.ts`, `pricing.ts` need **no change** — they already produce the USD the accumulator now reads.

---

## Deviations from the Stage-1 design note (read before starting)

The design note proposed *renaming* `AiUnitsDaemonConfig` and the `/v1/status` payload fields to USD wholesale. That breaks the SPA, which is out of scope here. This plan therefore **keeps the unit-denominated config field names and status payload fields** (the SPA's contract) and **adds** USD alongside them. Only the *gate's internal comparison* and the *store accumulator it reads* move to USD. `main.ts` keeps logging the unit caps unchanged. Everything else in the note holds.

---

## Task 1: USD accumulator in the store (regression test FIRST)

This is the load-bearing fix: the accumulator must sum delivered actual cost, not the projection column.

**Files:**
- Modify: `client/src/store/store.ts` (add `usdMicrosThisBlock` / `usdMicrosThisWeek` near `aiUnitsThisBlock`, ~line 1332; update `finalizeClaimDelivered` comment ~line 1396)
- Test: `client/test/store/ai-units-sums.test.ts`

- [ ] **Step 1: Write the failing regression test**

Append to `client/test/store/ai-units-sums.test.ts`:

```typescript
describe('usdMicrosThisBlock / usdMicrosThisWeek (issue #1004 — actual-spend accumulator)', () => {
  let store: Store;
  afterEach(() => store?.close());

  it('sums actual_cost_usd_micros for delivered rows in the current 6h block', () => {
    store = freshStore();
    const now = new Date('2026-05-28T13:30:00.000Z'); // 12:00-18:00 block
    const inBlock = new Date('2026-05-28T13:00:00.000Z');
    // A delivered row carries the real harvested cost.
    store.recordActivityEvent({
      ts: inBlock.toISOString(),
      kind: 'claimed',
      requestId: 'req-1',
      credentialId: 'anthropic:api-key',
      aiUnits: 30, // projection — must NOT be what the USD sum reads
      claimStatus: 'delivered',
      estimatedCostUsdMicros: 150_000,
      actualCostUsdMicros: 480_000, // real cost, much higher than the estimate
    });
    const r = store.usdMicrosThisBlock('anthropic:api-key', now);
    expect(r.usdMicros).toBe(480_000);
    expect(r.estimated).toBe(false);
  });

  it('falls back to estimated_cost_usd_micros for an in-flight claimed row (no actual yet)', () => {
    store = freshStore();
    const now = new Date('2026-05-28T13:30:00.000Z');
    store.recordActivityEvent({
      ts: new Date('2026-05-28T13:00:00.000Z').toISOString(),
      kind: 'claimed',
      requestId: 'req-1',
      credentialId: 'anthropic:api-key',
      aiUnits: 30,
      claimStatus: 'claimed',
      estimatedCostUsdMicros: 150_000,
      // actualCostUsdMicros omitted — claim still in flight
    });
    const r = store.usdMicrosThisBlock('anthropic:api-key', now);
    expect(r.usdMicros).toBe(150_000);
    expect(r.estimated).toBe(true); // estimate-backed contribution present
  });

  it('excludes claim_failed rows and previous-block rows', () => {
    store = freshStore();
    const now = new Date('2026-05-28T13:30:00.000Z');
    store.recordActivityEvent({
      ts: new Date('2026-05-28T13:00:00.000Z').toISOString(),
      kind: 'claim_failed',
      requestId: 'req-fail',
      credentialId: 'anthropic:api-key',
      claimStatus: 'claim_failed',
      estimatedCostUsdMicros: 999_000,
    });
    store.recordActivityEvent({
      ts: new Date('2026-05-28T11:00:00.000Z').toISOString(), // prev block
      kind: 'claimed',
      requestId: 'req-old',
      credentialId: 'anthropic:api-key',
      claimStatus: 'delivered',
      actualCostUsdMicros: 500_000,
    });
    const r = store.usdMicrosThisBlock('anthropic:api-key', now);
    expect(r.usdMicros).toBe(0);
    expect(r.estimated).toBe(false);
  });

  it('sums actual cost across the trailing 7-day window', () => {
    store = freshStore();
    const now = new Date('2026-05-28T13:00:00.000Z');
    const fiveDaysAgo = new Date(now.getTime() - 5 * 24 * 60 * 60 * 1000);
    const eightDaysAgo = new Date(now.getTime() - 8 * 24 * 60 * 60 * 1000);
    store.recordActivityEvent({
      ts: fiveDaysAgo.toISOString(),
      kind: 'claimed',
      requestId: 'req-1',
      credentialId: 'anthropic:api-key',
      claimStatus: 'delivered',
      actualCostUsdMicros: 200_000,
    });
    store.recordActivityEvent({
      ts: eightDaysAgo.toISOString(),
      kind: 'claimed',
      requestId: 'req-2',
      credentialId: 'anthropic:api-key',
      claimStatus: 'delivered',
      actualCostUsdMicros: 500_000,
    });
    const r = store.usdMicrosThisWeek('anthropic:api-key', now);
    expect(r.usdMicros).toBe(200_000);
    expect(r.estimated).toBe(false);
  });

  it('returns zero / not-estimated for an unknown credential', () => {
    store = freshStore();
    expect(store.usdMicrosThisWeek('nobody:none', new Date())).toEqual({
      usdMicros: 0,
      estimated: false,
    });
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd client && yarn vitest run test/store/ai-units-sums.test.ts -t "actual-spend accumulator"`
Expected: FAIL — `store.usdMicrosThisBlock is not a function`.

- [ ] **Step 3: Implement the USD accumulators**

In `client/src/store/store.ts`, immediately after `aiUnitsThisWeek` (currently ends ~line 1367), add:

```typescript
  /**
   * Actual-spend accumulator for the current 6h UTC block (issue #1004).
   *
   * Sums `COALESCE(actual_cost_usd_micros, estimated_cost_usd_micros, 0)`
   * over rows whose `claim_status` is `'claimed'` or `'delivered'`:
   *   - delivered rows contribute the real harvested cost (`actual_*`),
   *   - in-flight claimed rows contribute their estimate so a burst of
   *     concurrent claims cannot slip the cap before any of them deliver,
   *   - failed claims (status `'claim_failed'`) are excluded.
   *
   * `estimated` is true iff any contributing row lacked
   * `actual_cost_usd_micros` (in-flight claims, or a harness with no usage
   * telemetry such as Hermes whose delivered rows are estimate-only). The
   * gate surfaces this so an estimate-backed figure is not presented as
   * metered. Block boundaries mirror `aiUnitsThisBlock`.
   */
  usdMicrosThisBlock(
    credentialId: string,
    now: Date = new Date(),
  ): { usdMicros: number; estimated: boolean } {
    const startOfDay = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
    const sinceDayStart = now.getTime() - startOfDay;
    const sixHoursMs = 6 * 60 * 60 * 1_000;
    const blocksIn = Math.min(Math.floor(sinceDayStart / sixHoursMs), 3);
    const blockStart = new Date(startOfDay + blocksIn * sixHoursMs).toISOString();
    const blockEnd = new Date(startOfDay + (blocksIn + 1) * sixHoursMs).toISOString();
    return this.sumUsdMicros(credentialId, blockStart, blockEnd);
  }

  /**
   * Actual-spend accumulator for the trailing 7-day rolling window from
   * `now` (issue #1004). Same COALESCE + claim_status filter + `estimated`
   * semantics as {@link usdMicrosThisBlock}.
   */
  usdMicrosThisWeek(
    credentialId: string,
    now: Date = new Date(),
  ): { usdMicros: number; estimated: boolean } {
    const weekStart = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1_000).toISOString();
    return this.sumUsdMicros(credentialId, weekStart, undefined);
  }

  /** Shared COALESCE-sum + estimate-flag query for the USD accumulators. */
  private sumUsdMicros(
    credentialId: string,
    fromIso: string,
    toIso: string | undefined,
  ): { usdMicros: number; estimated: boolean } {
    const upper = toIso ? 'AND ts < @to' : '';
    const row = this.db
      .prepare(
        `SELECT
           COALESCE(SUM(COALESCE(actual_cost_usd_micros, estimated_cost_usd_micros, 0)), 0) AS total,
           COALESCE(SUM(CASE WHEN actual_cost_usd_micros IS NULL THEN 1 ELSE 0 END), 0) AS estimatedRows
         FROM activity_events
         WHERE credential_id = @cid
           AND ts IS NOT NULL AND ts >= @from ${upper}
           AND claim_status IN ('claimed', 'delivered')`,
      )
      .get({ cid: credentialId, from: fromIso, to: toIso }) as {
        total: number;
        estimatedRows: number;
      };
    return { usdMicros: row.total ?? 0, estimated: (row.estimatedRows ?? 0) > 0 };
  }
```

- [ ] **Step 4: Update the `finalizeClaimDelivered` comment**

In `client/src/store/store.ts`, replace the doc comment on `finalizeClaimDelivered` (currently ~lines 1396-1402) so it states the proxy-budget caveat:

```typescript
  /**
   * Mark the per-request `claimed` row as `delivered` and record
   * `actual_cost_usd_micros` (issue #1004 — the gate's accumulator now
   * reads this column via COALESCE, so a delivered row's real harvested
   * cost replaces its claim-time estimate in the running total). The
   * `ai_units` projection captured at claim time is intentionally NOT
   * recomputed — it remains the per-task estimate for the legacy unit
   * surfaces. For subscription credentials the resulting USD figure is a
   * *proxy* budget, not an exact bound on the provider's plan quota.
   * Idempotent: a no-op when no `claimed` row exists.
   */
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `cd client && yarn vitest run test/store/ai-units-sums.test.ts`
Expected: PASS (new block + all pre-existing `aiUnitsThisBlock/Week`/`finalizeClaimDelivered` tests still green).

- [ ] **Step 6: Commit**

```bash
git add client/src/store/store.ts client/test/store/ai-units-sums.test.ts
git commit -m "fix(spend): sum actual USD spend in the store accumulator (#1004)"
```

---

## Task 2: USD ceiling + USD projection in `ai-units.ts`

**Files:**
- Modify: `client/src/spend/ai-units.ts`
- Test: `client/test/spend/ai-units.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `client/test/spend/ai-units.test.ts`. First extend the import:

```typescript
import {
  GPT_5_4_MINI_USD_PER_BLOCK,
  REFERENCE_CEILING,
  REFERENCE_CEILING_USD_MICROS,
  projectAiUnits,
  projectTaskUsdMicros,
  resolveReferenceCeiling,
  resolveReferenceCeilingUsdMicros,
} from '../../src/spend/ai-units.js';
```

Then add:

```typescript
describe('USD ceiling + projection (issue #1004)', () => {
  it('REFERENCE_CEILING_USD_MICROS pegs 100 units/block to $0.50/block', () => {
    // 100 units / 100 * GPT_5_4_MINI_USD_PER_BLOCK ($0.5) = $0.50 = 500_000 micros.
    expect(REFERENCE_CEILING_USD_MICROS.usd_micros_per_block).toBe(500_000);
    // Weekly = 28 blocks => $14 => 14_000_000 micros.
    expect(REFERENCE_CEILING_USD_MICROS.usd_micros_per_week).toBe(14_000_000);
  });

  it('projectTaskUsdMicros returns the per-task USD estimate in micros for a priced paid harness', () => {
    // gpt-5.4-mini @ 50k input + 20k output = 0.0525 USD => 52_500 micros.
    expect(projectTaskUsdMicros('hermes-agent', 'gpt-5.4-mini')).toBe(52_500);
  });

  it('projectTaskUsdMicros returns 0 for a non-LLM harness and null for an unpriceable model', () => {
    expect(projectTaskUsdMicros('prediction-v1-baseline', undefined)).toBe(0);
    expect(projectTaskUsdMicros('hermes-agent', 'no-such-model-xyz')).toBeNull();
  });

  it('resolveReferenceCeilingUsdMicros honours JINN_AI_UNITS_CEILING_OVERRIDE via the peg', () => {
    // Override 10 units/block => $0.05/block => 50_000 micros; weekly 28x.
    const out = resolveReferenceCeilingUsdMicros({ JINN_AI_UNITS_CEILING_OVERRIDE: '10' });
    expect(out.usd_micros_per_block).toBe(50_000);
    expect(out.usd_micros_per_week).toBe(50_000 * 28);
  });

  it('resolveReferenceCeilingUsdMicros falls back to the baked-in USD ceiling on a missing override', () => {
    expect(resolveReferenceCeilingUsdMicros({})).toEqual(REFERENCE_CEILING_USD_MICROS);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd client && yarn vitest run test/spend/ai-units.test.ts -t "issue #1004"`
Expected: FAIL — `REFERENCE_CEILING_USD_MICROS`/`projectTaskUsdMicros`/`resolveReferenceCeilingUsdMicros` not exported.

- [ ] **Step 3: Implement in `client/src/spend/ai-units.ts`**

`GPT_5_4_MINI_USD_PER_BLOCK` and `REFERENCE_CEILING` stay exactly as-is (SPA + status read them). Add a one-line caveat to the `GPT_5_4_MINI_USD_PER_BLOCK` doc block and the module header noting the comparison now runs in USD and the figure is a *proxy* budget for subscriptions.

After `export const REFERENCE_CEILING = …` (ends ~line 52) add the peg-derived USD ceiling:

```typescript
/**
 * USD-micros ceiling (issue #1004). The gate now compares **actual USD
 * spend** against this ceiling rather than projected AI units. Derived
 * directly from {@link REFERENCE_CEILING} through the GPT-5.4-mini peg:
 *   usd_micros = units / 100 * GPT_5_4_MINI_USD_PER_BLOCK * 1_000_000.
 * Default 100 units/block => $0.50/block (500_000 micros); 2800 units/week
 * => $14/week (14_000_000 micros). Calibration is preserved; only the
 * comparison unit changed. For subscription credentials this USD budget is
 * a *proxy* — it bounds Jinn-attributable model cost, not the provider's
 * plan quota directly.
 */
export const REFERENCE_CEILING_USD_MICROS: {
  readonly usd_micros_per_block: number;
  readonly usd_micros_per_week: number;
} = {
  usd_micros_per_block: unitsToUsdMicros(REFERENCE_CEILING.units_per_block),
  usd_micros_per_week: unitsToUsdMicros(REFERENCE_CEILING.units_per_week),
};

/** Convert an AI-unit count to USD micros through the GPT-5.4-mini peg. */
function unitsToUsdMicros(units: number): number {
  return Math.round((units / 100) * GPT_5_4_MINI_USD_PER_BLOCK * 1_000_000);
}
```

After `projectAiUnits` (ends ~line 98) add the USD projection. It mirrors `projectAiUnits` but returns micros directly from the cost table (no peg round-trip), so the per-claim debit is the honest per-model estimate:

```typescript
/**
 * Project the per-task cost of one harness/model combination in USD micros
 * (issue #1004). This is the in-flight debit the gate books for a claim
 * before its actual cost is harvested. Same harness classification as
 * {@link projectAiUnits}:
 *   - `0` for harnesses that make no marginal LLM call,
 *   - `null` when a paid-LLM harness's model is unknown to the cost table
 *     (gate fails open with a warn),
 *   - otherwise `round(estimateModelCost(model).usd * 1_000_000)`.
 *
 * `_credentialId` does not change the projection (the model costs the same
 * regardless of auth path); it labels the accounting bucket only.
 */
export function projectTaskUsdMicros(
  harness: string | undefined,
  model: string | undefined,
  _credentialId?: string | null,
): number | null {
  if (!harness) return null;
  const canonical = canonicalHarnessName(harness);
  const isPaidLlmHarness =
    canonical === CLAUDE_CODE_HARNESS ||
    canonical === CODEX_HARNESS ||
    canonical === HERMES_AGENT_HARNESS;
  if (!isPaidLlmHarness) return 0;
  if (!model) return null;
  const cost = estimateModelCost(model);
  if (!cost) return null;
  return Math.round(cost.usd * 1_000_000);
}
```

After `resolveReferenceCeiling` (ends ~line 134) add the USD resolver, reusing the unit resolver so override parsing stays single-sourced:

```typescript
/**
 * Resolve the active USD-micros ceiling from env (issue #1004). Reuses
 * {@link resolveReferenceCeiling} so the `JINN_AI_UNITS_CEILING_OVERRIDE`
 * parsing (integer or `<block>:<week>`, malformed-warn, default fallback)
 * lives in one place, then converts both bounds through the peg.
 */
export function resolveReferenceCeilingUsdMicros(
  env: NodeJS.ProcessEnv,
): { usd_micros_per_block: number; usd_micros_per_week: number } {
  const units = resolveReferenceCeiling(env);
  return {
    usd_micros_per_block: unitsToUsdMicros(units.units_per_block),
    usd_micros_per_week: unitsToUsdMicros(units.units_per_week),
  };
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd client && yarn vitest run test/spend/ai-units.test.ts`
Expected: PASS (new block + all pre-existing calibration/projection/override tests still green).

- [ ] **Step 5: Commit**

```bash
git add client/src/spend/ai-units.ts client/test/spend/ai-units.test.ts
git commit -m "fix(spend): peg-derived USD ceiling + per-task USD projection (#1004)"
```

---

## Task 3: USD caps + USD projection on the daemon gate config

**Files:**
- Modify: `client/src/spend/ai-units-config.ts`
- Test: `client/test/spend/ai-units-config.test.ts`

- [ ] **Step 1: Write the failing test**

Read the existing `ai-units-config.test.ts` first to match its `expect` style, then append:

```typescript
describe('buildAiUnitsConfig — USD fields (issue #1004)', () => {
  it('carries peg-derived USD caps and per-manifest USD projections alongside the unit fields', () => {
    const cfg = buildAiUnitsConfig(
      { joinedSolverNets: joined },
      { ANTHROPIC_API_KEY: 'x', OPENAI_API_KEY: 'y' },
    );
    expect(cfg).toBeDefined();
    // Unit caps retained for the legacy (SPA-facing) surface.
    expect(cfg!.capPerBlock).toBe(REFERENCE_CEILING.units_per_block);
    // USD caps derived from the same peg: 100 units => $0.50 => 500_000 micros.
    expect(cfg!.capPerBlockUsdMicros).toBe(500_000);
    expect(cfg!.capPerWeekUsdMicros).toBe(14_000_000);
    // Each priced paid-harness manifest gets a USD projection in micros.
    // bafycid2 = claude-code + claude-opus-4-7 (priced) => > 0.
    expect(cfg!.manifestProjectedUsdMicros['bafycid2']).toBeGreaterThan(0);
    // bafycid3 = prediction-v1-baseline (no LLM) => 0.
    expect(cfg!.manifestProjectedUsdMicros['bafycid3']).toBe(0);
  });
});
```

(Adjust the env keys / credential-resolution setup to match whatever the existing tests in this file already do — read the file's `beforeEach` first; the assertions above are the load-bearing part.)

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd client && yarn vitest run test/spend/ai-units-config.test.ts -t "USD fields"`
Expected: FAIL — `capPerBlockUsdMicros` / `manifestProjectedUsdMicros` undefined.

- [ ] **Step 3: Implement in `client/src/spend/ai-units-config.ts`**

Extend the imports:

```typescript
import {
  projectAiUnits,
  projectTaskUsdMicros,
  resolveReferenceCeiling,
  resolveReferenceCeilingUsdMicros,
} from './ai-units.js';
```

Extend the `AiUnitsDaemonConfig` interface (keep all existing fields):

```typescript
export interface AiUnitsDaemonConfig {
  /** Unit caps — retained for the legacy /v1/status unit surface (#1006). */
  capPerBlock: number;
  capPerWeek: number;
  /** USD-micros caps — what the gate now compares against (issue #1004). */
  capPerBlockUsdMicros: number;
  capPerWeekUsdMicros: number;
  manifestCredentials: Record<string, CredentialId>;
  /** manifestCid -> projected AI units/task (legacy; null = unpriceable). */
  manifestProjectedAiUnits: Record<string, number | null>;
  /** manifestCid -> projected USD micros/task (issue #1004; null = unpriceable). */
  manifestProjectedUsdMicros: Record<string, number | null>;
  manifestModels: Record<string, string | undefined>;
}
```

In `buildAiUnitsConfig`, resolve both ceilings and populate both projection maps:

```typescript
  const { units_per_block, units_per_week } = resolveReferenceCeiling(env);
  const { usd_micros_per_block, usd_micros_per_week } = resolveReferenceCeilingUsdMicros(env);

  const manifestCredentials: Record<string, CredentialId> = {};
  const manifestProjectedAiUnits: Record<string, number | null> = {};
  const manifestProjectedUsdMicros: Record<string, number | null> = {};
  const manifestModels: Record<string, string | undefined> = {};

  for (const [manifestCid, entry] of Object.entries(config.joinedSolverNets ?? {})) {
    const credentialId = resolveCredentialId(entry.harness, env, homeDirOverride);
    if (!credentialId) continue;
    manifestCredentials[manifestCid] = credentialId;
    manifestProjectedAiUnits[manifestCid] = projectAiUnits(entry.harness, entry.model, credentialId);
    manifestProjectedUsdMicros[manifestCid] = projectTaskUsdMicros(entry.harness, entry.model, credentialId);
    manifestModels[manifestCid] = entry.model;
  }

  if (Object.keys(manifestCredentials).length === 0) return undefined;

  return {
    capPerBlock: units_per_block,
    capPerWeek: units_per_week,
    capPerBlockUsdMicros: usd_micros_per_block,
    capPerWeekUsdMicros: usd_micros_per_week,
    manifestCredentials,
    manifestProjectedAiUnits,
    manifestProjectedUsdMicros,
    manifestModels,
  };
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd client && yarn vitest run test/spend/ai-units-config.test.ts`
Expected: PASS (new + pre-existing tests green).

- [ ] **Step 5: Commit**

```bash
git add client/src/spend/ai-units-config.ts client/test/spend/ai-units-config.test.ts
git commit -m "fix(spend): thread USD caps + USD projections through gate config (#1004)"
```

---

## Task 4: Gate compares USD, not units

**Files:**
- Modify: `client/src/daemon/ai-units-gate.ts`
- Test: `client/test/daemon/ai-units-gate.test.ts`

The pause/memo/hydration logic is correct and stays; only the input field names and the comparison arithmetic move to USD.

- [ ] **Step 1: Update the existing gate tests to USD args (these are the regression tests)**

In `client/test/daemon/ai-units-gate.test.ts`, rewrite every `gateClaimByAiUnits({...})` arg object: rename `projectedAiUnits`→`projectedUsdMicros`, `unitsThisBlock`→`usdMicrosThisBlock`, `unitsThisWeek`→`usdMicrosThisWeek`, `capPerBlock`→`capPerBlockUsdMicros`, `capPerWeek`→`capPerWeekUsdMicros`. Keep the *numeric relationships* identical (the cap arithmetic is unit-agnostic), e.g. the under-cap test becomes:

```typescript
  it('proceeds when projected + block-sum + week-sum are all under cap', () => {
    const logger = { warn: vi.fn(), info: vi.fn() };
    const r = gateClaimByAiUnits({
      credentialId: 'anthropic:api-key',
      projectedUsdMicros: 5,
      usdMicrosThisBlock: 10,
      usdMicrosThisWeek: 100,
      capPerBlockUsdMicros: 100,
      capPerWeekUsdMicros: 2800,
      blockId: '2026-05-28T12:00:00.000Z',
      logger,
    });
    expect(r.proceed).toBe(true);
  });
```

Apply the same rename to all remaining cases in the file (over-cap block, over-cap week, dedupe, block-rollover, hydration, restart-no-row, credential-independence) — values unchanged, field names only. The fail-open `projectedUsdMicros: null` case keeps its semantics.

- [ ] **Step 2: Run to verify the renamed tests fail against the old gate**

Run: `cd client && yarn vitest run test/daemon/ai-units-gate.test.ts`
Expected: FAIL — old gate reads `projectedAiUnits` (now `undefined`), so it fails open and the over-cap assertions break.

- [ ] **Step 3: Rename the gate's args + comparison in `client/src/daemon/ai-units-gate.ts`**

Update `AiUnitsGateArgs` (keep `AiUnitsGateWindow`, `AiUnitsGateDecision`, the memo, `hasPersistedCapReached`, `_resetAiUnitsGateMemoForTests` exactly):

```typescript
export interface AiUnitsGateArgs {
  credentialId: string;
  /** USD micros projected for the next claim, or `null` when unknown. */
  projectedUsdMicros: number | null;
  usdMicrosThisBlock: number;
  usdMicrosThisWeek: number;
  capPerBlockUsdMicros: number;
  capPerWeekUsdMicros: number;
  blockId: string;
  logger: GateLogger;
  hasPersistedCapReached?: (window: AiUnitsGateWindow, blockId: string) => boolean;
}
```

In `gateClaimByAiUnits`, swap the null-check field and the comparison:

```typescript
  if (args.projectedUsdMicros == null) {
    if (!warnedUnknownProjection.has(args.credentialId)) {
      args.logger.warn(
        `[ai-units-gate] ${args.credentialId} projection unknown for this harness/model; ` +
          'gate is fail-open (proceeding). Add the model to MODEL_COST_TABLE to enable spend gating.',
      );
      warnedUnknownProjection.add(args.credentialId);
    }
    return { proceed: true };
  }

  const projected = args.projectedUsdMicros;
  const blockTotal = args.usdMicrosThisBlock + projected;
  const weekTotal = args.usdMicrosThisWeek + projected;

  const overBlock = blockTotal > args.capPerBlockUsdMicros;
  const overWeek = weekTotal > args.capPerWeekUsdMicros;
```

Below that, update the `total`/`cap`/`reason` lines to USD and render dollars in the reason string:

```typescript
  const window: AiUnitsGateWindow = overBlock ? 'block' : 'week';
  const total = window === 'block' ? blockTotal : weekTotal;
  const cap = window === 'block' ? args.capPerBlockUsdMicros : args.capPerWeekUsdMicros;
  const reason =
    `Spend ${window} cap reached for ${args.credentialId} ` +
    `($${(total / 1_000_000).toFixed(4)} / $${(cap / 1_000_000).toFixed(4)}; ` +
    `+$${(projected / 1_000_000).toFixed(4)} projected for this claim)`;
```

Everything from `const key = memoKey(...)` downward is unchanged.

- [ ] **Step 4: Run to verify the gate tests pass**

Run: `cd client && yarn vitest run test/daemon/ai-units-gate.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add client/src/daemon/ai-units-gate.ts client/test/daemon/ai-units-gate.test.ts
git commit -m "fix(daemon): compare actual USD spend against the USD ceiling (#1004)"
```

---

## Task 5: Wire the daemon claim site to the USD gate

**Files:**
- Modify: `client/src/daemon/daemon.ts` (~lines 615-664)
- Test: `client/test/spend/ai-units-integration.test.ts`

- [ ] **Step 1: Rewrite the integration test to drive the gate on actual USD**

Replace the body of `client/test/spend/ai-units-integration.test.ts` so it exercises the USD path end to end through the store accumulator. Update the import:

```typescript
import { blockIdUtc, REFERENCE_CEILING_USD_MICROS } from '../../src/spend/ai-units.js';
```

Replace the "48h claim trace" test so each landed claim writes a *delivered* row carrying a real actual cost, and the gate reads `usdMicrosThisBlock/Week`:

```typescript
  it('48h trace: actual delivered USD spend stays within both USD caps for one credential', () => {
    store = freshStore();
    const credentialId = 'anthropic:api-key';
    const start = new Date('2026-05-25T00:00:00.000Z');
    const projectedUsdMicros = 50_000; // $0.05 projected per claim
    const actualUsdMicros = 50_000;    // delivered actual matches projection here
    const logger = { warn: vi.fn(), info: vi.fn() };
    const stepMs = 30 * 60 * 1_000;
    const totalSteps = (48 * 60) / 30;
    let claimsLanded = 0;
    let skips = 0;
    for (let i = 0; i < totalSteps; i++) {
      const now = new Date(start.getTime() + i * stepMs);
      const block = store.usdMicrosThisBlock(credentialId, now);
      const week = store.usdMicrosThisWeek(credentialId, now);
      const decision = gateClaimByAiUnits({
        credentialId,
        projectedUsdMicros,
        usdMicrosThisBlock: block.usdMicros,
        usdMicrosThisWeek: week.usdMicros,
        capPerBlockUsdMicros: REFERENCE_CEILING_USD_MICROS.usd_micros_per_block,
        capPerWeekUsdMicros: REFERENCE_CEILING_USD_MICROS.usd_micros_per_week,
        blockId: blockIdUtc(now),
        logger,
      });
      if (decision.proceed) {
        store.recordActivityEvent({
          ts: now.toISOString(),
          kind: 'claimed',
          requestId: `req-${i}`,
          credentialId,
          claimStatus: 'delivered',
          actualCostUsdMicros: actualUsdMicros,
        });
        claimsLanded++;
      } else {
        skips++;
      }
    }
    expect(claimsLanded).toBeGreaterThan(0);
    expect(skips).toBeGreaterThan(0);
    for (let b = 0; b < 8; b++) {
      const midBlock = new Date(start.getTime() + b * 6 * 60 * 60 * 1_000 + 3 * 60 * 60 * 1_000);
      expect(store.usdMicrosThisBlock(credentialId, midBlock).usdMicros).toBeLessThanOrEqual(
        REFERENCE_CEILING_USD_MICROS.usd_micros_per_block,
      );
    }
    const endOfTrace = new Date(start.getTime() + 48 * 60 * 60 * 1_000);
    expect(store.usdMicrosThisWeek(credentialId, endOfTrace).usdMicros).toBeLessThanOrEqual(
      REFERENCE_CEILING_USD_MICROS.usd_micros_per_week,
    );
  });
```

Add a dedicated **actual-spend-crosses-ceiling** test (acceptance criteria 1 + 2):

```typescript
  it('a high-actual-cost delivered run pushes the block over the USD ceiling and pauses the next claim', () => {
    store = freshStore();
    const credentialId = 'anthropic:api-key';
    const now = new Date('2026-05-28T13:00:00.000Z');
    const logger = { warn: vi.fn(), info: vi.fn() };
    // One delivered run whose ACTUAL cost ($0.60) exceeds the $0.50 block cap —
    // a flat projection would have read well under. This is the #1004 bug.
    store.recordActivityEvent({
      ts: now.toISOString(),
      kind: 'claimed',
      requestId: 'big',
      credentialId,
      claimStatus: 'delivered',
      estimatedCostUsdMicros: 50_000,
      actualCostUsdMicros: 600_000,
    });
    const block = store.usdMicrosThisBlock(credentialId, now);
    expect(block.usdMicros).toBe(600_000); // actual, not the 50_000 estimate
    const decision = gateClaimByAiUnits({
      credentialId,
      projectedUsdMicros: 50_000,
      usdMicrosThisBlock: block.usdMicros,
      usdMicrosThisWeek: store.usdMicrosThisWeek(credentialId, now).usdMicros,
      capPerBlockUsdMicros: REFERENCE_CEILING_USD_MICROS.usd_micros_per_block,
      capPerWeekUsdMicros: REFERENCE_CEILING_USD_MICROS.usd_micros_per_week,
      blockId: blockIdUtc(now),
      logger,
    });
    expect(decision.proceed).toBe(false);
  });
```

Update the "per-credential isolation" test's gate calls to the USD field names (values unchanged), and update the "restart-safety" test to assert `store.usdMicrosThisBlock(...).usdMicros` reflects the on-disk delivered row.

- [ ] **Step 2: Run to verify it fails**

Run: `cd client && yarn vitest run test/spend/ai-units-integration.test.ts`
Expected: FAIL — gate still expects unit args; `usdMicrosThisBlock` shape mismatch until the wiring is in.

- [ ] **Step 3: Rewrite the daemon claim site (`client/src/daemon/daemon.ts` ~615-664)**

Replace the AI-units gate block. The row still records `aiUnits` (legacy) + `estimatedCostUsdMicros`; the estimate now comes straight from the USD projection (drop the peg-inversion at ~lines 629-634):

```typescript
      // Spend gate (issues #815, #1004): skip claims for a credential whose
      // 6h-block or 7d-window ACTUAL USD spend + this claim's projected debit
      // would exceed the matching USD cap. The accumulator reads
      // actual_cost_usd_micros (delivered rows) / estimated_cost_usd_micros
      // (in-flight), so the gate bounds real token spend, not a flat
      // projection. For subscription credentials the USD ceiling is a *proxy*
      // budget, not an exact bound on the provider's plan quota. Layered on
      // top of the spend-cap gate below — the first guard to fire skips.
      let aiUnitsForRow: number | null = null;
      let estimatedCostUsdMicrosForRow: number | null = null;
      let modelForRow: string | null = null;
      const aiUnitsCfg = this.config.aiUnits;
      if (aiUnitsCfg && manifestCid) {
        const credentialId = aiUnitsCfg.manifestCredentials[manifestCid];
        if (credentialId) {
          // #1006: ai_units stays on the row for the legacy unit-denominated
          // /v1/status surface the SPA still reads. Remove when #1006 migrates.
          aiUnitsForRow = aiUnitsCfg.manifestProjectedAiUnits[manifestCid] ?? null;
          modelForRow = aiUnitsCfg.manifestModels[manifestCid] ?? null;
          const projectedUsdMicros = aiUnitsCfg.manifestProjectedUsdMicros[manifestCid] ?? null;
          // Capture the claim-time USD estimate on the row so the accumulator
          // has a value to read while the claim is in flight (before the
          // delivered actual replaces it via finalizeClaimDelivered).
          estimatedCostUsdMicrosForRow = projectedUsdMicros;
          const now = new Date();
          const block = this.store.usdMicrosThisBlock(credentialId, now);
          const week = this.store.usdMicrosThisWeek(credentialId, now);
          const aiGate = gateClaimByAiUnits({
            credentialId,
            projectedUsdMicros,
            usdMicrosThisBlock: block.usdMicros,
            usdMicrosThisWeek: week.usdMicros,
            capPerBlockUsdMicros: aiUnitsCfg.capPerBlockUsdMicros,
            capPerWeekUsdMicros: aiUnitsCfg.capPerWeekUsdMicros,
            blockId: blockIdUtc(now),
            logger: gateLogger,
            hasPersistedCapReached: (w, bid) =>
              this.store.hasAiUnitsCapReachedFor(credentialId, w, bid),
          });
          if (!aiGate.proceed) {
            if (aiGate.newlyPaused) {
              const marker = `[block=${blockIdUtc(now)}][window=${aiGate.window}] `;
              emitEvent(this.store, {
                kind: 'ai_units_cap_reached',
                requestId: taskAnnouncement.taskId,
                outcome: 'paused',
                detail: `${marker}${aiGate.reason}`,
                credentialId,
              }, 'daemon');
            }
            continue;
          }
        }
      }
```

Then drop the now-unused `GPT_5_4_MINI_USD_PER_BLOCK` import at line 34 if nothing else in `daemon.ts` references it (grep first; `blockIdUtc` stays).

- [ ] **Step 4: Run to verify it passes**

Run: `cd client && yarn vitest run test/spend/ai-units-integration.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add client/src/daemon/daemon.ts client/test/spend/ai-units-integration.test.ts
git commit -m "fix(daemon): gate claims on actual USD spend at the claim site (#1004)"
```

---

## Task 6: `/v1/status` — add USD fields + `estimated`, keep unit fields

**Files:**
- Modify: `client/src/api/status-build.ts` (`AiUnitsCredentialRow` ~lines 85-98)
- Modify: `client/src/api/gather-status.ts` (~lines 1393-1419)
- Test: `client/test/api/status-ai-units.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `client/test/api/status-ai-units.test.ts` a case that asserts the additive USD fields + `estimated` flag, and that the legacy unit fields still derive from the USD accumulator via the peg:

```typescript
  it('adds USD spend fields + an estimated flag while keeping the unit fields (issue #1004)', async () => {
    store = freshStore();
    const now = new Date();
    // One delivered row with a real actual cost ($0.30) and one in-flight
    // claimed row carrying only an estimate ($0.05) — so estimated must be true.
    store.recordActivityEvent({
      ts: now.toISOString(),
      kind: 'claimed',
      requestId: 'delivered-1',
      credentialId: 'anthropic:api-key',
      aiUnits: 10,
      claimStatus: 'delivered',
      actualCostUsdMicros: 300_000,
    });
    store.recordActivityEvent({
      ts: now.toISOString(),
      kind: 'claimed',
      requestId: 'inflight-1',
      credentialId: 'anthropic:api-key',
      aiUnits: 5,
      claimStatus: 'claimed',
      estimatedCostUsdMicros: 50_000,
    });
    const body = await gatherStatusForApi(store, {
      aiUnits: {
        capPerBlock: 100,
        capPerWeek: 2800,
        capPerBlockUsdMicros: 500_000,
        capPerWeekUsdMicros: 14_000_000,
        manifestCredentials: { 'cid-1': 'anthropic:api-key' },
        manifestProjectedAiUnits: { 'cid-1': 5 },
        manifestProjectedUsdMicros: { 'cid-1': 50_000 },
        manifestModels: { 'cid-1': 'claude-opus-4-7' },
      },
    });
    const row = body.aiUnits!.credentials[0];
    // USD fields present and correct.
    expect(row.usdMicrosThisBlock).toBe(350_000);
    expect(row.capPerBlockUsdMicros).toBe(500_000);
    expect(row.estimated).toBe(true); // in-flight row had no actual
    // Legacy unit fields still present, derived from USD via the peg
    // ($0.35 block / $0.50 per 100 units => 70 units).
    expect(row.unitsThisBlock).toBe(70);
    expect(row.capPerBlock).toBe(100);
  });
```

(Confirm the existing first test in this file — which seeds `aiUnits: 120` and asserts `unitsThisBlock` — is updated: under the new derivation `unitsThisBlock` comes from the USD accumulator, so that test must seed `actualCostUsdMicros`/`estimatedCostUsdMicros` instead of relying on the raw `ai_units` column, or assert on the USD fields. Adjust it to seed USD and keep its `paused` assertion.)

- [ ] **Step 2: Run to verify it fails**

Run: `cd client && yarn vitest run test/api/status-ai-units.test.ts -t "USD spend fields"`
Expected: FAIL — `usdMicrosThisBlock` / `estimated` absent from the row.

- [ ] **Step 3: Extend `AiUnitsCredentialRow` in `client/src/api/status-build.ts`**

```typescript
/** Per-credential AI-units row exposed on /v1/status (issues #815, #1004). */
export interface AiUnitsCredentialRow {
  credentialId: string;
  // #1006: legacy unit-denominated fields the SPA reads today. Derived from
  // the USD accumulator via the GPT-5.4-mini peg so they track the real gate.
  // Remove when #1006 migrates the SPA to the USD fields below.
  unitsThisBlock: number;
  unitsThisWeek: number;
  capPerBlock: number;
  capPerWeek: number;
  /** Actual USD spend this 6h block, in micros (issue #1004). */
  usdMicrosThisBlock: number;
  /** Actual USD spend this 7d window, in micros (issue #1004). */
  usdMicrosThisWeek: number;
  /** USD ceiling for the block / week, in micros (issue #1004). */
  capPerBlockUsdMicros: number;
  capPerWeekUsdMicros: number;
  /**
   * True when any contributing row lacked a harvested actual cost — the USD
   * figures are (partly) estimate-backed rather than fully metered. Always
   * true for harnesses with no usage telemetry (e.g. Hermes). Issue #1004.
   */
  estimated: boolean;
  paused: boolean;
  blockResetsAt: string;
  weekResetsAt: string;
}
```

- [ ] **Step 4: Populate them in `client/src/api/gather-status.ts` (~1393-1419)**

```typescript
  const aiUnitsCfg = status?.aiUnits;
  if (aiUnitsCfg) {
    const now = new Date();
    const blockResetsAt = blockResetsAtUtc(now).toISOString();
    const weekResetsAt = weekResetsAtUtc(now).toISOString();
    const uniqueCredentials = new Set(Object.values(aiUnitsCfg.manifestCredentials));
    // Peg: usd_micros = units / 100 * GPT_5_4_MINI_USD_PER_BLOCK * 1e6.
    // Inverse (USD micros -> units) for the legacy unit surface (#1006).
    const usdMicrosToUnits = (usdMicros: number): number =>
      (usdMicros / 1_000_000 / GPT_5_4_MINI_USD_PER_BLOCK) * 100;
    body.aiUnits = {
      credentials: [...uniqueCredentials].map((credentialId) => {
        const block = store.usdMicrosThisBlock(credentialId, now);
        const week = store.usdMicrosThisWeek(credentialId, now);
        const paused =
          block.usdMicros >= aiUnitsCfg.capPerBlockUsdMicros ||
          week.usdMicros >= aiUnitsCfg.capPerWeekUsdMicros;
        return {
          credentialId,
          // #1006: legacy unit fields, derived from USD via the peg.
          unitsThisBlock: usdMicrosToUnits(block.usdMicros),
          unitsThisWeek: usdMicrosToUnits(week.usdMicros),
          capPerBlock: aiUnitsCfg.capPerBlock,
          capPerWeek: aiUnitsCfg.capPerWeek,
          // USD fields (issue #1004).
          usdMicrosThisBlock: block.usdMicros,
          usdMicrosThisWeek: week.usdMicros,
          capPerBlockUsdMicros: aiUnitsCfg.capPerBlockUsdMicros,
          capPerWeekUsdMicros: aiUnitsCfg.capPerWeekUsdMicros,
          estimated: block.estimated || week.estimated,
          paused,
          blockResetsAt,
          weekResetsAt,
        };
      }),
    };
  }
```

Add the `GPT_5_4_MINI_USD_PER_BLOCK` import to `gather-status.ts` (it already imports `blockResetsAtUtc`/`weekResetsAtUtc` from `../spend/ai-units.js`).

- [ ] **Step 5: Run to verify it passes**

Run: `cd client && yarn vitest run test/api/status-ai-units.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add client/src/api/status-build.ts client/src/api/gather-status.ts client/test/api/status-ai-units.test.ts
git commit -m "fix(api): add USD spend + estimated flag to /v1/status, keep unit fields (#1004)"
```

---

## Task 7: Proxy-budget caveat in `record.ts` + full verification

**Files:**
- Modify: `client/src/spend/record.ts` (comment at ~lines 36-39)

- [ ] **Step 1: Replace the "never recomputed" comment**

In `client/src/spend/record.ts`, replace the comment above the `finalizeClaimDelivered` call:

```typescript
    // Issue #1004: fill actual_cost_usd_micros on the per-request claimed
    // row + set claim_status='delivered'. The gate's accumulator reads this
    // column (COALESCE actual, estimated) so the delivered actual replaces
    // the claim-time estimate in the running total. For subscription
    // credentials the resulting USD figure is a *proxy* budget — it bounds
    // Jinn-attributable model cost, not the provider's plan quota directly.
    // ai_units stays as captured at claim time (legacy unit surface, #1006).
    // Idempotent: no-op when no claimed row exists for this request id.
```

- [ ] **Step 2: Commit the comment**

```bash
git add client/src/spend/record.ts
git commit -m "docs(spend): proxy-budget caveat on the actual-spend record path (#1004)"
```

- [ ] **Step 3: Verify `main.ts` compiles unchanged**

`main.ts` reads `aiUnits.capPerBlock`/`capPerWeek` (units) for its boot log; those fields are retained, so no change is needed. Confirm:

Run: `cd client && grep -n "capPerBlock\b" src/main.ts`
Expected: the two existing references at ~2484/2488 still resolve (unit fields present on the config).

- [ ] **Step 4: Full typecheck + test suite**

Run: `cd client && yarn typecheck && yarn test`
Expected: zero type errors; all tests pass. If `server-set-status-config.test.ts` or `Overview`/SPA-side fixtures assert the `aiUnits` config shape, update only the fixture objects to include the new USD fields (do **not** touch `client/src/dashboard/` source).

- [ ] **Step 5: Final commit (if Step 4 required fixture updates)**

```bash
git add -A client/test
git commit -m "test: update aiUnits config fixtures for the USD gate (#1004)"
```

---

## Acceptance Criteria → Task Mapping

| # | Acceptance criterion | Task(s) |
|---|---|---|
| 1 | After a Codex/Claude Code run, the gate's running total reflects that run's *actual* token cost (from `usage.ts`), not a flat projection. | **Task 1** (USD accumulator sums `actual_cost_usd_micros` via COALESCE) + **Task 5** (claim site reads `usdMicrosThisBlock/Week`; `record.ts`→`finalizeClaimDelivered` already writes the actual). Proven by the "high-actual-cost delivered run" test in Task 5. |
| 2 | After accumulated *actual* cost crosses the ceiling, subsequent claims for that credential pause. | **Task 4** (gate compares USD totals vs USD caps, pause logic retained) + **Task 5** (integration test asserts `proceed: false` after a $0.60 delivered actual vs $0.50 cap). |
| 3 | Ceiling and accumulator compared in USD; the `÷0.5 ×100` indirection is no longer the comparison unit. | **Task 2** (`REFERENCE_CEILING_USD_MICROS`, `projectTaskUsdMicros`) + **Task 3** (USD caps on config) + **Task 4** (gate arithmetic in USD). The peg survives only as a calibration constant + a presentation-layer conversion for the legacy unit fields, never in the comparison. |
| 4 | For a harness with no usage telemetry (Hermes), the gate's figure is marked estimated (data half only). | **Task 1** (`estimated` flag from rows lacking `actual_cost_usd_micros`) + **Task 6** (`estimated` surfaced on `/v1/status`). The SPA rendering half is #1006. |
| 5 | A code comment/doc states the USD ceiling is a *proxy* budget for subscription credentials, not an exact quota bound. | **Task 7** (`record.ts` comment) + **Task 1** (`finalizeClaimDelivered` comment) + **Task 2** (`REFERENCE_CEILING_USD_MICROS` doc + module header). |

---

## Self-Review Notes

- **Regression test first:** Task 1 Step 1 writes the failing store test before any source change; Tasks 2-6 each open with a failing test. The load-bearing #1004 regression (actual cost crossing the ceiling) is in Task 5 Step 1.
- **Scope guard:** No step edits `client/src/dashboard/`. Unit fields (`unitsThisBlock/Week`, `capPerBlock/Week`) and `GPT_5_4_MINI_USD_PER_BLOCK` are retained because the SPA imports/reads them; USD fields are purely additive. Legacy fields carry `// #1006` markers.
- **Design-note deviations flagged:** (a) Config field names are *not* renamed to USD (kept additive) — the note's rename would break the SPA. (b) `/v1/status` keeps the unit fields. (c) `main.ts` needs no change (note implied a peg-inversion drop there; the inversion that drops is at the daemon claim site, lines ~629-634, handled in Task 5). (d) `ai-units-config.ts` gains USD fields rather than replacing unit fields.
- **`estimated` derivation:** Done at the store layer (any contributing row missing `actual_cost_usd_micros`), which is harness-agnostic and correctly marks Hermes (no harvester → all delivered rows estimate-only), in-flight claimed rows, and delivered rows that never harvested actuals. This avoids threading harness identity into the status assembler.
- **Type consistency:** Gate args use `projectedUsdMicros` / `usdMicrosThisBlock` / `usdMicrosThisWeek` / `capPerBlockUsdMicros` / `capPerWeekUsdMicros` consistently across `ai-units-gate.ts`, `daemon.ts`, and the gate tests. Store methods return `{ usdMicros, estimated }` consistently. Config carries both `manifestProjectedAiUnits` (units, `number | null`) and `manifestProjectedUsdMicros` (micros, `number | null`).
