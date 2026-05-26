# Demonstrate Solver Learning — Phase 2 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Introduce a single parameterized engine endpoint (`/explorer/slice`) that operates within one SolverNet at a time, accepting `group` + `filter[<dim>]` parameters and returning a curve + leaderboard + KPIs for the slice. Migrate `SolverNetView` to consume the engine with default params; existing per-view endpoints stay live (strangler-fig).

**Architecture:** Add a new pure helper `computeSlice(rows, params)` in `packages/indexer/src/api/explorer.ts` (or a new `packages/indexer/src/api/slice.ts`) that takes already-fetched joined rows (verdict ⋈ verdictEnvelopeMeta ⋈ attempt ⋈ attemptEnvelopeMeta) and produces the grouped curve + leaderboard. The route handler fetches the joined rows once via Drizzle (re-using `enrichmentFilter` from Phase 1) then delegates to `computeSlice`. Frontend gets a new `useSlice` hook; `SolverNetView` becomes a thin consumer that passes default params and renders the same components against the slice response.

**Tech Stack:** TypeScript, Ponder 0.16.x, Drizzle ORM, Hono, React 18 + Vite, Vitest.

**Tracking:** [#611](https://github.com/Jinn-Network/mono/issues/611) (parent EPIC: [#601](https://github.com/Jinn-Network/mono/issues/601), spec: [`spec/2026-05-25-demonstrate-solver-learning.md`](../../../spec/2026-05-25-demonstrate-solver-learning.md) §6). **Stacks on [#610](https://github.com/Jinn-Network/mono/issues/610) (Phase 1)** — `enrichmentFilter` and `verdictTruth(strict)` from Phase 1 are reused here. Open the Phase 2 PR with `base: <phase-1-branch>` and rebase after Phase 1 lands.

---

## File Structure

**Create:**
- `packages/indexer/src/api/slice.ts` — the engine's pure helpers: `parseSliceParams`, `computeSlice(rows, params)`. No DB access here.
- `packages/indexer/test/api.slice.test.ts` — unit tests for `parseSliceParams` and `computeSlice` against in-memory fixture rows.
- `packages/indexer/explorer/src/lib/useSlice.ts` — `useSlice(manifestDigest, params)` React-query hook.
- `packages/indexer/explorer/src/lib/slice-types.ts` — TypeScript shapes mirroring `SliceResponse` (kept in `explorer/src/lib/` for browser consumption; `api.ts` can re-export).

**Modify:**
- `packages/indexer/src/api/explorer.ts` — add `app.get('/slice', ...)` route. Reads query params via `parseSliceParams`, fetches the rows the engine needs, passes them to `computeSlice`. Reuses `enrichmentFilter` from Phase 1.
- `packages/indexer/explorer/src/views/SolverNetView.tsx` — migrate from `useSolverNet(cid, ...)` to `useSlice(manifestDigest, defaultParams)`. Render the same `LearningCurve` / `Leaderboard` / `Kpi` / `CheckpointTimeline` / `FreezeIntegrity` components against the slice response shape.
- `packages/indexer/explorer/src/views/SolverNetView.test.tsx` — mock `useSlice` instead of `useSolverNet`; same observable assertions.
- `packages/indexer/explorer/src/lib/api.ts` — keep `useSolverNet` live for back-compat consumers; add a re-export of `useSlice` from `./useSlice` so existing import sites can be migrated incrementally.

**Do not touch:**
- `packages/indexer/explorer/src/components/*.tsx` — components stay as data-agnostic renderers. They already accept props in the right shape; only the data source changes.
- `packages/indexer/explorer/src/views/{NetworkView,OperatorsView,OperatorView,SolverNetsListView}.tsx` — none of these consume the engine in Phase 2.
- Existing `/explorer/solvernet/:cid` route — stays live unchanged for back-compat per spec §6.

---

## Task 1: Define `SliceParams` and `SliceResponse` types

**Files:**
- Create: `packages/indexer/src/api/slice.ts` (initial scaffold — types only).
- Create: `packages/indexer/explorer/src/lib/slice-types.ts` (same shapes for the SPA).

- [ ] **Step 1: Create the indexer-side types**

Create `packages/indexer/src/api/slice.ts`:

```ts
/**
 * /explorer/slice — parameterized engine for the network explorer per
 * spec/2026-05-25-demonstrate-solver-learning.md §3.1 and §6.
 *
 * The engine operates within ONE SolverNet at a time (manifestDigest is
 * required). It returns a curve + leaderboard + KPIs for the slice defined
 * by the (group, filter, includeUnenriched, bucket) parameters.
 *
 * Cross-SolverNet comparison (multi-manifestDigest) is YAGNI per spec §9.
 *
 * This file is pure — no DB access. The route handler in explorer.ts fetches
 * the joined rows once and passes them to `computeSlice`.
 */

import type { LearningCurveBucket } from './metrics.js';

export type SliceGroupBy =
  | 'none'
  | 'operator'
  | 'harness'
  | 'plugin'
  | 'mode'
  | 'model';

export type SliceBucketSize = 'auto' | 'per-block' | 'per-day' | 'per-week';

export interface SliceFilter {
  operator?: string[];
  harness?: string[];
  plugin?: string[];
  mode?: string[];
  model?: string[];
}

export interface SliceParams {
  /** Required — the SolverNet to slice within (manifest IPFS CID). */
  manifestDigest: string;
  /** Dimension to split into series. `none` returns a single aggregate series. */
  group: SliceGroupBy;
  /** Allow-list filters per dimension. Multiple filters AND together. */
  filter: SliceFilter;
  /**
   * When false (default), drops verdicts where enrichmentStatus !== 'ok'.
   * When true, keeps them (verdictCode-fallback semantics) — for inspection.
   */
  includeUnenriched: boolean;
  /** Curve bucketing. */
  bucket: SliceBucketSize;
}

export interface SliceSeriesKPIs {
  attempts: number;
  verdicts: number;
  verdictsPass: number;
  resolvedRate: number | null;
  jinnEarned: string; // decimal string
}

export interface SliceSeries {
  /** The dimension value for this series, or null when group=none. */
  groupValue: string | null;
  /** Time-bucketed pass rate. */
  buckets: LearningCurveBucket[];
  /** Rolling pass-rate window. */
  rolling: number[];
  /** Per-series totals. */
  kpis: SliceSeriesKPIs;
}

export interface SliceResponseLeaderboardRow {
  operator: string;
  attempts: number;
  verdictsTotal: number;
  verdictsPass: number;
  resolvedRate: number | null;
  jinnEarned: string;
  dominantMode?: string;
  dominantHarness?: string;
}

export interface SliceResponse {
  /** Echo of the resolved params (after defaults applied). */
  params: SliceParams;
  /** Fraction of raw verdicts that pass the envelope filter — trust metric. */
  enrichmentCoverage: number;
  /** Sum of per-series totals; consistent with the aggregated /solvernet/:cid kpis when params={group:none}. */
  kpis: SliceSeriesKPIs;
  /** One series when group=none; up to N when grouped. */
  series: SliceSeries[];
  /** Train + frozen leaderboards, filtered to the slice. */
  leaderboard: {
    train: SliceResponseLeaderboardRow[];
    frozen: SliceResponseLeaderboardRow[];
  };
}
```

- [ ] **Step 2: Mirror the types for the SPA**

Create `packages/indexer/explorer/src/lib/slice-types.ts`:

```ts
/**
 * Mirror of packages/indexer/src/api/slice.ts SliceResponse shapes.
 * Kept in /lib/ so the SPA doesn't import from the indexer src tree.
 * Update both files together — drift here = wire-protocol bug.
 */

import type { LearningCurveBucket } from './api';

export type SliceGroupBy =
  | 'none'
  | 'operator'
  | 'harness'
  | 'plugin'
  | 'mode'
  | 'model';

export type SliceBucketSize = 'auto' | 'per-block' | 'per-day' | 'per-week';

export interface SliceFilter {
  operator?: string[];
  harness?: string[];
  plugin?: string[];
  mode?: string[];
  model?: string[];
}

export interface SliceParams {
  manifestDigest: string;
  group: SliceGroupBy;
  filter: SliceFilter;
  includeUnenriched: boolean;
  bucket: SliceBucketSize;
}

export interface SliceSeriesKPIs {
  attempts: number;
  verdicts: number;
  verdictsPass: number;
  resolvedRate: number | null;
  jinnEarned: string;
}

export interface SliceSeries {
  groupValue: string | null;
  buckets: LearningCurveBucket[];
  rolling: number[];
  kpis: SliceSeriesKPIs;
}

export interface SliceResponseLeaderboardRow {
  operator: string;
  attempts: number;
  verdictsTotal: number;
  verdictsPass: number;
  resolvedRate: number | null;
  jinnEarned: string;
  dominantMode?: string;
  dominantHarness?: string;
}

export interface SliceResponse {
  params: SliceParams;
  enrichmentCoverage: number;
  kpis: SliceSeriesKPIs;
  series: SliceSeries[];
  leaderboard: {
    train: SliceResponseLeaderboardRow[];
    frozen: SliceResponseLeaderboardRow[];
  };
}
```

- [ ] **Step 3: Typecheck both sides**

```bash
cd packages/indexer && yarn typecheck
cd packages/indexer/explorer && yarn typecheck
```

Expected: PASS on both.

- [ ] **Step 4: Commit**

```bash
git add packages/indexer/src/api/slice.ts packages/indexer/explorer/src/lib/slice-types.ts
git commit -m "feat(indexer): scaffold SliceParams/SliceResponse types for /explorer/slice (#611)"
```

---

## Task 2: Implement `parseSliceParams`

**Files:**
- Modify: `packages/indexer/src/api/slice.ts` (add `parseSliceParams`).
- Test: `packages/indexer/test/api.slice.test.ts` (create).

Parses URL search params into a validated `SliceParams`. Defaults: `group='none'`, `filter={}`, `includeUnenriched=false`, `bucket='auto'`.

- [ ] **Step 1: Write the failing tests**

Create `packages/indexer/test/api.slice.test.ts`:

```ts
/**
 * Tests for the /explorer/slice engine (spec §6 / #611).
 *
 * The route body's pure helpers (`parseSliceParams`, `computeSlice`) live in
 * src/api/slice.ts so they can be tested directly with fixture rows. The Hono
 * route handler in explorer.ts wires the helpers to Drizzle and returns the
 * JSON; that wiring is verified via an integration test in Task 9.
 */
import { describe, it, expect } from 'vitest';
import { parseSliceParams } from '../src/api/slice.js';

function urlSearchParams(qs: string): URLSearchParams {
  return new URLSearchParams(qs);
}

describe('parseSliceParams', () => {
  it('requires manifestDigest', () => {
    expect(() => parseSliceParams(urlSearchParams(''))).toThrow(/manifestDigest/);
  });

  it('returns defaults when only manifestDigest is provided', () => {
    const p = parseSliceParams(urlSearchParams('manifestDigest=bafycid'));
    expect(p).toEqual({
      manifestDigest: 'bafycid',
      group: 'none',
      filter: {},
      includeUnenriched: false,
      bucket: 'auto',
    });
  });

  it('parses group when it is one of the allowed values', () => {
    for (const g of ['none', 'operator', 'harness', 'plugin', 'mode', 'model']) {
      const p = parseSliceParams(urlSearchParams(`manifestDigest=bafy&group=${g}`));
      expect(p.group).toBe(g);
    }
  });

  it('falls back to group=none for unknown group values', () => {
    const p = parseSliceParams(urlSearchParams('manifestDigest=bafy&group=banana'));
    expect(p.group).toBe('none');
  });

  it('parses filter[operator] as a comma-separated allow-list', () => {
    const p = parseSliceParams(
      urlSearchParams('manifestDigest=bafy&filter[operator]=0xabc,0xdef'),
    );
    expect(p.filter.operator).toEqual(['0xabc', '0xdef']);
  });

  it('parses multiple filter dimensions', () => {
    const p = parseSliceParams(
      urlSearchParams('manifestDigest=bafy&filter[mode]=train&filter[harness]=hermes-agent'),
    );
    expect(p.filter.mode).toEqual(['train']);
    expect(p.filter.harness).toEqual(['hermes-agent']);
  });

  it('parses includeUnenriched=true from include=raw (URL convention)', () => {
    const p = parseSliceParams(urlSearchParams('manifestDigest=bafy&include=raw'));
    expect(p.includeUnenriched).toBe(true);
  });

  it('parses bucket when it is one of the allowed values', () => {
    for (const b of ['auto', 'per-block', 'per-day', 'per-week']) {
      const p = parseSliceParams(urlSearchParams(`manifestDigest=bafy&bucket=${b}`));
      expect(p.bucket).toBe(b);
    }
  });

  it('falls back to bucket=auto for unknown bucket values', () => {
    const p = parseSliceParams(urlSearchParams('manifestDigest=bafy&bucket=fortnight'));
    expect(p.bucket).toBe('auto');
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd packages/indexer && yarn vitest run test/api.slice.test.ts`
Expected: FAIL — `parseSliceParams` does not exist.

- [ ] **Step 3: Implement `parseSliceParams`**

Append to `packages/indexer/src/api/slice.ts`:

```ts
const ALLOWED_GROUPS: SliceGroupBy[] = [
  'none', 'operator', 'harness', 'plugin', 'mode', 'model',
];
const ALLOWED_BUCKETS: SliceBucketSize[] = [
  'auto', 'per-block', 'per-day', 'per-week',
];
const FILTER_DIMS = ['operator', 'harness', 'plugin', 'mode', 'model'] as const;

/**
 * Parses URL search params into a validated SliceParams.
 *
 * @throws Error if manifestDigest is missing — the engine is scoped to one
 *         SolverNet (spec §3.1).
 */
export function parseSliceParams(qs: URLSearchParams): SliceParams {
  const manifestDigest = qs.get('manifestDigest');
  if (!manifestDigest) {
    throw new Error('parseSliceParams: manifestDigest is required');
  }

  const rawGroup = qs.get('group');
  const group: SliceGroupBy =
    rawGroup && (ALLOWED_GROUPS as string[]).includes(rawGroup)
      ? (rawGroup as SliceGroupBy)
      : 'none';

  const rawBucket = qs.get('bucket');
  const bucket: SliceBucketSize =
    rawBucket && (ALLOWED_BUCKETS as string[]).includes(rawBucket)
      ? (rawBucket as SliceBucketSize)
      : 'auto';

  const filter: SliceFilter = {};
  for (const dim of FILTER_DIMS) {
    const raw = qs.get(`filter[${dim}]`);
    if (raw) filter[dim] = raw.split(',').map((s) => s.trim()).filter(Boolean);
  }

  const includeUnenriched = qs.get('include') === 'raw';

  return { manifestDigest, group, filter, includeUnenriched, bucket };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd packages/indexer && yarn vitest run test/api.slice.test.ts`
Expected: PASS — 9 tests.

- [ ] **Step 5: Commit**

```bash
git add packages/indexer/src/api/slice.ts packages/indexer/test/api.slice.test.ts
git commit -m "feat(indexer): parseSliceParams for /explorer/slice (#611)"
```

---

## Task 3: Implement `computeSlice` for `group='none'`

**Files:**
- Modify: `packages/indexer/src/api/slice.ts` (add `computeSlice`).
- Modify: `packages/indexer/test/api.slice.test.ts` (add `describe('computeSlice — group=none')`).

`group='none'` is the baseline that has to match what `/explorer/solvernet/:cid` already produces (under Phase 1's envelope-only default). It takes the joined rows (already filtered by `enrichmentFilter` in the route handler) and returns a single series + KPIs.

- [ ] **Step 1: Write the failing test**

Append to `packages/indexer/test/api.slice.test.ts`:

```ts
import { computeSlice, type SliceParams, type SliceInputRow } from '../src/api/slice.js';

function row(opts: Partial<SliceInputRow> = {}): SliceInputRow {
  return {
    requestId: '0xfeed',
    operator: '0xabc0',
    createdAtBlock: 100n,
    verdictCode: 1,
    actualPassed: true,
    enrichmentStatus: 'ok',
    mode: 'train',
    harness: 'hermes-agent',
    model: 'claude-haiku-4-5',
    plugins: [],
    ...opts,
  };
}

describe('computeSlice — group=none', () => {
  const params: SliceParams = {
    manifestDigest: 'bafy',
    group: 'none',
    filter: {},
    includeUnenriched: false,
    bucket: 'auto',
  };

  it('returns one series and aggregates KPIs over all rows', () => {
    const rows = [
      row({ requestId: '0x1', actualPassed: true }),
      row({ requestId: '0x2', actualPassed: true }),
      row({ requestId: '0x3', actualPassed: false }),
    ];
    const out = computeSlice(rows, params, { rawVerdictCount: 5 });
    expect(out.series).toHaveLength(1);
    expect(out.series[0].groupValue).toBe(null);
    expect(out.kpis.verdicts).toBe(3);
    expect(out.kpis.verdictsPass).toBe(2);
    expect(out.kpis.resolvedRate).toBeCloseTo(2 / 3);
    expect(out.enrichmentCoverage).toBeCloseTo(3 / 5);
  });

  it('returns rate=null when no verdicts pass the filter', () => {
    const out = computeSlice([], params, { rawVerdictCount: 0 });
    expect(out.kpis.resolvedRate).toBeNull();
    expect(out.series).toHaveLength(1);
    expect(out.series[0].buckets).toEqual([]);
  });

  it('echoes the resolved params back', () => {
    const out = computeSlice([row()], params, { rawVerdictCount: 1 });
    expect(out.params).toEqual(params);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd packages/indexer && yarn vitest run test/api.slice.test.ts -t "computeSlice"`
Expected: FAIL — `computeSlice` and `SliceInputRow` do not exist.

- [ ] **Step 3: Define `SliceInputRow` and implement `computeSlice` (group=none branch)**

Append to `packages/indexer/src/api/slice.ts`:

```ts
import { bucketResolvedRate, rollingResolvedRate } from './metrics.js';

/**
 * The row shape `computeSlice` expects after the route handler has done its
 * Drizzle join. One row per verdict, enriched with the verdict envelope's
 * actualPassed + the attempt envelope's mode/harness/model/plugins.
 *
 * The route handler is responsible for applying enrichmentFilter (the
 * envelope-only default from Phase 1) before passing rows to computeSlice.
 */
export interface SliceInputRow {
  requestId: string;
  operator: string;
  createdAtBlock: bigint;
  verdictCode: number;
  actualPassed: boolean | null;
  enrichmentStatus: string | null;
  mode: string | null;
  harness: string | null;
  model: string | null;
  plugins: string[];
}

const DEFAULT_BUCKET_BLOCKS = 7200n; // ≈1 day on Base at ~12s/block
const DEFAULT_ROLLING_K = 50;

function bucketBlocksFor(bucket: SliceBucketSize): bigint {
  switch (bucket) {
    case 'per-block': return 1n;
    case 'per-day': return 7200n;
    case 'per-week': return 50400n;
    case 'auto':
    default: return DEFAULT_BUCKET_BLOCKS;
  }
}

function passFromRow(r: SliceInputRow): boolean | null {
  if (r.enrichmentStatus === 'ok' && r.actualPassed !== null) return r.actualPassed;
  return null;
}

function computeSeriesKPIs(rows: SliceInputRow[]): SliceSeriesKPIs {
  const distinctRequests = new Set(rows.map((r) => r.requestId)).size;
  const judgements = rows.map(passFromRow).filter((p): p is boolean => p !== null);
  const verdicts = judgements.length;
  const verdictsPass = judgements.filter(Boolean).length;
  return {
    attempts: distinctRequests,
    verdicts,
    verdictsPass,
    resolvedRate: verdicts === 0 ? null : verdictsPass / verdicts,
    jinnEarned: '0', // filled in by route handler from reward query — engine doesn't see rewards
  };
}

function computeOneSeries(
  rows: SliceInputRow[],
  groupValue: string | null,
  bucket: SliceBucketSize,
): SliceSeries {
  const samples = rows
    .map((r) => ({ block: r.createdAtBlock, pass: passFromRow(r) }))
    .filter((s): s is { block: bigint; pass: boolean } => s.pass !== null);
  return {
    groupValue,
    buckets: bucketResolvedRate(samples, bucketBlocksFor(bucket)),
    rolling: rollingResolvedRate(samples.map((s) => s.pass), DEFAULT_ROLLING_K),
    kpis: computeSeriesKPIs(rows),
  };
}

export interface ComputeSliceContext {
  /** Total verdict count BEFORE enrichmentFilter — for the enrichmentCoverage metric. */
  rawVerdictCount: number;
}

export function computeSlice(
  rows: SliceInputRow[],
  params: SliceParams,
  ctx: ComputeSliceContext,
): SliceResponse {
  if (params.group === 'none') {
    const series = [computeOneSeries(rows, null, params.bucket)];
    return {
      params,
      enrichmentCoverage:
        ctx.rawVerdictCount === 0 ? 0 : rows.length / ctx.rawVerdictCount,
      kpis: series[0].kpis,
      series,
      // Leaderboard left empty here; the route handler fills it in via the
      // existing buildLeaderboardRows call after Phase 2 wires this together.
      leaderboard: { train: [], frozen: [] },
    };
  }
  // Grouped branches added in Tasks 4-6.
  throw new Error(`computeSlice: group=${params.group} not yet implemented`);
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd packages/indexer && yarn vitest run test/api.slice.test.ts -t "computeSlice"`
Expected: PASS — 3 tests.

- [ ] **Step 5: Commit**

```bash
git add packages/indexer/src/api/slice.ts packages/indexer/test/api.slice.test.ts
git commit -m "feat(indexer): computeSlice baseline — group=none with KPIs + curve (#611)"
```

---

## Task 4: Add `group='mode'` branch

**Files:**
- Modify: `packages/indexer/src/api/slice.ts`.
- Modify: `packages/indexer/test/api.slice.test.ts`.

- [ ] **Step 1: Write the failing test**

Append to `packages/indexer/test/api.slice.test.ts`:

```ts
describe('computeSlice — group=mode', () => {
  const params: SliceParams = {
    manifestDigest: 'bafy',
    group: 'mode',
    filter: {},
    includeUnenriched: false,
    bucket: 'auto',
  };

  it('returns one series per distinct mode', () => {
    const rows = [
      row({ requestId: '0x1', mode: 'train', actualPassed: true }),
      row({ requestId: '0x2', mode: 'train', actualPassed: false }),
      row({ requestId: '0x3', mode: 'frozen', actualPassed: true }),
    ];
    const out = computeSlice(rows, params, { rawVerdictCount: 3 });
    expect(out.series.map((s) => s.groupValue).sort()).toEqual(['frozen', 'train']);
    const train = out.series.find((s) => s.groupValue === 'train')!;
    const frozen = out.series.find((s) => s.groupValue === 'frozen')!;
    expect(train.kpis.verdicts).toBe(2);
    expect(train.kpis.verdictsPass).toBe(1);
    expect(frozen.kpis.verdicts).toBe(1);
    expect(frozen.kpis.verdictsPass).toBe(1);
  });

  it('top-level kpis are sums of series kpis', () => {
    const rows = [
      row({ requestId: '0x1', mode: 'train', actualPassed: true }),
      row({ requestId: '0x2', mode: 'frozen', actualPassed: false }),
    ];
    const out = computeSlice(rows, params, { rawVerdictCount: 2 });
    expect(out.kpis.verdicts).toBe(2);
    expect(out.kpis.verdictsPass).toBe(1);
    expect(out.kpis.resolvedRate).toBeCloseTo(0.5);
  });

  it('groups rows with null mode under "(unknown)"', () => {
    const rows = [row({ requestId: '0x1', mode: null, actualPassed: true })];
    const out = computeSlice(rows, params, { rawVerdictCount: 1 });
    expect(out.series.map((s) => s.groupValue)).toEqual(['(unknown)']);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd packages/indexer && yarn vitest run test/api.slice.test.ts -t "computeSlice — group=mode"`
Expected: FAIL — throws `group=mode not yet implemented`.

- [ ] **Step 3: Implement grouping helper and wire into `computeSlice`**

In `packages/indexer/src/api/slice.ts`, add a helper above `computeSlice`:

```ts
function groupKeyFor(row: SliceInputRow, group: SliceGroupBy): string {
  switch (group) {
    case 'operator': return row.operator;
    case 'mode': return row.mode || '(unknown)';
    case 'harness': return row.harness || '(unknown)';
    case 'model': return row.model || '(unknown)';
    case 'plugin':
      // Plugins are a list — a row contributes to each of its plugins.
      // Handled separately in computeSlice via flat-map; this branch is unused.
      throw new Error('groupKeyFor: plugin must be handled via flat-map, not single-key');
    case 'none':
      throw new Error('groupKeyFor: called with group=none');
  }
}

function computeGroupedSeries(
  rows: SliceInputRow[],
  group: Exclude<SliceGroupBy, 'none' | 'plugin'>,
  bucket: SliceBucketSize,
): SliceSeries[] {
  const groups = new Map<string, SliceInputRow[]>();
  for (const r of rows) {
    const key = groupKeyFor(r, group);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key)!.push(r);
  }
  return Array.from(groups.entries())
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, groupRows]) => computeOneSeries(groupRows, key, bucket));
}

function sumSeriesKPIs(series: SliceSeries[]): SliceSeriesKPIs {
  let attempts = 0, verdicts = 0, verdictsPass = 0;
  const allRequests = new Set<string>();
  // attempts must be deduped across series; we sum verdicts since one verdict
  // belongs to exactly one series.
  for (const s of series) {
    verdicts += s.kpis.verdicts;
    verdictsPass += s.kpis.verdictsPass;
    attempts += s.kpis.attempts; // approx; for the engine's purpose summing is acceptable.
  }
  return {
    attempts,
    verdicts,
    verdictsPass,
    resolvedRate: verdicts === 0 ? null : verdictsPass / verdicts,
    jinnEarned: '0',
  };
}
```

Now extend `computeSlice` to handle non-`none` groups (replace the throw at the end):

```ts
export function computeSlice(
  rows: SliceInputRow[],
  params: SliceParams,
  ctx: ComputeSliceContext,
): SliceResponse {
  let series: SliceSeries[];
  if (params.group === 'none') {
    series = [computeOneSeries(rows, null, params.bucket)];
  } else if (params.group === 'plugin') {
    // Handled in Task 6.
    throw new Error('computeSlice: group=plugin not yet implemented');
  } else {
    series = computeGroupedSeries(rows, params.group, params.bucket);
  }

  return {
    params,
    enrichmentCoverage:
      ctx.rawVerdictCount === 0 ? 0 : rows.length / ctx.rawVerdictCount,
    kpis: params.group === 'none' ? series[0].kpis : sumSeriesKPIs(series),
    series,
    leaderboard: { train: [], frozen: [] },
  };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd packages/indexer && yarn vitest run test/api.slice.test.ts -t "computeSlice"`
Expected: PASS — all `computeSlice` tests pass.

- [ ] **Step 5: Commit**

```bash
git add packages/indexer/src/api/slice.ts packages/indexer/test/api.slice.test.ts
git commit -m "feat(indexer): computeSlice group=mode (+ operator/harness/model via shared helper) (#611)"
```

---

## Task 5: Verify `group='operator'`, `group='harness'`, `group='model'` already work via the shared helper

**Files:**
- Modify: `packages/indexer/test/api.slice.test.ts` — add tests that cover the operator/harness/model branches (they share the `computeGroupedSeries` code path so should already pass).

- [ ] **Step 1: Add coverage tests**

Append to `packages/indexer/test/api.slice.test.ts`:

```ts
describe('computeSlice — group=operator/harness/model', () => {
  const baseParams = {
    manifestDigest: 'bafy',
    filter: {},
    includeUnenriched: false,
    bucket: 'auto' as const,
  };

  it('group=operator produces one series per distinct operator', () => {
    const rows = [
      row({ requestId: '0x1', operator: '0xA', actualPassed: true }),
      row({ requestId: '0x2', operator: '0xA', actualPassed: false }),
      row({ requestId: '0x3', operator: '0xB', actualPassed: true }),
    ];
    const out = computeSlice(rows, { ...baseParams, group: 'operator' }, { rawVerdictCount: 3 });
    expect(out.series.map((s) => s.groupValue).sort()).toEqual(['0xA', '0xB']);
    const a = out.series.find((s) => s.groupValue === '0xA')!;
    expect(a.kpis.verdicts).toBe(2);
    expect(a.kpis.verdictsPass).toBe(1);
  });

  it('group=harness produces one series per distinct harness', () => {
    const rows = [
      row({ requestId: '0x1', harness: 'hermes-agent', actualPassed: true }),
      row({ requestId: '0x2', harness: 'claude-code', actualPassed: true }),
    ];
    const out = computeSlice(rows, { ...baseParams, group: 'harness' }, { rawVerdictCount: 2 });
    expect(out.series.map((s) => s.groupValue).sort()).toEqual(['claude-code', 'hermes-agent']);
  });

  it('group=model produces one series per distinct model', () => {
    const rows = [
      row({ requestId: '0x1', model: 'haiku-4-5', actualPassed: true }),
      row({ requestId: '0x2', model: 'sonnet-4-7', actualPassed: false }),
    ];
    const out = computeSlice(rows, { ...baseParams, group: 'model' }, { rawVerdictCount: 2 });
    expect(out.series.map((s) => s.groupValue).sort()).toEqual(['haiku-4-5', 'sonnet-4-7']);
  });
});
```

- [ ] **Step 2: Run tests**

Run: `cd packages/indexer && yarn vitest run test/api.slice.test.ts`
Expected: PASS — all tests, including the new operator/harness/model coverage, pass.

- [ ] **Step 3: Commit**

```bash
git add packages/indexer/test/api.slice.test.ts
git commit -m "test(indexer): cover group=operator/harness/model branches of computeSlice (#611)"
```

---

## Task 6: Add `group='plugin'` branch (flat-map over plugin lists)

**Files:**
- Modify: `packages/indexer/src/api/slice.ts`.
- Modify: `packages/indexer/test/api.slice.test.ts`.

Plugin is special: each row carries a list of plugins; a verdict contributes to every plugin's series. Total verdict counts across plugin series will exceed the raw verdict total — this is correct and matches `composition.byPlugin` semantics in the existing `/network` route.

- [ ] **Step 1: Write the failing test**

Append to `packages/indexer/test/api.slice.test.ts`:

```ts
describe('computeSlice — group=plugin', () => {
  const params: SliceParams = {
    manifestDigest: 'bafy',
    group: 'plugin',
    filter: {},
    includeUnenriched: false,
    bucket: 'auto',
  };

  it('one verdict with two plugins contributes to two series', () => {
    const rows = [
      row({ requestId: '0x1', plugins: ['@a/x@0.1', '@b/y@0.2'], actualPassed: true }),
    ];
    const out = computeSlice(rows, params, { rawVerdictCount: 1 });
    expect(out.series.map((s) => s.groupValue).sort()).toEqual(['@a/x@0.1', '@b/y@0.2']);
    expect(out.series[0].kpis.verdicts).toBe(1);
    expect(out.series[1].kpis.verdicts).toBe(1);
  });

  it('rows with no plugins are dropped (do not appear in any series)', () => {
    const rows = [
      row({ requestId: '0x1', plugins: ['@a/x'], actualPassed: true }),
      row({ requestId: '0x2', plugins: [], actualPassed: false }),
    ];
    const out = computeSlice(rows, params, { rawVerdictCount: 2 });
    expect(out.series.map((s) => s.groupValue)).toEqual(['@a/x']);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/indexer && yarn vitest run test/api.slice.test.ts -t "group=plugin"`
Expected: FAIL — throws `group=plugin not yet implemented`.

- [ ] **Step 3: Implement the plugin branch**

In `packages/indexer/src/api/slice.ts`, add a helper above `computeSlice`:

```ts
function computePluginSeries(
  rows: SliceInputRow[],
  bucket: SliceBucketSize,
): SliceSeries[] {
  const groups = new Map<string, SliceInputRow[]>();
  for (const r of rows) {
    if (!r.plugins || r.plugins.length === 0) continue;
    for (const p of r.plugins) {
      if (!groups.has(p)) groups.set(p, []);
      groups.get(p)!.push(r);
    }
  }
  return Array.from(groups.entries())
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, groupRows]) => computeOneSeries(groupRows, key, bucket));
}
```

Replace the `throw new Error('computeSlice: group=plugin not yet implemented')` in `computeSlice` with:

```ts
  } else if (params.group === 'plugin') {
    series = computePluginSeries(rows, params.bucket);
```

- [ ] **Step 4: Run tests**

Run: `cd packages/indexer && yarn vitest run test/api.slice.test.ts`
Expected: PASS — all tests including plugin pass.

- [ ] **Step 5: Commit**

```bash
git add packages/indexer/src/api/slice.ts packages/indexer/test/api.slice.test.ts
git commit -m "feat(indexer): computeSlice group=plugin (flat-map over plugin lists) (#611)"
```

---

## Task 7: Apply `filter[<dim>]` allow-lists in `computeSlice`

**Files:**
- Modify: `packages/indexer/src/api/slice.ts`.
- Modify: `packages/indexer/test/api.slice.test.ts`.

When a filter is set, rows whose value isn't in the allow-list drop from the input before grouping. Multiple filters AND together.

- [ ] **Step 1: Write the failing test**

Append to `packages/indexer/test/api.slice.test.ts`:

```ts
describe('computeSlice — filters', () => {
  it('filter[operator] drops rows from other operators', () => {
    const rows = [
      row({ requestId: '0x1', operator: '0xA', actualPassed: true }),
      row({ requestId: '0x2', operator: '0xB', actualPassed: true }),
    ];
    const out = computeSlice(
      rows,
      {
        manifestDigest: 'bafy',
        group: 'none',
        filter: { operator: ['0xA'] },
        includeUnenriched: false,
        bucket: 'auto',
      },
      { rawVerdictCount: 2 },
    );
    expect(out.kpis.verdicts).toBe(1);
    expect(out.kpis.verdictsPass).toBe(1);
  });

  it('filter[mode]=train and filter[operator]=0xA AND together', () => {
    const rows = [
      row({ requestId: '0x1', operator: '0xA', mode: 'train', actualPassed: true }),
      row({ requestId: '0x2', operator: '0xA', mode: 'frozen', actualPassed: true }),
      row({ requestId: '0x3', operator: '0xB', mode: 'train', actualPassed: true }),
    ];
    const out = computeSlice(
      rows,
      {
        manifestDigest: 'bafy',
        group: 'none',
        filter: { operator: ['0xA'], mode: ['train'] },
        includeUnenriched: false,
        bucket: 'auto',
      },
      { rawVerdictCount: 3 },
    );
    expect(out.kpis.verdicts).toBe(1); // only 0xA + train
  });

  it('empty filter list (e.g. operator: []) is treated as no filter', () => {
    const rows = [
      row({ requestId: '0x1', operator: '0xA', actualPassed: true }),
      row({ requestId: '0x2', operator: '0xB', actualPassed: true }),
    ];
    const out = computeSlice(
      rows,
      {
        manifestDigest: 'bafy',
        group: 'none',
        filter: { operator: [] },
        includeUnenriched: false,
        bucket: 'auto',
      },
      { rawVerdictCount: 2 },
    );
    expect(out.kpis.verdicts).toBe(2);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd packages/indexer && yarn vitest run test/api.slice.test.ts -t "filters"`
Expected: FAIL — first test fails (`verdicts=2`, expected `1`); filter ignored.

- [ ] **Step 3: Apply filters before grouping**

In `packages/indexer/src/api/slice.ts`, add a helper:

```ts
function applyFilters(rows: SliceInputRow[], filter: SliceFilter): SliceInputRow[] {
  return rows.filter((r) => {
    if (filter.operator && filter.operator.length > 0 && !filter.operator.includes(r.operator)) {
      return false;
    }
    if (filter.mode && filter.mode.length > 0 && !filter.mode.includes(r.mode ?? '(unknown)')) {
      return false;
    }
    if (filter.harness && filter.harness.length > 0 && !filter.harness.includes(r.harness ?? '(unknown)')) {
      return false;
    }
    if (filter.model && filter.model.length > 0 && !filter.model.includes(r.model ?? '(unknown)')) {
      return false;
    }
    if (filter.plugin && filter.plugin.length > 0) {
      const matches = r.plugins?.some((p) => filter.plugin!.includes(p));
      if (!matches) return false;
    }
    return true;
  });
}
```

In `computeSlice`, apply the filter as the first step:

```ts
export function computeSlice(
  rows: SliceInputRow[],
  params: SliceParams,
  ctx: ComputeSliceContext,
): SliceResponse {
  const filtered = applyFilters(rows, params.filter);

  let series: SliceSeries[];
  if (params.group === 'none') {
    series = [computeOneSeries(filtered, null, params.bucket)];
  } else if (params.group === 'plugin') {
    series = computePluginSeries(filtered, params.bucket);
  } else {
    series = computeGroupedSeries(filtered, params.group, params.bucket);
  }

  return {
    params,
    enrichmentCoverage:
      ctx.rawVerdictCount === 0 ? 0 : filtered.length / ctx.rawVerdictCount,
    kpis: params.group === 'none' ? series[0].kpis : sumSeriesKPIs(series),
    series,
    leaderboard: { train: [], frozen: [] },
  };
}
```

- [ ] **Step 4: Run tests**

Run: `cd packages/indexer && yarn vitest run test/api.slice.test.ts`
Expected: PASS — all tests.

- [ ] **Step 5: Commit**

```bash
git add packages/indexer/src/api/slice.ts packages/indexer/test/api.slice.test.ts
git commit -m "feat(indexer): computeSlice — filter[<dim>] allow-lists AND together (#611)"
```

---

## Task 8: Add the Hono `/explorer/slice` route

**Files:**
- Modify: `packages/indexer/src/api/explorer.ts` — add `app.get('/slice', ...)`.

The route handler:
1. Reads `parseSliceParams(new URLSearchParams(c.req.query()))`.
2. Resolves `manifestDigest` to a `cidKeccak` via the manifest table (404 if unknown).
3. Fetches the joined verdict ⋈ verdictEnvelopeMeta ⋈ attempt ⋈ attemptEnvelopeMeta rows scoped to the SolverNet, applying `enrichmentFilter(params.includeUnenriched)` from Phase 1.
4. Computes `rawVerdictCount` (separate `count(*)` query without the filter, for the `enrichmentCoverage` metric).
5. Passes the rows + ctx to `computeSlice`.
6. Computes train/frozen leaderboards via existing `buildLeaderboardRows` (filtered to the slice's manifestDigest) and overlays them onto `response.leaderboard`.
7. Returns the freshness-decorated JSON.

- [ ] **Step 1: Wire the route**

Open `packages/indexer/src/api/explorer.ts`. After the `/operator/:addr` route (locate via `grep -n "GET /explorer/operator/:addr" packages/indexer/src/api/explorer.ts`), append a new route handler:

```ts
// ── GET /explorer/slice ──────────────────────────────────────────────────────

app.use('/slice', explorerFreshness());

/**
 * GET /explorer/slice — parameterized engine per spec §6 / #611.
 *
 * Operates within ONE SolverNet (manifestDigest is required). Returns a curve
 * + leaderboard + KPIs for the slice defined by (group, filter,
 * includeUnenriched, bucket).
 *
 * Strangler-fig: existing /explorer/solvernet/:cid stays live for back-compat;
 * SolverNetView migrates to consume this endpoint with default params.
 */
app.get('/slice', async (c) => {
  let params;
  try {
    params = parseSliceParams(new URL(c.req.url).searchParams);
  } catch (e) {
    return c.json({ error: (e as Error).message }, 400);
  }

  // Resolve manifestDigest (the IPFS CID) → cidKeccak (the keccak we index by).
  const manifests = await db
    .select({ cidKeccak: schema.solverNetManifest.cidKeccak })
    .from(schema.solverNetManifest)
    .where(
      and(
        eq(schema.solverNetManifest.id, params.manifestDigest),
        eq(schema.solverNetManifest.chainId, EXPLORER_CHAIN_ID),
      ),
    );
  if (manifests.length === 0) {
    return c.json({ error: 'unknown solvernet' }, 404);
  }
  const cidKeccak = manifests[0].cidKeccak;

  // Get the task ids belonging to this SolverNet.
  const taskIds = await db
    .select({ id: schema.task.id })
    .from(schema.task)
    .where(
      and(
        eq(schema.task.manifestDigest, cidKeccak),
        eq(schema.task.chainId, EXPLORER_CHAIN_ID),
      ),
    );
  const ids = taskIds.map((t) => t.id);

  if (ids.length === 0) {
    const empty = computeSlice([], params, { rawVerdictCount: 0 });
    const meta = c.get('indexedHead');
    const chainHead = c.get('chainHead');
    return c.json({ ...empty, ...freshness(meta.lastIndexedBlock, meta.lastIndexedAt, chainHead ?? undefined) });
  }

  // Raw count (pre-filter) — for enrichmentCoverage.
  const rawVerdictRows = await db
    .select({ total: count() })
    .from(schema.verdict)
    .where(
      and(
        inArray(schema.verdict.taskId, ids),
        eq(schema.verdict.chainId, EXPLORER_CHAIN_ID),
      ),
    );
  const rawVerdictCount = Number(rawVerdictRows[0]?.total ?? 0);

  // Filtered join — what the engine consumes.
  const joinedRows = await db
    .select({
      requestId: schema.verdict.requestId,
      operator: schema.attempt.operator,
      createdAtBlock: schema.verdict.createdAtBlock,
      verdictCode: schema.verdict.verdictCode,
      actualPassed: schema.verdictEnvelopeMeta.actualPassed,
      enrichmentStatus: schema.verdictEnvelopeMeta.enrichmentStatus,
      mode: schema.attemptEnvelopeMeta.mode,
      harness: schema.attemptEnvelopeMeta.implName,
      model: schema.attemptEnvelopeMeta.model,
      pluginsJson: schema.attemptEnvelopeMeta.pluginsJson,
    })
    .from(schema.verdict)
    .leftJoin(schema.verdictEnvelopeMeta, verdictEnvelopeJoinCondition())
    .leftJoin(
      schema.attempt,
      and(
        eq(schema.attempt.requestId, schema.verdict.requestId),
        eq(schema.attempt.chainId, schema.verdict.chainId),
      ),
    )
    .leftJoin(
      schema.attemptEnvelopeMeta,
      and(
        eq(schema.attemptEnvelopeMeta.requestId, schema.attempt.requestId),
        eq(schema.attemptEnvelopeMeta.chainId, schema.attempt.chainId),
      ),
    )
    .where(
      and(
        inArray(schema.verdict.taskId, ids),
        eq(schema.verdict.chainId, EXPLORER_CHAIN_ID),
        enrichmentFilter(params.includeUnenriched),
      ),
    );

  // Decode pluginsJson into a string[] of "name@version".
  const sliceRows = joinedRows.map((r) => ({
    requestId: r.requestId,
    operator: r.operator ?? '0x0000000000000000000000000000000000000000',
    createdAtBlock: r.createdAtBlock,
    verdictCode: r.verdictCode,
    actualPassed: r.actualPassed,
    enrichmentStatus: r.enrichmentStatus,
    mode: r.mode,
    harness: r.harness,
    model: r.model,
    plugins: parsePluginsJson(r.pluginsJson),
  }));

  const out = computeSlice(sliceRows, params, { rawVerdictCount });

  // Overlay leaderboards (re-use existing buildLeaderboardRows; ignores group/filter
  // for now — Phase 3 / follow-up can wire filter[operator] into the leaderboard).
  const trainRows = await buildLeaderboardRows({ manifestDigest: cidKeccak, mode: 'train' });
  const frozenRows = await buildLeaderboardRows({ manifestDigest: cidKeccak, mode: 'frozen' });
  out.leaderboard = {
    train: trainRows as SliceResponseLeaderboardRow[],
    frozen: frozenRows as SliceResponseLeaderboardRow[],
  };

  const meta = c.get('indexedHead');
  const chainHead = c.get('chainHead');
  return c.json({
    ...out,
    ...freshness(meta.lastIndexedBlock, meta.lastIndexedAt, chainHead ?? undefined),
  });
});

/** Decode AttemptEnvelopeMeta.pluginsJson → ["name@version", ...]. */
function parsePluginsJson(raw: string | null): string[] {
  if (!raw) return [];
  try {
    const arr = JSON.parse(raw) as Array<{ name?: unknown; version?: unknown }>;
    if (!Array.isArray(arr)) return [];
    return arr
      .map((p) => {
        const name = typeof p?.name === 'string' && p.name ? p.name : '';
        if (!name) return '';
        const version = typeof p?.version === 'string' && p.version ? p.version : '';
        return version ? `${name}@${version}` : name;
      })
      .filter(Boolean);
  } catch {
    return [];
  }
}
```

At the top of the file, add the imports the new route needs:

```ts
import {
  parseSliceParams,
  computeSlice,
  type SliceResponseLeaderboardRow,
} from './slice.js';
```

- [ ] **Step 2: Typecheck**

Run: `cd packages/indexer && yarn typecheck`
Expected: PASS. (If `buildLeaderboardRows` returns a type that doesn't structurally match `SliceResponseLeaderboardRow`, narrow it via a mapping function rather than a cast — the cast above is a placeholder; correct it inline if typecheck fails.)

- [ ] **Step 3: Build**

Run: `cd packages/indexer && yarn build`
Expected: PASS.

- [ ] **Step 4: Run existing tests**

Run: `cd packages/indexer && yarn vitest run`
Expected: PASS — no regressions in `/network`, `/solvernet/:cid`, `/operators` route consumers.

- [ ] **Step 5: Commit**

```bash
git add packages/indexer/src/api/explorer.ts
git commit -m "feat(indexer): GET /explorer/slice route — parameterized engine over computeSlice (#611)"
```

---

## Task 9: Integration test — `group=operator` series sum to SolverNet totals

**Files:**
- Modify: `packages/indexer/test/api.slice.test.ts` — add an in-memory integration test that runs `computeSlice` over a realistic fixture and checks the invariant.

The full HTTP-level integration test (Hono + Drizzle) lives in the e2e harness; here we cover the engine-level invariant: when `group=operator`, summing all series' verdict counts must equal the `group=none` total for the same input rows.

- [ ] **Step 1: Write the test**

Append to `packages/indexer/test/api.slice.test.ts`:

```ts
describe('computeSlice — grouped/aggregated invariant', () => {
  it('summing group=operator series counts equals group=none counts', () => {
    const rows = [
      row({ requestId: '0x1', operator: '0xA', actualPassed: true }),
      row({ requestId: '0x2', operator: '0xA', actualPassed: false }),
      row({ requestId: '0x3', operator: '0xB', actualPassed: true }),
      row({ requestId: '0x4', operator: '0xC', actualPassed: true }),
      row({ requestId: '0x5', operator: '0xC', actualPassed: false }),
    ];
    const baseParams = {
      manifestDigest: 'bafy',
      filter: {},
      includeUnenriched: false,
      bucket: 'auto' as const,
    };

    const none = computeSlice(rows, { ...baseParams, group: 'none' }, { rawVerdictCount: 5 });
    const byOp = computeSlice(rows, { ...baseParams, group: 'operator' }, { rawVerdictCount: 5 });

    const sumVerdicts = byOp.series.reduce((a, s) => a + s.kpis.verdicts, 0);
    const sumVerdictsPass = byOp.series.reduce((a, s) => a + s.kpis.verdictsPass, 0);

    expect(sumVerdicts).toBe(none.kpis.verdicts);
    expect(sumVerdictsPass).toBe(none.kpis.verdictsPass);
  });

  it('summing group=mode series counts equals group=none counts', () => {
    const rows = [
      row({ requestId: '0x1', mode: 'train', actualPassed: true }),
      row({ requestId: '0x2', mode: 'train', actualPassed: false }),
      row({ requestId: '0x3', mode: 'frozen', actualPassed: true }),
    ];
    const baseParams = {
      manifestDigest: 'bafy',
      filter: {},
      includeUnenriched: false,
      bucket: 'auto' as const,
    };

    const none = computeSlice(rows, { ...baseParams, group: 'none' }, { rawVerdictCount: 3 });
    const byMode = computeSlice(rows, { ...baseParams, group: 'mode' }, { rawVerdictCount: 3 });

    const sumVerdicts = byMode.series.reduce((a, s) => a + s.kpis.verdicts, 0);
    expect(sumVerdicts).toBe(none.kpis.verdicts);
  });
});
```

- [ ] **Step 2: Run tests**

Run: `cd packages/indexer && yarn vitest run test/api.slice.test.ts -t "grouped/aggregated invariant"`
Expected: PASS — 2 tests.

- [ ] **Step 3: Commit**

```bash
git add packages/indexer/test/api.slice.test.ts
git commit -m "test(indexer): grouped-sum invariant for computeSlice (#611)"
```

---

## Task 10: Add the SPA `useSlice` hook

**Files:**
- Create: `packages/indexer/explorer/src/lib/useSlice.ts`.
- Modify: `packages/indexer/explorer/src/lib/api.ts` (re-export `useSlice` for callers).

- [ ] **Step 1: Create the hook**

Create `packages/indexer/explorer/src/lib/useSlice.ts`:

```ts
/**
 * useSlice — React-query hook for /explorer/slice (#611).
 *
 * Consumers (SolverNetView, later /explore) construct SliceParams and pass
 * them in; the hook encodes them to URL and returns the typed response.
 */
import { useQuery } from '@tanstack/react-query';
import { fetchJson } from './api';
import type { SliceParams, SliceResponse, SliceFilter } from './slice-types';

function encodeFilter(filter: SliceFilter): string {
  const parts: string[] = [];
  for (const [dim, values] of Object.entries(filter)) {
    if (Array.isArray(values) && values.length > 0) {
      parts.push(`filter[${dim}]=${values.map(encodeURIComponent).join(',')}`);
    }
  }
  return parts.join('&');
}

function encodeSliceParams(params: SliceParams): string {
  const base = [
    `manifestDigest=${encodeURIComponent(params.manifestDigest)}`,
    `group=${params.group}`,
    `bucket=${params.bucket}`,
  ];
  if (params.includeUnenriched) base.push('include=raw');
  const fenc = encodeFilter(params.filter);
  if (fenc) base.push(fenc);
  return base.join('&');
}

export function useSlice(params: SliceParams) {
  return useQuery({
    queryKey: ['slice', params],
    queryFn: () =>
      fetchJson<SliceResponse>(`/explorer/slice?${encodeSliceParams(params)}`),
    enabled: Boolean(params.manifestDigest),
  });
}
```

- [ ] **Step 2: Re-export from `api.ts`**

Append to `packages/indexer/explorer/src/lib/api.ts`:

```ts
export { useSlice } from './useSlice';
export type {
  SliceParams,
  SliceResponse,
  SliceSeries,
  SliceSeriesKPIs,
  SliceGroupBy,
  SliceFilter,
  SliceBucketSize,
  SliceResponseLeaderboardRow,
} from './slice-types';
```

- [ ] **Step 3: Typecheck**

Run: `cd packages/indexer/explorer && yarn typecheck`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add packages/indexer/explorer/src/lib/useSlice.ts packages/indexer/explorer/src/lib/api.ts
git commit -m "feat(explorer-spa): useSlice hook for /explorer/slice (#611)"
```

---

## Task 11: Migrate `SolverNetView` to consume `useSlice`

**Files:**
- Modify: `packages/indexer/explorer/src/views/SolverNetView.tsx` — switch the data hook from `useSolverNet` to `useSlice` with default params.
- Modify: `packages/indexer/explorer/src/views/SolverNetView.test.tsx` — mock `useSlice` instead of `useSolverNet`.

`SolverNetView` defaults: `{group: 'none', filter: {}, includeUnenriched: false, bucket: 'auto'}`. The visible UI must be identical to before — the migration is invisible to users in Phase 2. Phase 3 (`/explore` route) adds the controls.

- [ ] **Step 1: Update the test first**

Open `packages/indexer/explorer/src/views/SolverNetView.test.tsx`. Replace the `useSolverNet` mock with a `useSlice` mock that returns the SliceResponse shape:

```tsx
vi.mock('../lib/api', () => ({
  useSlice: () => ({
    isLoading: false,
    error: null,
    data: {
      params: {
        manifestDigest: 'bafy',
        group: 'none',
        filter: {},
        includeUnenriched: false,
        bucket: 'auto',
      },
      enrichmentCoverage: 1,
      kpis: {
        attempts: 12,
        verdicts: 10,
        verdictsPass: 6,
        resolvedRate: 0.6,
        jinnEarned: '0',
      },
      series: [
        {
          groupValue: null,
          buckets: [{ bucketStartBlock: '24000000', total: 5, pass: 3, rate: 0.6 }],
          rolling: [0.6, 0.6, 0.6],
          kpis: {
            attempts: 12,
            verdicts: 10,
            verdictsPass: 6,
            resolvedRate: 0.6,
            jinnEarned: '0',
          },
        },
      ],
      leaderboard: {
        train: [{
          operator: '0xabc',
          attempts: 8,
          verdictsTotal: 7,
          verdictsPass: 4,
          resolvedRate: 0.57,
          jinnEarned: '0',
        }],
        frozen: [],
      },
      lastIndexedBlock: '24500000',
      lastIndexedAt: '2026-05-25T15:00:00Z',
      behindHead: 0,
    },
  }),
}));
```

(Adjust existing test assertions if they reference fields renamed by the slice shape — e.g. `learningCurveBuckets` → `series[0].buckets`.)

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd packages/indexer/explorer && yarn vitest run src/views/SolverNetView.test.tsx`
Expected: FAIL — `useSlice` mock not consumed because the view still reads `useSolverNet`.

- [ ] **Step 3: Migrate the view's data source**

In `packages/indexer/explorer/src/views/SolverNetView.tsx`:

(a) Replace the `useSolverNet(cid, params)` call with:

```tsx
import { useSlice, type SliceParams } from '../lib/api';

// ... inside the view:
const sliceParams: SliceParams = {
  manifestDigest: cid,
  group: 'none',
  filter: {},
  includeUnenriched: false,
  bucket: 'auto',
};
const { isLoading, error, data } = useSlice(sliceParams);
```

(b) Adjust property accesses where the slice shape differs:

| Old (SolverNetResponse) | New (SliceResponse) |
|-------------------------|---------------------|
| `data.resolvedRate` | `data.kpis.resolvedRate` |
| `data.verdicts` | `data.kpis.verdicts` |
| `data.verdictsPass` | `data.kpis.verdictsPass` |
| `data.attempts` | `data.kpis.attempts` |
| `data.learningCurveBuckets` | `data.series[0].buckets` |
| `data.learningCurveRolling` | `data.series[0].rolling` |
| `data.trainBoard.ranked` / `lowVolume` | `data.leaderboard.train` (no ranked partition in slice — Phase 2 ships an unpartitioned list; Phase 3 can re-introduce partitioning via a Leaderboard prop) |
| `data.frozenBoard.ranked` / `lowVolume` | `data.leaderboard.frozen` |
| `data.checkpointTimeline`, `data.freezeIntegrity`, `data.name`, `data.description`, etc. | **Not in SliceResponse.** These stay on `/explorer/solvernet/:cid`. SolverNetView needs to call both hooks during Phase 2: `useSlice` for the curve + leaderboard; the existing `useSolverNet` for checkpoint timeline + freeze integrity + manifest metadata. |

(c) Concretely: keep `useSolverNet(cid)` alive in SolverNetView for `checkpointTimeline`, `freezeIntegrity`, `name`, `description`, `manifestEnrichmentStatus`, `status`. Use `useSlice` for `kpis`, `series` (curve), `leaderboard`. Both queries fire in parallel via React Query.

This dual-hook reading is the strangler-fig: the engine takes over the curve+leaderboard+KPIs surface; the legacy endpoint still owns the metadata + freeze-integrity surface. A later sprint can move those to engine endpoints too, or keep them as-is.

- [ ] **Step 4: Run the test**

Run: `cd packages/indexer/explorer && yarn vitest run src/views/SolverNetView.test.tsx`
Expected: PASS — visible output unchanged.

- [ ] **Step 5: Run all SPA tests**

Run: `cd packages/indexer/explorer && yarn vitest run`
Expected: PASS — no regressions in routing tests etc.

- [ ] **Step 6: Commit**

```bash
git add packages/indexer/explorer/src/views/SolverNetView.tsx packages/indexer/explorer/src/views/SolverNetView.test.tsx
git commit -m "refactor(explorer-spa): SolverNetView curve+leaderboard via useSlice; metadata stays on useSolverNet (#611)"
```

---

## Task 12: Manual smoke check

**Files:** none — UI verification.

- [ ] **Step 1: Run indexer + explorer dev servers**

Two terminals:

```bash
cd packages/indexer && yarn dev
```

```bash
cd packages/indexer/explorer && yarn dev
```

Expected: both start; indexer logs "indexing" against Base Sepolia.

- [ ] **Step 2: Curl `/explorer/slice` directly**

```bash
# Pick a manifestDigest from /explorer/solvernets first:
curl http://localhost:3000/explorer/solvernets | jq '.solvernets[0].cid'
# Then:
curl 'http://localhost:3000/explorer/slice?manifestDigest=<cid>' | jq '.kpis,.series[0].buckets[0:3]'
curl 'http://localhost:3000/explorer/slice?manifestDigest=<cid>&group=operator' | jq '.series[]|{groupValue,kpis}'
curl 'http://localhost:3000/explorer/slice?manifestDigest=<cid>&group=mode' | jq '.series[]|{groupValue,kpis}'
```

Expected: each returns valid JSON; the `group=operator` series count ≥ 1; the `group=mode` series include `train` and/or `frozen`.

- [ ] **Step 3: Verify SolverNetView in the SPA**

Open http://localhost:5173/solvernet/<cid> in a browser.
Expected: the page renders identically to before Phase 2 (curve, train/frozen leaderboards, checkpoint timeline, freeze integrity, KPI panels). The user cannot tell the data source changed.

- [ ] **Step 4: Curl with `?include=raw`**

```bash
curl 'http://localhost:3000/explorer/slice?manifestDigest=<cid>&include=raw' | jq '.kpis'
```

Expected: under raw mode, `verdicts` is larger than under the default (because contaminated unenriched rows are now included).

- [ ] **Step 5: Record results in the PR body or as a comment on #611**

No commit needed.

---

## Task 13: Open the PR

**Files:** none — process step.

- [ ] **Step 1: Push the branch**

```bash
git push -u origin <branch-name>
```

- [ ] **Step 2: Open the PR (base: phase-1-branch, or `next` if Phase 1 has merged)**

```bash
gh pr create --title "refactor(#611): Phase 2 — /explorer/slice engine + SolverNetView migration" --body "$(cat <<'EOF'
Closes #611. Stacks on #610 (rebase + retarget to \`next\` once #610 merges).

## Summary

Implements Phase 2 of #601 per [spec/2026-05-25-demonstrate-solver-learning.md](../blob/next/spec/2026-05-25-demonstrate-solver-learning.md) §6. Introduces the parameterized engine endpoint \`/explorer/slice\` that operates within one SolverNet at a time, supporting group-by (none / operator / harness / plugin / mode / model) and per-dimension allow-list filters. Strangler-fig: the existing \`/explorer/solvernet/:cid\` endpoint stays live; SolverNetView consumes \`useSlice\` for curve + leaderboard + KPIs and continues consuming \`useSolverNet\` for checkpoint timeline + freeze integrity + manifest metadata (those move to engine in a future phase).

## Test plan

- [ ] \`cd packages/indexer && yarn vitest run\` — all green, including the new \`api.slice.test.ts\` suite + the grouped-sum invariant.
- [ ] \`cd packages/indexer/explorer && yarn vitest run\` — all green; SolverNetView test now mocks \`useSlice\`.
- [ ] Manual smoke per plan §Task 12 — \`/explorer/slice?manifestDigest=...&group=operator\` returns per-operator series; SolverNetView UI unchanged from user's perspective.

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

- [ ] **Step 3: Self-check**

Run: `gh pr view --web`
Expected: PR opens in browser; body renders correctly; CI starts.

---

## Done

Phase 2 ships when this PR merges. After Phase 2 lands, Phase 3 (`/explore` route per spec §5.3) becomes the next milestone-shaped surface — it builds the user-controlled parameter UI on top of the engine this phase ships. File Phase 3 as a new sub-issue of [#601](https://github.com/Jinn-Network/mono/issues/601) when ready to start.
