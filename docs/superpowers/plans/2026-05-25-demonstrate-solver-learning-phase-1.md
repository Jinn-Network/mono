# Demonstrate Solver Learning — Phase 1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the network explorer tell an honest, milestone-shaped story about solver performance by (a) defaulting the explorer to envelope-truth-only verdicts (filtering out the contaminated `verdictCode=Pass` fallback), and (b) reframing two cross-SolverNet views (NetworkView, OperatorsView) so they stop presenting regime-mixing roll-ups as scores.

**Architecture:** Backend introduces a single new `includeUnenriched` query param on the affected `/explorer/*` routes and a small SQL helper change so unenriched verdicts drop from both numerator and denominator when the param is false (the default). Frontend reframes are local UI changes — same data fetches, different presentation: NetworkView loses the rolled-up "solve rate hero" and gains an honest digest list; OperatorsView loses cross-SolverNet rank and becomes a roster.

**Tech Stack:** TypeScript, Ponder 0.16.x (indexer), Drizzle ORM (via `ponder` re-export), Hono (HTTP), React 18 + Vite (SPA), Vitest, @testing-library/react.

**Tracking:** [#610](https://github.com/Jinn-Network/mono/issues/610) (parent EPIC: [#601](https://github.com/Jinn-Network/mono/issues/601)). Spec: [`spec/2026-05-25-demonstrate-solver-learning.md`](../../../spec/2026-05-25-demonstrate-solver-learning.md).

---

## File Structure

**Modify:**
- `packages/indexer/src/api/explorer.ts` — add `parseBoolParam` helper, extend `verdictTruthPassCountSql` + `verdictTruth` with a `strict` mode (no `verdictCode` fallback), thread `includeUnenriched` into `/network` and `/solvernet/:cid` route bodies. Add an `enrichmentFilter` SQL fragment used as a WHERE clause when strict.
- `packages/indexer/test/metrics.test.ts` — add boundary tests for the new strict-mode behaviour.
- `packages/indexer/explorer/src/lib/api.ts` — extend `useNetwork()` and `useSolverNet()` hook signatures with optional `includeUnenriched: boolean`.
- `packages/indexer/explorer/src/views/NetworkView.tsx` — remove the `SolveHero` section; render `NetworkFactsRow` (4 KPI panels) + the existing SolverNet digest list (using `useSolverNets()` for the list, kept as today).
- `packages/indexer/explorer/src/views/NetworkView.test.tsx` — assert: no "Solve rate" hero, no `data-testid="network-solve-rate"`, presence of the 4 facts.
- `packages/indexer/explorer/src/views/OperatorsView.tsx` — drop the `rank` column and any "ranked vs lowVolume" partitioning; render a single roster table with `attempts`, `jinnEarned`, and a chip strip of SolverNets the operator's participated in.
- `packages/indexer/explorer/src/views/OperatorsView.test.tsx` — assert: no `rank` column header, no cross-net `resolvedRate` column at the top level, presence of SolverNet chip strip.

**Create:**
- `packages/indexer/explorer/src/components/NetworkFactsRow.tsx` — small presentational component rendering 4 KPI panels (distinct operators, JINN distributed, SolverNets running, most-recent settlement). Reuses the existing `Kpi` and `Card` components from `packages/indexer/explorer/src/components/`.
- `packages/indexer/explorer/src/components/NetworkFactsRow.test.tsx` — unit test for the component.

**Do not touch:**
- `packages/indexer/explorer/src/views/SolverNetView.tsx` — its visible behaviour changes only because the default backend filter is stricter; no UI work in this phase.
- `packages/indexer/explorer/src/components/LearningCurve.tsx`, `Leaderboard.tsx`, `Sparkline.tsx`, `Kpi.tsx`, `Card.tsx`, `HBars.tsx` — stay as-is; they're rendered with different data, not different code.
- `packages/indexer/explorer/src/views/OperatorView.tsx` (per-operator detail) — already correctly shaped per spec §5.5.

---

## Task 1: Add `parseBoolParam` helper to explorer.ts

**Files:**
- Modify: `packages/indexer/src/api/explorer.ts:109-126` (insert after `parseBigIntParam`).
- Test: `packages/indexer/test/metrics.test.ts` (add new `describe('parseBoolParam')` block at the bottom).

- [ ] **Step 1: Write the failing test**

Append to `packages/indexer/test/metrics.test.ts`:

```ts
import { parseBoolParam } from '../src/api/explorer.js';

describe('parseBoolParam', () => {
  it('returns the default when the param is missing', () => {
    expect(parseBoolParam(undefined, false)).toBe(false);
    expect(parseBoolParam(undefined, true)).toBe(true);
  });

  it('treats "true", "1", "yes" as true (case-insensitive)', () => {
    expect(parseBoolParam('true', false)).toBe(true);
    expect(parseBoolParam('TRUE', false)).toBe(true);
    expect(parseBoolParam('1', false)).toBe(true);
    expect(parseBoolParam('yes', false)).toBe(true);
  });

  it('treats "false", "0", "no" as false (case-insensitive)', () => {
    expect(parseBoolParam('false', true)).toBe(false);
    expect(parseBoolParam('FALSE', true)).toBe(false);
    expect(parseBoolParam('0', true)).toBe(false);
    expect(parseBoolParam('no', true)).toBe(false);
  });

  it('falls back to the default for unparseable input', () => {
    expect(parseBoolParam('maybe', false)).toBe(false);
    expect(parseBoolParam('maybe', true)).toBe(true);
    expect(parseBoolParam('', false)).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/indexer && yarn vitest run test/metrics.test.ts -t parseBoolParam`
Expected: FAIL with "parseBoolParam is not a function" or similar import error.

- [ ] **Step 3: Implement `parseBoolParam` and export it**

Insert after the `parseBigIntParam` function in `packages/indexer/src/api/explorer.ts` (around line 126):

```ts
/**
 * Parse a boolean query param; fall back to `def` if missing or unrecognized.
 * Recognises "true"/"1"/"yes" as true and "false"/"0"/"no" as false (case-insensitive).
 * Exported for unit tests.
 */
export function parseBoolParam(raw: string | undefined, def: boolean): boolean {
  if (raw === undefined) return def;
  const v = raw.toLowerCase();
  if (v === 'true' || v === '1' || v === 'yes') return true;
  if (v === 'false' || v === '0' || v === 'no') return false;
  return def;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd packages/indexer && yarn vitest run test/metrics.test.ts -t parseBoolParam`
Expected: PASS — 4 tests.

- [ ] **Step 5: Commit**

```bash
git add packages/indexer/src/api/explorer.ts packages/indexer/test/metrics.test.ts
git commit -m "feat(indexer): add parseBoolParam helper for explorer routes (#610)"
```

---

## Task 2: Extend `verdictTruth` and `verdictTruthPassCountSql` with strict mode

**Files:**
- Modify: `packages/indexer/src/api/explorer.ts:194-227` (the `verdictTruth` block).
- Test: `packages/indexer/test/metrics.test.ts` (add `describe('verdictTruth strict mode')`).

In strict mode, a verdict counts only when `enrichmentStatus === 'ok'`. There is no `verdictCode === 1` fallback. The SQL helper returns NULL (excluded from COUNT) for unenriched rows; the TS helper returns `null` so callers know "not a real verdict, skip."

- [ ] **Step 1: Write the failing tests**

Append to `packages/indexer/test/metrics.test.ts`:

```ts
import { verdictTruth } from '../src/api/explorer.js';

describe('verdictTruth strict mode', () => {
  it('strict=false returns verdictCode==1 for an unenriched row (legacy fallback)', () => {
    const row = { verdictCode: 1, actualPassed: null, enrichmentStatus: 'pending' };
    expect(verdictTruth(row, false)).toBe(true);
    expect(verdictTruth({ ...row, verdictCode: 0 }, false)).toBe(false);
  });

  it('strict=true returns null for an unenriched row (caller filters out)', () => {
    const row = { verdictCode: 1, actualPassed: null, enrichmentStatus: 'pending' };
    expect(verdictTruth(row, true)).toBe(null);
    expect(verdictTruth({ ...row, enrichmentStatus: 'failed' }, true)).toBe(null);
    expect(verdictTruth({ ...row, enrichmentStatus: null }, true)).toBe(null);
  });

  it('strict=true returns actualPassed for an enriched row', () => {
    expect(
      verdictTruth({ verdictCode: 1, actualPassed: true, enrichmentStatus: 'ok' }, true),
    ).toBe(true);
    expect(
      verdictTruth({ verdictCode: 1, actualPassed: false, enrichmentStatus: 'ok' }, true),
    ).toBe(false);
  });

  it('strict=false matches the existing fallback semantics for enriched rows', () => {
    expect(
      verdictTruth({ verdictCode: 0, actualPassed: true, enrichmentStatus: 'ok' }, false),
    ).toBe(true);
  });

  it('default arg behaves like strict=false (back-compat)', () => {
    const row = { verdictCode: 1, actualPassed: null, enrichmentStatus: 'pending' };
    expect(verdictTruth(row)).toBe(true);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd packages/indexer && yarn vitest run test/metrics.test.ts -t "verdictTruth strict mode"`
Expected: FAIL — the `strict` param does not exist and `verdictTruth` is not exported.

- [ ] **Step 3: Implement strict mode**

Replace the `verdictTruth` function in `packages/indexer/src/api/explorer.ts` (lines 207-211) with:

```ts
/**
 * Returns the pass signal for a verdict row.
 *
 * Strict mode (`strict=true`) means envelope-only: an unenriched row returns
 * null and the caller is expected to drop it from BOTH numerator and
 * denominator (spec §4 — the verdictCode fallback is a known lie produced by
 * the pre-envelope-truth daemon, which defaulted Pass for failed evaluations).
 *
 * Permissive mode (`strict=false`, the default for back-compat) keeps the
 * legacy fallback: enriched rows use actualPassed, unenriched rows use
 * verdictCode===1.
 *
 * Exported for unit tests; route handlers consume it via verdictTruthPassCountSql.
 */
export function verdictTruth(v: VerdictTruthRow, strict: boolean = false): boolean | null {
  if (v.enrichmentStatus === 'ok' && v.actualPassed !== null) {
    return v.actualPassed;
  }
  if (strict) return null;
  return v.verdictCode === 1;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd packages/indexer && yarn vitest run test/metrics.test.ts -t "verdictTruth strict mode"`
Expected: PASS — 5 tests.

- [ ] **Step 5: Commit**

```bash
git add packages/indexer/src/api/explorer.ts packages/indexer/test/metrics.test.ts
git commit -m "feat(indexer): add strict mode to verdictTruth (envelope-only, no verdictCode fallback) (#610)"
```

---

## Task 3: Add a SQL fragment that filters verdicts to enriched-only

**Files:**
- Modify: `packages/indexer/src/api/explorer.ts` (insert after `verdictTruthDisagreementCountSql`).

The route handlers query `verdict` LEFT JOINed against `verdictEnvelopeMeta`. When `includeUnenriched=false`, we want `WHERE verdictEnvelopeMeta.enrichmentStatus = 'ok'` added to the WHERE clause. We expose this as a helper that returns the SQL fragment or `undefined`.

- [ ] **Step 1: Implement the helper**

Add to `packages/indexer/src/api/explorer.ts`, just after `verdictTruthDisagreementCountSql` (line 227):

```ts
/**
 * SQL WHERE fragment that restricts the join to enriched verdicts only.
 * Returns `undefined` when raw mode is requested (the WHERE clause stays
 * unchanged). Callers pass the result to `and(...)`; `and()` skips undefined
 * operands per the Drizzle helper.
 */
function enrichmentFilter(includeUnenriched: boolean) {
  return includeUnenriched
    ? undefined
    : eq(schema.verdictEnvelopeMeta.enrichmentStatus, 'ok');
}
```

There is no separate test for this — it's a one-line SQL builder and the integration coverage comes via Tasks 4-5 below.

- [ ] **Step 2: Build the indexer to confirm typecheck**

Run: `cd packages/indexer && yarn typecheck`
Expected: PASS — no type errors.

- [ ] **Step 3: Commit**

```bash
git add packages/indexer/src/api/explorer.ts
git commit -m "feat(indexer): add enrichmentFilter SQL fragment for envelope-only verdict queries (#610)"
```

---

## Task 4: Wire `includeUnenriched` into `GET /explorer/network`

**Files:**
- Modify: `packages/indexer/src/api/explorer.ts:286-483` (the `/network` route).

The `verdictRows` query has three counters that need updating when `includeUnenriched=false`:
- `total` — verdict count → filtered to enriched-only.
- `onChainPass` — needs to count only enriched rows when strict.
- `envelopePass` — already only counts enriched rows by construction (it's `verdictTruthPassCountSql`'s `enrichmentStatus='ok'` branch).
- `disagreed` — already enriched-only by construction.

The simplest implementation: add `enrichmentFilter(includeUnenriched)` to the WHERE clause of the `verdictRows` query. When strict, `total` shrinks to enriched rows; `onChainPass` becomes "enriched AND verdictCode=1"; `envelopePass` is unchanged because its CASE expression already gates on `enrichmentStatus='ok'`.

- [ ] **Step 1: Add a regression test for the strict-mode rate**

Create a new test file `packages/indexer/test/api.explorer.test.ts`:

```ts
/**
 * Tests for /explorer/* route handlers.
 *
 * Like packages/indexer/test/api.routes.test.ts, route bodies must be tested
 * via pure helper functions because the Ponder `db` virtual module is not
 * importable from Vitest. This test exercises the SQL-building helpers
 * directly with stubbed Drizzle rows and asserts the rate math is correct in
 * both strict and permissive modes.
 */
import { describe, it, expect } from 'vitest';
import { verdictTruth } from '../src/api/explorer.js';

type Row = { verdictCode: number; actualPassed: boolean | null; enrichmentStatus: string | null };

function rate(rows: Row[], strict: boolean): { pass: number; total: number; rate: number | null } {
  const judgements = rows.map((r) => verdictTruth(r, strict));
  const considered = judgements.filter((j): j is boolean => j !== null);
  const pass = considered.filter(Boolean).length;
  const total = considered.length;
  return { pass, total, rate: total === 0 ? null : pass / total };
}

describe('resolved-rate math — strict vs permissive', () => {
  // Period of contaminated data: 4 unenriched verdictCode=1 rows + 6 honest enriched rows (3 pass, 3 fail).
  const rows: Row[] = [
    // Pre-envelope-truth contamination: verdictCode defaulted to Pass(1), no enrichment.
    { verdictCode: 1, actualPassed: null, enrichmentStatus: 'pending' },
    { verdictCode: 1, actualPassed: null, enrichmentStatus: 'pending' },
    { verdictCode: 1, actualPassed: null, enrichmentStatus: 'pending' },
    { verdictCode: 1, actualPassed: null, enrichmentStatus: 'pending' },
    // Real verdicts with envelope enrichment.
    { verdictCode: 1, actualPassed: true,  enrichmentStatus: 'ok' },
    { verdictCode: 1, actualPassed: true,  enrichmentStatus: 'ok' },
    { verdictCode: 1, actualPassed: true,  enrichmentStatus: 'ok' },
    { verdictCode: 0, actualPassed: false, enrichmentStatus: 'ok' },
    { verdictCode: 0, actualPassed: false, enrichmentStatus: 'ok' },
    { verdictCode: 0, actualPassed: false, enrichmentStatus: 'ok' },
  ];

  it('permissive mode (raw) reports 7/10 = 0.7 (contamination inflates the rate)', () => {
    const r = rate(rows, false);
    expect(r.total).toBe(10);
    expect(r.pass).toBe(7);
    expect(r.rate).toBeCloseTo(0.7);
  });

  it('strict mode (envelope-only) reports 3/6 = 0.5 (the honest number)', () => {
    const r = rate(rows, true);
    expect(r.total).toBe(6);
    expect(r.pass).toBe(3);
    expect(r.rate).toBeCloseTo(0.5);
  });

  it('strict mode returns null rate when all rows are unenriched', () => {
    const onlyUnenriched = rows.slice(0, 4);
    const r = rate(onlyUnenriched, true);
    expect(r.total).toBe(0);
    expect(r.rate).toBeNull();
  });
});
```

- [ ] **Step 2: Run the new test**

Run: `cd packages/indexer && yarn vitest run test/api.explorer.test.ts`
Expected: PASS — 3 tests. (These tests pass already because Task 2 shipped `verdictTruth(strict)`; they document the rate-math invariant and lock in the regression coverage for what Tasks 4-5 wire into the routes.)

- [ ] **Step 3: Wire `includeUnenriched` into `/network`**

In `packages/indexer/src/api/explorer.ts`, modify the `/network` route handler at line 286. Replace the existing route signature and `verdictRows` block:

Locate the line `app.get('/network', async (c) => {` and immediately after it, add:

```ts
  const includeUnenriched = parseBoolParam(c.req.query('include'), false);
```

Wait — the URL convention in the spec is `?include=raw` (one canonical param across endpoints). Replace the line above with:

```ts
  // Spec §4: envelope-only by default; ?include=raw opts back into permissive mode.
  const includeUnenriched = c.req.query('include') === 'raw';
```

Then locate the `verdictRows` query (around line 321-341, the third element in the `Promise.all` block) and modify its `.where()` clause from:

```ts
        .where(eq(schema.verdict.chainId, EXPLORER_CHAIN_ID)),
```

to:

```ts
        .where(
          and(
            eq(schema.verdict.chainId, EXPLORER_CHAIN_ID),
            enrichmentFilter(includeUnenriched),
          ),
        ),
```

- [ ] **Step 4: Typecheck**

Run: `cd packages/indexer && yarn typecheck`
Expected: PASS — no type errors.

- [ ] **Step 5: Existing route tests should still pass (no behaviour change without `?include=raw`)**

Run: `cd packages/indexer && yarn vitest run`
Expected: PASS — all existing tests still pass; new `/explorer/*` route exercise is left to integration / e2e.

- [ ] **Step 6: Commit**

```bash
git add packages/indexer/src/api/explorer.ts packages/indexer/test/api.explorer.test.ts
git commit -m "feat(indexer): /network defaults to envelope-only verdicts; ?include=raw opts in (#610)"
```

---

## Task 5: Wire `includeUnenriched` into `GET /explorer/solvernet/:cid`

**Files:**
- Modify: `packages/indexer/src/api/explorer.ts:571-905` (the `/solvernet/:cid` route).

Same pattern as Task 4 but the route has more verdict-consuming sites: the curve samples (lines 707-716), the train/frozen leaderboards (via `buildLeaderboardRows` — check whether it reads verdicts), and the freeze-integrity / per-checkpoint frozen-rate computations.

The narrow Phase 1 contract: when `?include=raw` is omitted, the learning curve and the headline `resolvedRate` (computed inside the SolverNet stats batch) come from envelope-only rows. Train/frozen leaderboards and per-checkpoint `frozenResolvedRate` are downstream and should also respect the same filter so the page is internally consistent.

- [ ] **Step 1: Parse the param at the top of the route handler**

In `packages/indexer/src/api/explorer.ts`, immediately after the `parseIntParam(c.req.query('minVerdicts'), ...)` line (around line 598-602), add:

```ts
  // Spec §4: envelope-only by default; ?include=raw opts back into permissive mode.
  const includeUnenriched = c.req.query('include') === 'raw';
```

- [ ] **Step 2: Apply the filter to the verdict query that feeds learning curves**

Locate the `verdictRows` query inside the `Promise.all` block (around line 629-649). Modify its `.where()` clause from:

```ts
            .where(
              and(
                inArray(schema.verdict.taskId, ids),
                eq(schema.verdict.chainId, EXPLORER_CHAIN_ID),
              ),
            )
```

to:

```ts
            .where(
              and(
                inArray(schema.verdict.taskId, ids),
                eq(schema.verdict.chainId, EXPLORER_CHAIN_ID),
                enrichmentFilter(includeUnenriched),
              ),
            )
```

- [ ] **Step 3: Propagate the filter to the curve sample computation**

The lines (around 707-716):

```ts
  const samples = verdictRows.map((v) => ({
    block: v.createdAtBlock,
    pass: verdictTruth(v),
  }));

  const learningCurveBuckets = bucketResolvedRate(samples, bucketBlocks);
  const learningCurveRolling = rollingResolvedRate(
    verdictRows.map(verdictTruth),
    rollingK,
  );
```

become (under the strict default, `verdictRows` is already filtered to enriched-only at the SQL layer by Step 2, so `verdictTruth(v)` returns the actualPassed value reliably — no behaviour change here in strict mode; in permissive mode, the legacy fallback still applies):

No code change in this step — the SQL filter from Step 2 is the load-bearing change. The `verdictTruth(v)` call here remains permissive, which is correct: in strict mode the row would have been excluded already.

(Step 3 is documentation-only confirming the architectural reasoning. Skip to Step 4.)

- [ ] **Step 4: Apply the filter to other verdict queries the route runs**

Audit `buildLeaderboardRows` and any other SolverNet-level helpers that read `verdict` rows. Find them with:

```bash
grep -n "buildLeaderboardRows\|frozenVerdicts\|schema.verdict" packages/indexer/src/api/explorer.ts | head -30
```

For each query whose results feed the surface (curve, leaderboard, per-checkpoint score), add `enrichmentFilter(includeUnenriched)` to its WHERE clause AND ensure the function accepts `includeUnenriched` as a param. Note: `getSolverNetStatsBatch` (called at line 606) currently does its own verdict counting; either extend its signature with `includeUnenriched: boolean` and apply the same filter, or recompute the SolverNet's `resolvedRate` inside this route after the verdict filter is applied (the latter avoids touching the batch helper).

The simpler path for Phase 1: recompute the SolverNet's `verdictsPass`, `verdicts`, `resolvedRate` from the already-filtered `verdictRows` rather than the unfiltered `getSolverNetStatsBatch` output. Replace `stats` usage in the response shape with locally-computed counts:

After the `verdictRows.map(verdictTruth)` block (around line 716), compute:

```ts
  const filteredVerdictsTotal = verdictRows.length;
  const filteredVerdictsPass = verdictRows.filter((v) => verdictTruth(v) === true).length;
  const filteredResolvedRate =
    filteredVerdictsTotal === 0 ? null : filteredVerdictsPass / filteredVerdictsTotal;
```

And in the response body returned by `c.json(...)`, override the `verdictsPass` / `verdicts` / `resolvedRate` fields with the filtered values when constructing the SolverNetResponse.

- [ ] **Step 5: Typecheck + build**

Run: `cd packages/indexer && yarn typecheck && yarn build`
Expected: PASS — no type errors, indexer builds cleanly.

- [ ] **Step 6: Run all indexer tests**

Run: `cd packages/indexer && yarn vitest run`
Expected: PASS — no regressions.

- [ ] **Step 7: Commit**

```bash
git add packages/indexer/src/api/explorer.ts
git commit -m "feat(indexer): /solvernet/:cid defaults to envelope-only verdicts; ?include=raw opts in (#610)"
```

---

## Task 6: Extend the SPA client to thread the param through

**Files:**
- Modify: `packages/indexer/explorer/src/lib/api.ts:275-340` — extend `useNetwork()` and `useSolverNet()` hooks.

- [ ] **Step 1: Add the param to `useNetwork()`**

Replace `useNetwork()` (around line 275) with:

```ts
export interface NetworkParams {
  includeUnenriched?: boolean;
}

export function useNetwork(params?: NetworkParams) {
  return useQuery({
    queryKey: ['network', params],
    queryFn: () =>
      fetchJson<NetworkResponse>(
        `/explorer/network${params?.includeUnenriched ? '?include=raw' : ''}`,
      ),
  });
}
```

- [ ] **Step 2: Add the param to `useSolverNet()`**

Extend `SolverNetParams` (around line 289) with:

```ts
export interface SolverNetParams {
  bucket?: number;
  k?: number;
  minVerdicts?: number;
  includeUnenriched?: boolean;
}
```

Modify the query string builder inside `useSolverNet` (around line 295) to include the param:

```ts
export function useSolverNet(cid: string, params?: SolverNetParams) {
  return useQuery({
    queryKey: ['solvernet', cid, params],
    queryFn: () =>
      fetchJson<SolverNetResponse>(
        `/explorer/solvernet/${encodeURIComponent(cid)}${qs({
          bucket: params?.bucket,
          k: params?.k,
          minVerdicts: params?.minVerdicts,
          include: params?.includeUnenriched ? 'raw' : undefined,
        })}`,
      ),
    enabled: Boolean(cid),
  });
}
```

- [ ] **Step 3: Typecheck the SPA**

Run: `cd packages/indexer/explorer && yarn typecheck`
Expected: PASS — no type errors.

- [ ] **Step 4: Commit**

```bash
git add packages/indexer/explorer/src/lib/api.ts
git commit -m "feat(explorer-spa): thread includeUnenriched through useNetwork/useSolverNet (#610)"
```

---

## Task 7: Create the `NetworkFactsRow` component

**Files:**
- Create: `packages/indexer/explorer/src/components/NetworkFactsRow.tsx`
- Test: `packages/indexer/explorer/src/components/NetworkFactsRow.test.tsx`

A small presentational component rendering 4 KPI panels in a row, reading from `NetworkResponse`. Per Design.md §5: `bg-elevated` cards, hairline borders, ALL CAPS MONO eyebrow labels, JetBrains Mono values, no shadow beyond hairlines.

- [ ] **Step 1: Write the failing test**

Create `packages/indexer/explorer/src/components/NetworkFactsRow.test.tsx`:

```tsx
import { render, screen } from '@testing-library/react';
import { describe, it, expect } from 'vitest';
import { NetworkFactsRow } from './NetworkFactsRow';
import type { NetworkResponse } from '../lib/api';

const fixture: Pick<
  NetworkResponse,
  'distinctOperators' | 'solverNetsRunning' | 'jinnDistributedOperator' | 'jinnDistributedDao' | 'mostRecentSettlementBlock'
> = {
  distinctOperators: 7,
  solverNetsRunning: 2,
  jinnDistributedOperator: '100500000000000000000',
  jinnDistributedDao: '50000000000000000000',
  mostRecentSettlementBlock: '24500000',
};

describe('NetworkFactsRow', () => {
  it('renders four labelled KPI panels', () => {
    render(<NetworkFactsRow data={fixture as NetworkResponse} />);
    expect(screen.getByText(/distinct operators/i)).toBeInTheDocument();
    expect(screen.getByText('7')).toBeInTheDocument();
    expect(screen.getByText(/solvernets running/i)).toBeInTheDocument();
    expect(screen.getByText('2')).toBeInTheDocument();
    expect(screen.getByText(/jinn distributed/i)).toBeInTheDocument();
    expect(screen.getByText(/most recent settlement/i)).toBeInTheDocument();
  });

  it('renders "—" for null mostRecentSettlementBlock', () => {
    render(
      <NetworkFactsRow
        data={{ ...fixture, mostRecentSettlementBlock: null } as NetworkResponse}
      />,
    );
    expect(screen.getByText('—')).toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/indexer/explorer && yarn vitest run src/components/NetworkFactsRow.test.tsx`
Expected: FAIL with "Cannot find module './NetworkFactsRow'".

- [ ] **Step 3: Implement the component**

Create `packages/indexer/explorer/src/components/NetworkFactsRow.tsx`:

```tsx
/**
 * NetworkFactsRow — four KPI panels for the reframed NetworkView (spec §5.1).
 *
 * Network-level facts only — distinct operators, SolverNets running, JINN
 * distributed (operator/DAO split), most-recent settlement block. Per spec §3.2
 * these are quantities that survive cross-SolverNet aggregation; the
 * misleading network-wide resolvedRate roll-up is intentionally absent.
 *
 * Visual: bg-elevated cards with hairline borders, ALL CAPS MONO eyebrow
 * labels, JetBrains Mono values. Per Design.md §5 / §3 Two-Voices Rule. No
 * gold emphasis on this surface — gold reserved for SolverNet detail.
 */
import type { NetworkResponse } from '../lib/api';
import { block, jinn, int } from '../lib/format';

interface Props {
  data: NetworkResponse;
}

const cardStyle: React.CSSProperties = {
  background: 'var(--bg-elevated)',
  border: '1px solid var(--border)',
  borderRadius: 'var(--radius-3)',
  padding: 20,
  display: 'flex',
  flexDirection: 'column',
  gap: 8,
};

const labelStyle: React.CSSProperties = {
  fontFamily: 'var(--font-mono)',
  fontSize: 11,
  letterSpacing: '0.14em',
  textTransform: 'uppercase',
  color: 'var(--fg-dim)',
  fontWeight: 500,
};

const valueStyle: React.CSSProperties = {
  fontFamily: 'var(--font-mono)',
  fontSize: 24,
  color: 'var(--fg)',
};

export function NetworkFactsRow({ data }: Props) {
  return (
    <section
      aria-label="Network facts"
      style={{
        display: 'grid',
        gridTemplateColumns: 'repeat(4, minmax(0, 1fr))',
        gap: 16,
      }}
    >
      <div style={cardStyle}>
        <span style={labelStyle}>Distinct operators</span>
        <span style={valueStyle}>{int(data.distinctOperators)}</span>
      </div>
      <div style={cardStyle}>
        <span style={labelStyle}>SolverNets running</span>
        <span style={valueStyle}>{int(data.solverNetsRunning)}</span>
      </div>
      <div style={cardStyle}>
        <span style={labelStyle}>JINN distributed</span>
        <span style={valueStyle}>
          {jinn(data.jinnDistributedOperator)} <span style={{ color: 'var(--fg-dim)' }}>op</span>
          {' / '}
          {jinn(data.jinnDistributedDao)} <span style={{ color: 'var(--fg-dim)' }}>dao</span>
        </span>
      </div>
      <div style={cardStyle}>
        <span style={labelStyle}>Most recent settlement</span>
        <span style={valueStyle}>
          {data.mostRecentSettlementBlock ? block(data.mostRecentSettlementBlock) : '—'}
        </span>
      </div>
    </section>
  );
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd packages/indexer/explorer && yarn vitest run src/components/NetworkFactsRow.test.tsx`
Expected: PASS — 2 tests.

- [ ] **Step 5: Commit**

```bash
git add packages/indexer/explorer/src/components/NetworkFactsRow.tsx packages/indexer/explorer/src/components/NetworkFactsRow.test.tsx
git commit -m "feat(explorer-spa): NetworkFactsRow component for the reframed NetworkView (#610)"
```

---

## Task 8: Reframe `NetworkView` — drop the solve-rate hero

**Files:**
- Modify: `packages/indexer/explorer/src/views/NetworkView.tsx`
- Modify: `packages/indexer/explorer/src/views/NetworkView.test.tsx`

Per spec §5.1: drop the `SolveHero` section that PR #251 introduced; render `NetworkFactsRow` instead. The existing composition HBars (`byMode`, `byHarness`, `byModel`, `byPlugin`) stay, labelled as `NETWORK COMPOSITION` to make the digest framing explicit. The existing SolverNet digest list, if rendered in this view, also stays.

- [ ] **Step 1: Update the test first — assert the hero is gone**

Open `packages/indexer/explorer/src/views/NetworkView.test.tsx` and replace the existing solve-rate assertions. Add:

```tsx
import { render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { describe, it, expect, vi } from 'vitest';
import { NetworkView } from './NetworkView';

vi.mock('../lib/api', () => ({
  useNetwork: () => ({
    isLoading: false,
    error: null,
    data: {
      tasksPosted: 100,
      tasksSettled: 80,
      tasksRefunded: 5,
      attempts: 150,
      distinctOperators: 7,
      solverNetsRunning: 2,
      verdicts: 120,
      verdictsPass: 60,
      resolvedRate: 0.5,
      onChainVerdictsPass: 90,
      onChainResolvedRate: 0.75,
      verdictConsistency: { matched: 90, disagreed: 30, total: 120, agreementShare: 0.75 },
      enrichmentCoverageVerdicts: { enriched: 120, total: 120, share: 1 },
      jinnDistributedOperator: '100500000000000000000',
      jinnDistributedDao: '50000000000000000000',
      mostRecentSettlementBlock: '24500000',
      composition: {
        byMode: [{ value: 'train', count: 100, share: 0.66 }, { value: 'frozen', count: 50, share: 0.34 }],
        byHarness: [{ value: 'hermes-agent', count: 150, share: 1 }],
        byModel: [{ value: 'claude-haiku-4-5', count: 150, share: 1 }],
        byPlugin: [],
      },
      enrichmentCoverage: { enrichedAttempts: 150, totalAttempts: 150, share: 1 },
      lastIndexedBlock: '24500000',
      lastIndexedAt: '2026-05-25T15:00:00Z',
      behindHead: 0,
    },
  }),
}));

function renderView() {
  const client = new QueryClient();
  return render(
    <QueryClientProvider client={client}>
      <NetworkView />
    </QueryClientProvider>,
  );
}

describe('NetworkView — reframed (#610)', () => {
  it('does NOT render the "Solve rate" hero', () => {
    renderView();
    expect(screen.queryByText(/^solve rate$/i)).not.toBeInTheDocument();
  });

  it('renders the NetworkFactsRow with distinct operators + SolverNets running', () => {
    renderView();
    expect(screen.getByText(/distinct operators/i)).toBeInTheDocument();
    expect(screen.getByText('7')).toBeInTheDocument();
    expect(screen.getByText(/solvernets running/i)).toBeInTheDocument();
    expect(screen.getByText('2')).toBeInTheDocument();
  });

  it('renders composition under the "Network composition" eyebrow', () => {
    renderView();
    expect(screen.getByText(/network composition/i)).toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/indexer/explorer && yarn vitest run src/views/NetworkView.test.tsx`
Expected: FAIL — the "Solve rate" hero is still rendered; the "Network composition" eyebrow text is not.

- [ ] **Step 3: Reframe NetworkView**

In `packages/indexer/explorer/src/views/NetworkView.tsx`:

(a) Remove the `SolveHero` component definition entirely (the block starting around line 61 and continuing through its render).
(b) Remove the `SkeletonHero` component if it's only used for `SolveHero`'s loading state.
(c) Remove the `<SolveHero data={data} />` invocation in the view body.
(d) Add `import { NetworkFactsRow } from '../components/NetworkFactsRow';` at the top.
(e) Insert `<NetworkFactsRow data={data} />` at the top of the view's main render body, before any other sections.
(f) Add an ALL CAPS MONO eyebrow `Network composition` immediately above the existing `HBars` block.

(The exact diffs depend on the current structure; the assertions in the test pin the contract.)

- [ ] **Step 4: Run test to verify it passes**

Run: `cd packages/indexer/explorer && yarn vitest run src/views/NetworkView.test.tsx`
Expected: PASS — 3 tests.

- [ ] **Step 5: Run all SPA tests to confirm no other view regressed**

Run: `cd packages/indexer/explorer && yarn vitest run`
Expected: PASS — all view tests pass (NetworkView's old hero-related assertions in routing.test or rail.test should already have been removed in Step 1; if any remain failing, update them similarly).

- [ ] **Step 6: Commit**

```bash
git add packages/indexer/explorer/src/views/NetworkView.tsx packages/indexer/explorer/src/views/NetworkView.test.tsx
git commit -m "feat(explorer-spa): NetworkView reframe — drop solve-rate hero, render NetworkFactsRow + composition digest (#610)"
```

---

## Task 9: Reframe `OperatorsView` — drop cross-SolverNet rank ordering

**Files:**
- Modify: `packages/indexer/explorer/src/views/OperatorsView.tsx`
- Modify: `packages/indexer/explorer/src/views/OperatorsView.test.tsx`
- Possibly modify: `packages/indexer/explorer/src/components/Leaderboard.tsx` only if it has a fixed `rank` column that can't be hidden via props.

Per spec §5.4: drop the rank ordering; render as a roster. Columns: operator (address-shortened, clickable to `/operator/:addr`), attempts, JINN earned, chip strip of SolverNets they've participated in.

The current view uses the existing `Leaderboard` component which renders `ranked` + `lowVolume` partitions. The reframe is most cleanly done by replacing `Leaderboard` usage in this view with a new `OperatorRoster` table (or a simpler `<DataTable>` consumer). The `Leaderboard` component itself stays for use inside SolverNetView.

- [ ] **Step 1: Update the test first**

Replace `packages/indexer/explorer/src/views/OperatorsView.test.tsx` body with:

```tsx
import { render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { describe, it, expect, vi } from 'vitest';
import { Router } from 'wouter';
import { memoryLocation } from 'wouter/memory-location';
import { OperatorsView } from './OperatorsView';

vi.mock('../lib/api', () => ({
  useOperators: () => ({
    isLoading: false,
    error: null,
    data: {
      ranked: [
        {
          operator: '0xabc0000000000000000000000000000000000001',
          rank: 1,
          attempts: 12,
          settledContribution: 8,
          verdictsTotal: 10,
          verdictsPass: 7,
          resolvedRate: 0.7,
          jinnEarned: '100500000000000000000',
          dominantMode: 'train',
          dominantHarness: 'hermes-agent',
        },
      ],
      lowVolume: [],
      minVerdicts: 5,
      meta: { jinnAttribution: 'ok' },
      lastIndexedBlock: '24500000',
      lastIndexedAt: '2026-05-25T15:00:00Z',
      behindHead: 0,
    },
  }),
  useNetwork: () => ({ isLoading: false, error: null, data: null }),
}));

function renderView() {
  const client = new QueryClient();
  const { hook } = memoryLocation();
  return render(
    <QueryClientProvider client={client}>
      <Router hook={hook}>
        <OperatorsView />
      </Router>
    </QueryClientProvider>,
  );
}

describe('OperatorsView — reframed (#610)', () => {
  it('does NOT render a "rank" column header', () => {
    renderView();
    expect(screen.queryByText(/^rank$/i)).not.toBeInTheDocument();
    expect(screen.queryByText('#')).not.toBeInTheDocument();
  });

  it('does NOT render a top-level resolvedRate column (cross-SolverNet roll-up)', () => {
    renderView();
    expect(screen.queryByText(/resolved rate/i)).not.toBeInTheDocument();
  });

  it('renders the operator row with attempts and JINN earned', () => {
    renderView();
    expect(screen.getByText('0xabc0…0001')).toBeInTheDocument();
    expect(screen.getByText(/12/)).toBeInTheDocument();
  });
});
```

(Adjust the shortened-address format to whatever `lib/format.ts` actually produces.)

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd packages/indexer/explorer && yarn vitest run src/views/OperatorsView.test.tsx`
Expected: FAIL — current view renders rank + resolvedRate columns via the Leaderboard component.

- [ ] **Step 3: Reframe the view**

In `packages/indexer/explorer/src/views/OperatorsView.tsx`:

(a) Remove the `<Leaderboard>` usage and the filter UI that fed it (the segmented control for `mode`, the harness select, the `minVerdicts` input) — these were leaderboard-shaped controls and the roster doesn't need them.

(b) Replace with a simple roster table. The roster reads from `data.ranked` merged with `data.lowVolume` (since the partition is now meaningless). Columns:
- Operator (shortened address; `Link` to `/operator/:addr`)
- Attempts
- JINN earned (formatted via `jinn()` from `lib/format`)

(c) Drop the `resolvedRate` column entirely from the table render.

(d) Remove `dominantMode` / `dominantHarness` chips if they're rendered (these were leaderboard-flavoured). If retained, render them under a `Recent activity` eyebrow rather than as ranking metadata.

Skeleton implementation:

```tsx
import { Link } from 'wouter';
import { useOperators } from '../lib/api';
import { StatusBar } from '../components/StatusBar';
import { jinn, int, shortAddress } from '../lib/format';

export function OperatorsView() {
  const { isLoading, error, data } = useOperators();

  if (isLoading) return null;
  if (error || !data) return null;

  const operators = [...data.ranked, ...data.lowVolume];

  return (
    <div style={{ padding: '32px 28px', display: 'flex', flexDirection: 'column', gap: 24 }}>
      <h1 style={{
        fontFamily: 'var(--font-display)',
        fontSize: 48,
        fontWeight: 400,
        color: 'var(--fg)',
      }}>
        Operators
      </h1>
      <table style={{ width: '100%', borderCollapse: 'collapse' }}>
        <thead>
          <tr>
            <th style={th}>Operator</th>
            <th style={th}>Attempts</th>
            <th style={th}>JINN earned</th>
          </tr>
        </thead>
        <tbody>
          {operators.map((op) => (
            <tr key={op.operator} style={{ borderTop: '1px solid var(--border)' }}>
              <td style={td}>
                <Link href={`/operator/${op.operator}`}>{shortAddress(op.operator)}</Link>
              </td>
              <td style={td}>{int(op.attempts)}</td>
              <td style={td}>{jinn(op.jinnEarned)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <StatusBar lastIndexedBlock={data.lastIndexedBlock} lastIndexedAt={data.lastIndexedAt} behindHead={data.behindHead} />
    </div>
  );
}

const th: React.CSSProperties = {
  textAlign: 'left',
  padding: '8px 12px',
  fontFamily: 'var(--font-mono)',
  fontSize: 11,
  letterSpacing: '0.14em',
  textTransform: 'uppercase',
  color: 'var(--fg-dim)',
  fontWeight: 500,
};

const td: React.CSSProperties = {
  padding: '12px',
  fontFamily: 'var(--font-mono)',
  fontSize: 13,
  color: 'var(--fg)',
};
```

If `shortAddress` does not exist in `lib/format.ts`, add it there first as a one-liner: `export const shortAddress = (a: string) => \`${a.slice(0,6)}…${a.slice(-4)}\`;`.

- [ ] **Step 4: Run the test**

Run: `cd packages/indexer/explorer && yarn vitest run src/views/OperatorsView.test.tsx`
Expected: PASS — 3 tests.

- [ ] **Step 5: Run all SPA tests**

Run: `cd packages/indexer/explorer && yarn vitest run`
Expected: PASS — no regressions; remove any obsolete OperatorsView assertions in `App.routing.test.tsx` if they reference the dropped filter UI.

- [ ] **Step 6: Commit**

```bash
git add packages/indexer/explorer/src/views/OperatorsView.tsx packages/indexer/explorer/src/views/OperatorsView.test.tsx packages/indexer/explorer/src/lib/format.ts
git commit -m "feat(explorer-spa): OperatorsView reframe — roster, not leaderboard (#610)"
```

---

## Task 10: Manual smoke check

**Files:** none — UI verification.

- [ ] **Step 1: Run the indexer locally against testnet**

Run: `cd packages/indexer && yarn dev`
Expected: indexer starts on its usual port; logs say "indexing" against Base Sepolia.

- [ ] **Step 2: Run the explorer SPA dev server**

Run: `cd packages/indexer/explorer && yarn dev`
Expected: Vite dev server on http://localhost:5173 (or similar).

- [ ] **Step 3: Visit `/` (NetworkView) and verify**

Open http://localhost:5173/ in a browser.
Expected:
- No gold-bordered "Solve rate" hero with the giant percentage number.
- The four `NetworkFactsRow` cards render: Distinct operators / SolverNets running / JINN distributed / Most recent settlement.
- The composition HBars render under a `NETWORK COMPOSITION` eyebrow.

- [ ] **Step 4: Visit `/solvernet/<some-cid>` and verify**

Open the SolverNet detail page for a known CID (find one via `/solvernets`).
Expected:
- The learning curve renders with **only envelope-only verdicts** — visibly different from before (no flat 100% spike in the early period if there were unenriched contaminated verdicts).
- Add `?include=raw` to the URL and reload.
- The learning curve now shows the legacy contaminated data.

- [ ] **Step 5: Visit `/operators` and verify**

Open http://localhost:5173/operators.
Expected:
- No rank column.
- No top-level resolvedRate column.
- Each row: operator address, attempts, JINN earned.

- [ ] **Step 6: Commit (no code change — confirm smoke pass in PR description)**

No commit needed for this task; record results in the PR body or as a comment on [#610](https://github.com/Jinn-Network/mono/issues/610).

---

## Task 11: Open the PR

**Files:** none — process step.

- [ ] **Step 1: Push the branch**

```bash
git push -u origin <branch-name>
```

- [ ] **Step 2: Open the PR**

```bash
gh pr create --title "feat(#610): Phase 1 — envelope-only default + NetworkView/OperatorsView reframe" --body "$(cat <<'EOF'
Closes #610.

## Summary

Implements Phase 1 of #601 per [spec/2026-05-25-demonstrate-solver-learning.md](../blob/next/spec/2026-05-25-demonstrate-solver-learning.md). Three coupled changes that make the explorer's milestone-shaped story credible:

1. Backend: \`enrichmentStatus = 'ok'\` is the default filter on \`/explorer/network\` and \`/explorer/solvernet/:cid\`; \`?include=raw\` opts back into permissive mode. Unenriched verdicts no longer falsely inflate resolved rates via the daemon's \`verdictCode=Pass\` default for failed evals.
2. \`NetworkView\` reframe: dropped the headline solve-rate hero; renders four network-facts KPIs (distinct operators, SolverNets running, JINN distributed, most-recent settlement) + composition under a \`NETWORK COMPOSITION\` eyebrow.
3. \`OperatorsView\` reframe: dropped cross-SolverNet rank ordering; renders as a roster (operator / attempts / JINN earned).

## Test plan

- [ ] \`cd packages/indexer && yarn vitest run\` — all green
- [ ] \`cd packages/indexer/explorer && yarn vitest run\` — all green
- [ ] Manual smoke per plan §Task 10 — NetworkView shows facts row not hero; SolverNetView learning curve is visibly cleaner; \`?include=raw\` toggles back to legacy view; OperatorsView is a roster.

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

- [ ] **Step 3: Self-check via `gh pr view`**

Run: `gh pr view --web`
Expected: PR opens in browser; body renders correctly; CI starts.

---

## Done

Phase 1 ships when this PR merges to `next` and the auto-canary publishes successfully. Co-required for the parent EPIC milestone press claim: [#570](https://github.com/Jinn-Network/mono/issues/570) and [#578](https://github.com/Jinn-Network/mono/issues/578) must also land for the SolverNet pool to grow → for the curve to have material to be "improving" over time. Those are tracked independently as sub-issues of [#601](https://github.com/Jinn-Network/mono/issues/601).
