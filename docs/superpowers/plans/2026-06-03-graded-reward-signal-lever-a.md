# Graded Reward Signal (Lever A) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Expose the per-test graded score the swe-rebench-v2 grader already computes, carry it on-chain alongside the existing pass/fail bit (additive `verdict.v2`), and feed it into the learner's keep/revert gate as a lower-variance estimator via a two-tier (binary-objective, graded-sensitivity) decision.

**Architecture:** Additive-only data plumbing — grader → SDK payload → indexer column → discovery row → learner gate. The binary verdict (`actualPassed`/`score ∈ {0,1}`) is never changed; graded fields are new, nullable, and read **only** by the learning loop (never emissions). The gate keeps its existing two-proportion z-test as the objective and adds a Mann-Whitney sensitivity tier that fires when the binary tier abstains for want of samples.

**Tech Stack:** TypeScript, Zod (SDK payload schemas), Ponder/Drizzle (indexer), GraphQL (discovery), Vitest (tests). Monorepo with Yarn workspaces: `packages/sdk`, `packages/indexer`, `client`.

**Spec:** `docs/superpowers/specs/2026-06-03-graded-reward-signal-lever-a-design.md` · **Issue:** #1019

**Conventions:**
- Each package runs tests from its own dir: `packages/sdk`, `packages/indexer`, `client`.
- The `client` test script builds the SDK first; when iterating on a single client test use `cd client && yarn vitest run <path>` (vitest is in the client toolchain).
- Commit after every green step. Branch: `design/graded-reward-signal-lever-a` (worktree `../jinn-mono_worktrees/lever-a`).

---

## File Structure

**Create:**
- (none — all changes extend existing files; new tests live beside existing ones)

**Modify:**
- `packages/sdk/src/payloads/swe-rebench-v2.ts` — add `SweRebenchV2VerdictV2PayloadSchema` (adds `passedCount`/`totalCount`) + a `SweRebenchV2VerdictPayloadSchema` union accepting v1 or v2.
- `client/src/harnesses/impls/swe-rebench-v2-evaluator/index.ts` — emit `passedCount`/`totalCount` from the `passed[]`/`failed[]` arrays already in hand.
- `packages/indexer/ponder.schema.ts` — add `passedCount`/`totalCount` integer columns to `verdictEnvelopeMeta`.
- `packages/indexer/src/handlers.ts` — `parseVerdictEnvelopeLite` reads the graded fields; the insert/upsert writes them.
- `client/src/discovery/types.ts` — add `gradedScores: number[]` to `CodeDigestRewardRow`.
- `client/src/discovery/http.ts` — fetch graded columns in the verdict query, collect per-attempt graded scores.
- `client/src/discovery/onchain.ts` — floor stub returns `gradedScores: []`.
- `client/src/learner/revert-stats.ts` — add pure `mannWhitneyU`.
- `client/src/learner/revert-decision.ts` — two-tier gate, new policy fields, new reasons, `gradedScores` on the aggregate.
- `client/src/cli/commands/codedigest-revert-check.ts` — thread `gradedScores` from row → aggregate.

**Test (modify/extend):**
- `packages/sdk/test/swe-rebench-v2-payloads.test.ts`
- `client/test/harnesses/impls/swe-rebench-v2-evaluator/index.test.ts`
- `packages/indexer/test/handlers.test.ts`
- `client/test/discovery/types.codedigest-reward.test.ts`
- `client/test/discovery/http.codedigest-rewards.test.ts`
- `client/test/learner/revert-stats.test.ts`
- `client/test/learner/revert-decision.test.ts`
- `client/test/learner/emissions-boundary.test.ts` (new file — boundary guard)

---

## Phase 1 — Reward production (SDK + grader)

### Task 1: Additive `swe-rebench-v2-verdict.v2` payload schema

**Files:**
- Modify: `packages/sdk/src/payloads/swe-rebench-v2.ts`
- Test: `packages/sdk/test/swe-rebench-v2-payloads.test.ts`

- [ ] **Step 1: Write the failing tests**

Append to `packages/sdk/test/swe-rebench-v2-payloads.test.ts`:

```typescript
import {
  SweRebenchV2VerdictPayloadSchema,
  SweRebenchV2VerdictV2PayloadSchema,
} from '../src/payloads/swe-rebench-v2.js';

describe('swe-rebench-v2-verdict.v2 (graded, additive)', () => {
  const v2 = {
    schemaVersion: 'swe-rebench-v2-verdict.v2' as const,
    score: 0 as const,
    passed_match: false,
    evaluator_cost_usd: 0,
    passedCount: 18,
    totalCount: 20,
  };

  it('parses a v2 verdict with graded counts', () => {
    const parsed = SweRebenchV2VerdictV2PayloadSchema.parse(v2);
    expect(parsed.passedCount).toBe(18);
    expect(parsed.totalCount).toBe(20);
  });

  it('rejects negative or non-integer counts', () => {
    expect(() => SweRebenchV2VerdictV2PayloadSchema.parse({ ...v2, passedCount: -1 })).toThrow();
    expect(() => SweRebenchV2VerdictV2PayloadSchema.parse({ ...v2, totalCount: 1.5 })).toThrow();
  });

  it('rejects passedCount greater than totalCount', () => {
    expect(() => SweRebenchV2VerdictV2PayloadSchema.parse({ ...v2, passedCount: 21, totalCount: 20 })).toThrow();
  });

  it('union accepts both v1 and v2', () => {
    const v1 = { schemaVersion: 'swe-rebench-v2-verdict.v1' as const, score: 1 as const, passed_match: true, evaluator_cost_usd: 0 };
    expect(SweRebenchV2VerdictPayloadSchema.parse(v1).schemaVersion).toBe('swe-rebench-v2-verdict.v1');
    expect(SweRebenchV2VerdictPayloadSchema.parse(v2).schemaVersion).toBe('swe-rebench-v2-verdict.v2');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/sdk && yarn vitest run test/swe-rebench-v2-payloads.test.ts`
Expected: FAIL — `SweRebenchV2VerdictV2PayloadSchema` is not exported.

- [ ] **Step 3: Add the v2 schema + union**

In `packages/sdk/src/payloads/swe-rebench-v2.ts`, **rename** the existing const to `...V1PayloadSchema` and add the v2 schema + a union. Replace the existing verdict block:

```typescript
export const SweRebenchV2VerdictV1PayloadSchema = z.object({
  schemaVersion: z.literal('swe-rebench-v2-verdict.v1'),
  /** Pass@1 score: 1 if the test suite passed, 0 otherwise. */
  score: z.union([z.literal(0), z.literal(1)]),
  passed_match: z.boolean(),
  evaluator_cost_usd: z.number().nonnegative(),
});

/**
 * v2 — additive graded signal (Lever A, #1019). Superset of v1: keeps the
 * binary `score`/`passed_match` (the objective) and adds the per-test counts
 * the grader already computes. `gradedScore = passedCount / totalCount` is
 * derived downstream, never stored, to keep one source of truth.
 */
export const SweRebenchV2VerdictV2PayloadSchema = z.object({
  schemaVersion: z.literal('swe-rebench-v2-verdict.v2'),
  score: z.union([z.literal(0), z.literal(1)]),
  passed_match: z.boolean(),
  evaluator_cost_usd: z.number().nonnegative(),
  /** Count of individual tests that passed in this run. */
  passedCount: z.number().int().nonnegative(),
  /** Total gradeable tests in this run (FAIL_TO_PASS ∪ PASS_TO_PASS as the runner reported). */
  totalCount: z.number().int().nonnegative(),
}).refine((p) => p.passedCount <= p.totalCount, {
  message: 'passedCount must not exceed totalCount',
});

/** Accept either schema version on the read path. */
export const SweRebenchV2VerdictPayloadSchema = z.union([
  SweRebenchV2VerdictV1PayloadSchema,
  SweRebenchV2VerdictV2PayloadSchema,
]);

export type SweRebenchV2VerdictV1Payload = z.infer<typeof SweRebenchV2VerdictV1PayloadSchema>;
export type SweRebenchV2VerdictV2Payload = z.infer<typeof SweRebenchV2VerdictV2PayloadSchema>;
export type SweRebenchV2VerdictPayload = z.infer<typeof SweRebenchV2VerdictPayloadSchema>;
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd packages/sdk && yarn vitest run test/swe-rebench-v2-payloads.test.ts`
Expected: PASS.

- [ ] **Step 5: Fix any references to the renamed const**

Run: `cd packages/sdk && yarn build && grep -rn "SweRebenchV2VerdictPayloadSchema" src` — the union now carries that name, so existing `.parse()` callers keep working. If a caller needed the *strict v1 object* (e.g. `.extend()`), point it at `...V1PayloadSchema`. Run `yarn vitest run` (whole sdk) and fix breakage.
Expected: green.

- [ ] **Step 6: Commit**

```bash
git add packages/sdk/src/payloads/swe-rebench-v2.ts packages/sdk/test/swe-rebench-v2-payloads.test.ts
git commit -m "feat(sdk): additive swe-rebench-v2-verdict.v2 graded payload (#1019)"
```

---

### Task 2: Grader emits graded counts

**Files:**
- Modify: `client/src/harnesses/impls/swe-rebench-v2-evaluator/index.ts:64-92` (the `grade` return)
- Test: `client/test/harnesses/impls/swe-rebench-v2-evaluator/index.test.ts`

- [ ] **Step 1: Write the failing test**

Add to `client/test/harnesses/impls/swe-rebench-v2-evaluator/index.test.ts` (reuse the file's existing fake runner pattern; this asserts the new fields):

```typescript
it('emits v2 graded counts from passed/failed arrays', async () => {
  const runner = {
    runEval: async () => ({
      passed_match: false,
      passed: ['t1', 't2', 't3'],
      failed: ['t4'],
      log: '',
      exitCode: 1,
    }),
  };
  const fetcher = { fetchTaskRow: async () => ({ /* existing fixture row */ } as any) };
  const evaluator = new SweRebenchV2Evaluator({ fetcher, runner } as any);
  const verdict = await evaluator.grade({ task: TASK_FIXTURE, solutionPayload: SOLUTION_FIXTURE } as any);

  expect(verdict.schemaVersion).toBe('swe-rebench-v2-verdict.v2');
  expect(verdict.passedCount).toBe(3);
  expect(verdict.totalCount).toBe(4);
  expect(verdict.score).toBe(0); // binary unchanged: passed_match was false
});
```

(Use the fixtures already defined at the top of `index.test.ts`; if `runEval`'s fixture there omits `passed`/`failed`, add them.)

- [ ] **Step 2: Run test to verify it fails**

Run: `cd client && yarn vitest run test/harnesses/impls/swe-rebench-v2-evaluator/index.test.ts`
Expected: FAIL — `schemaVersion` is `...v1`, `passedCount` undefined.

- [ ] **Step 3: Emit the graded fields**

In `client/src/harnesses/impls/swe-rebench-v2-evaluator/index.ts`, change the `grade` return object:

```typescript
    return {
      schemaVersion: 'swe-rebench-v2-verdict.v2',
      score: result.passed_match ? 1 : 0,
      passed_match: result.passed_match,
      evaluator_cost_usd: 0,  // populated by caller from runtime metrics
      passedCount: result.passed.length,
      totalCount: result.passed.length + result.failed.length,
      test_log: result.log,
    };
```

Update the method's return type annotation from `SweRebenchV2VerdictPayload & { test_log: string }` to `SweRebenchV2VerdictV2Payload & { test_log: string }` and adjust the import.

- [ ] **Step 4: Run test to verify it passes**

Run: `cd client && yarn vitest run test/harnesses/impls/swe-rebench-v2-evaluator/index.test.ts`
Expected: PASS.

- [ ] **Step 5: Typecheck the evaluator's consumers**

Run: `cd client && yarn typecheck`
Expected: zero errors. (If a caller destructured the verdict expecting only v1 fields, the v2 superset is assignment-compatible; fix any literal-type narrowings.)

- [ ] **Step 6: Commit**

```bash
git add client/src/harnesses/impls/swe-rebench-v2-evaluator/index.ts client/test/harnesses/impls/swe-rebench-v2-evaluator/index.test.ts
git commit -m "feat(eval): grader emits v2 graded counts (passedCount/totalCount) (#1019)"
```

---

## Phase 2 — Indexer materialization

### Task 3: Add graded columns to `verdictEnvelopeMeta`

**Files:**
- Modify: `packages/indexer/ponder.schema.ts` (the `verdictEnvelopeMeta` table, after `actualScore`)

- [ ] **Step 1: Add the columns**

In `packages/indexer/ponder.schema.ts`, immediately after the `actualScore` column definition, add:

```typescript
    /**
     * Graded per-test counts (Lever A, #1019). Populated for swe-rebench-v2
     * verdict.v2 envelopes from payload.passedCount / payload.totalCount.
     * 0/0 for v1 envelopes and non-swe-rebench-v2 types. gradedScore
     * (= passedCount/totalCount) is derived at read time, never stored.
     * Read ONLY by the learner discovery query — never by emissions.
     */
    passedCount: t.integer().notNull().default(0),
    totalCount: t.integer().notNull().default(0),
```

- [ ] **Step 2: Verify the schema compiles**

Run: `cd packages/indexer && yarn build` (or `yarn tsc --noEmit` if no build script)
Expected: compiles. No data migration needed — Ponder reindexes from chain; the columns default to 0 for all historical rows.

- [ ] **Step 3: Commit**

```bash
git add packages/indexer/ponder.schema.ts
git commit -m "feat(indexer): graded passedCount/totalCount columns on verdictEnvelopeMeta (#1019)"
```

---

### Task 4: Parse + materialize the graded fields

**Files:**
- Modify: `packages/indexer/src/handlers.ts` — `VerdictEnvelopeLite` interface, `parseVerdictEnvelopeLite`, both insert branches (~1255 values, ~1265 update, and the `actualScore` row-echo at ~1304)
- Test: `packages/indexer/test/handlers.test.ts`

- [ ] **Step 1: Write the failing test**

Add to `packages/indexer/test/handlers.test.ts` (reuse the file's existing `parseVerdictEnvelopeLite` describe block + a v2 body):

```typescript
it('parses graded counts from a swe-rebench-v2 verdict.v2 envelope', () => {
  const body = {
    solverType: 'swe-rebench-v2.v1',
    task: { requestId: '0xabc', attemptIndex: 0, taskId: '1', cid: '' },
    participant: { safeAddress: '0xeval' },
    payload: { schemaVersion: 'swe-rebench-v2-verdict.v2', score: 0, passed_match: false, passedCount: 18, totalCount: 20 },
  };
  const meta = parseVerdictEnvelopeLite(body);
  expect(meta?.passedCount).toBe(18);
  expect(meta?.totalCount).toBe(20);
  expect(meta?.actualPassed).toBe(false); // binary unchanged
});

it('defaults graded counts to 0 for a v1 verdict envelope', () => {
  const body = {
    solverType: 'swe-rebench-v2.v1',
    task: { requestId: '0xdef', attemptIndex: 0, taskId: '1', cid: '' },
    participant: { safeAddress: '0xeval' },
    payload: { schemaVersion: 'swe-rebench-v2-verdict.v1', score: 1, passed_match: true },
  };
  const meta = parseVerdictEnvelopeLite(body);
  expect(meta?.passedCount).toBe(0);
  expect(meta?.totalCount).toBe(0);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/indexer && yarn vitest run test/handlers.test.ts`
Expected: FAIL — `passedCount` undefined on `VerdictEnvelopeLite`.

- [ ] **Step 3: Extend the interface + parser**

In `packages/indexer/src/handlers.ts`, add to `VerdictEnvelopeLite` (after `actualScore: string;`):

```typescript
  passedCount: number;
  totalCount: number;
```

In `parseVerdictEnvelopeLite`, inside the `if (solverType.startsWith('swe-rebench-v2'))` branch, after the `scoreRaw` handling, add:

```typescript
    const pc = payloadObj['passedCount'] ?? payloadObj['passed_count'];
    const tc = payloadObj['totalCount'] ?? payloadObj['total_count'];
    passedCount = safeInt(pc, 0);
    totalCount = safeInt(tc, 0);
```

Declare the locals near `actualScore`:

```typescript
  let passedCount = 0;
  let totalCount = 0;
```

And add `passedCount, totalCount` to the returned object literal.

- [ ] **Step 4: Write the columns at the insert sites**

In `handlers.ts`, add `passedCount: meta.passedCount,` and `totalCount: meta.totalCount,` to: (a) the `.values({...})` object (after `actualScore: meta.actualScore,`), and (b) the `onConflictDoUpdate` "most-recent-wins" branch (after `actualScore: meta.actualScore,`). In the no-op echo branch, add `passedCount: row.passedCount,` and `totalCount: row.totalCount,` (after `actualScore: row.actualScore,`).

- [ ] **Step 5: Run tests to verify they pass**

Run: `cd packages/indexer && yarn vitest run test/handlers.test.ts`
Expected: PASS. Then `yarn build` to confirm the insert objects typecheck against the new schema.

- [ ] **Step 6: Commit**

```bash
git add packages/indexer/src/handlers.ts packages/indexer/test/handlers.test.ts
git commit -m "feat(indexer): parse + materialize graded counts on verdict.v2 (#1019)"
```

---

## Phase 3 — Discovery query

### Task 5: `CodeDigestRewardRow.gradedScores`

**Files:**
- Modify: `client/src/discovery/types.ts` (`CodeDigestRewardRow`)
- Test: `client/test/discovery/types.codedigest-reward.test.ts`

- [ ] **Step 1: Write the failing test**

Add to `client/test/discovery/types.codedigest-reward.test.ts`:

```typescript
it('CodeDigestRewardRow carries per-attempt gradedScores', () => {
  const row: CodeDigestRewardRow = {
    codeDigest: 'sha256:x', attempts: 3, passes: 1, passRate: 1 / 3,
    avgScore: 0.6, gradedScores: [0.9, 0.5, 0.4],
  };
  expect(row.gradedScores).toHaveLength(3);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd client && yarn vitest run test/discovery/types.codedigest-reward.test.ts`
Expected: FAIL — `gradedScores` not a property of the type.

- [ ] **Step 3: Add the field**

In `client/src/discovery/types.ts`, add to `CodeDigestRewardRow` (after `avgScore`):

```typescript
  /**
   * Per-attempt graded score (passedCount/totalCount) for in-window verdicts
   * that carried v2 counts (totalCount > 0). Empty / short when verdicts predate
   * verdict.v2. Consumed by the learner's Mann-Whitney sensitivity tier (#1019).
   */
  gradedScores: number[];
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd client && yarn vitest run test/discovery/types.codedigest-reward.test.ts`
Expected: PASS (type-only; will fail to typecheck until Task 6/7 populate it — that's expected, next tasks close it).

- [ ] **Step 5: Commit**

```bash
git add client/src/discovery/types.ts client/test/discovery/types.codedigest-reward.test.ts
git commit -m "feat(discovery): gradedScores[] on CodeDigestRewardRow (#1019)"
```

---

### Task 6: Populate `gradedScores` in the HTTP query + floor stub

**Files:**
- Modify: `client/src/discovery/http.ts` (the `codeDigestVerdictsQuery` GraphQL + verdict loop + step-4 aggregation)
- Modify: `client/src/discovery/onchain.ts:1309` (floor stub)
- Test: `client/test/discovery/http.codedigest-rewards.test.ts`

- [ ] **Step 1: Write the failing test**

Add to `client/test/discovery/http.codedigest-rewards.test.ts` (reuse the file's mock-GraphQL harness; have the verdict page return `passedCount`/`totalCount`):

```typescript
it('returns per-attempt gradedScores from v2 verdict counts', async () => {
  // mock: 2 attempts on digest 'sha256:d1', verdicts {18/20} and {10/20}
  const api = makeHttpDiscovery(/* fetch mock returning the pages */);
  const [row] = await api.getCodeDigestRewards({ codeDigests: ['sha256:d1'] });
  expect(row.gradedScores.sort()).toEqual([0.5, 0.9]);
  expect(row.avgScore).toBeCloseTo(0.7);
});

it('omits gradedScore for verdicts with totalCount 0 (v1 / non-gradeable)', async () => {
  const api = makeHttpDiscovery(/* one v2 18/20, one v1 totalCount=0 */);
  const [row] = await api.getCodeDigestRewards({ codeDigests: ['sha256:d2'] });
  expect(row.gradedScores).toEqual([0.9]); // the v1 attempt contributes no graded score
  expect(row.attempts).toBe(2);            // but still counts as a binary attempt
});
```

(Match the existing mock shape in this test file; add `passedCount`/`totalCount` to the verdict-meta items the mock returns.)

- [ ] **Step 2: Run test to verify it fails**

Run: `cd client && yarn vitest run test/discovery/http.codedigest-rewards.test.ts`
Expected: FAIL — `gradedScores` missing / undefined.

- [ ] **Step 3: Fetch the graded columns**

In `client/src/discovery/http.ts`, find `codeDigestVerdictsQuery(scopeBySolverNet)` (the GraphQL string builder) and add `passedCount` and `totalCount` to the `verdictEnvelopeMetas { items { ... } }` selection set.

- [ ] **Step 4: Carry graded score per verdict + aggregate**

In the verdict loop, extend the stored value:

```typescript
      const pc = Number(row.passedCount);
      const tc = Number(row.totalCount);
      const graded = Number.isFinite(tc) && tc > 0 ? pc / tc : null;
      verdictByKey.set(key, {
        passed: Boolean(row.actualPassed),
        score: Number.isFinite(scoreNum) && row.actualScore !== '' ? scoreNum : null,
        graded,
      });
```

Update the `verdictByKey` value type to `{ passed: boolean; score: number | null; graded: number | null }`.

In step 4's accumulator, add a `gradedScores: number[]` array:

```typescript
    const agg = new Map<string, { attempts: number; passes: number; scoreSum: number; scoreN: number; gradedScores: number[] }>();
    for (const [key, digest] of requestKeyToDigest) {
      if (allowedKeys && !allowedKeys.has(key)) continue;
      const v = verdictByKey.get(key);
      if (!v) continue;
      const cur = agg.get(digest) ?? { attempts: 0, passes: 0, scoreSum: 0, scoreN: 0, gradedScores: [] };
      cur.attempts += 1;
      if (v.passed) cur.passes += 1;
      if (v.score !== null) { cur.scoreSum += v.score; cur.scoreN += 1; }
      if (v.graded !== null) cur.gradedScores.push(v.graded);
      agg.set(digest, cur);
    }
```

And in the row construction, add `gradedScores: a.gradedScores,`.

- [ ] **Step 5: Floor stub returns the field**

In `client/src/discovery/onchain.ts` (the `getCodeDigestRewards` empty-array stub at ~1309), no row is produced, so it already returns `[]` — confirm the `CodeDigestRewardRow[]` return type still satisfies the new field (it does; empty array). No change needed unless a non-empty stub exists. If the file constructs any literal `CodeDigestRewardRow`, add `gradedScores: []`.

- [ ] **Step 6: Run tests to verify they pass**

Run: `cd client && yarn vitest run test/discovery/http.codedigest-rewards.test.ts && yarn typecheck`
Expected: PASS, zero type errors.

- [ ] **Step 7: Commit**

```bash
git add client/src/discovery/http.ts client/src/discovery/onchain.ts client/test/discovery/http.codedigest-rewards.test.ts
git commit -m "feat(discovery): populate per-attempt gradedScores in getCodeDigestRewards (#1019)"
```

---

## Phase 4 — The two-tier gate

### Task 7: Pure `mannWhitneyU` statistic

**Files:**
- Modify: `client/src/learner/revert-stats.ts`
- Test: `client/test/learner/revert-stats.test.ts`

- [ ] **Step 1: Write the failing tests**

Add to `client/test/learner/revert-stats.test.ts`:

```typescript
import { mannWhitneyU } from '../../src/learner/revert-stats.js';

describe('mannWhitneyU', () => {
  it('no signal when distributions are identical', () => {
    const r = mannWhitneyU([0.5, 0.5, 0.5], [0.5, 0.5, 0.5]);
    expect(r.pValue).toBeCloseTo(1, 5);
  });

  it('detects A < B (A regressed)', () => {
    const r = mannWhitneyU([0.1, 0.2, 0.15, 0.05], [0.8, 0.9, 0.85, 0.95]);
    expect(r.z).toBeLessThan(0);
    expect(r.pValue).toBeLessThan(0.05);
  });

  it('handles ties via tie-corrected variance', () => {
    const r = mannWhitneyU([0.5, 0.5, 0.6], [0.5, 0.5, 0.4]);
    expect(Number.isFinite(r.pValue)).toBe(true);
  });

  it('returns no-signal (p=1) when either arm is empty', () => {
    expect(mannWhitneyU([], [0.5]).pValue).toBe(1);
  });

  it('matches the hand-computed U for a small case', () => {
    // A=[1,3], B=[2,4]: U_A = (#A>B pairs) = 1.  Symmetric normal-approx z<0.
    const r = mannWhitneyU([0.1, 0.3], [0.2, 0.4]);
    expect(r.u).toBeCloseTo(1, 5);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd client && yarn vitest run test/learner/revert-stats.test.ts`
Expected: FAIL — `mannWhitneyU` not exported.

- [ ] **Step 3: Implement `mannWhitneyU`**

Append to `client/src/learner/revert-stats.ts`:

```typescript
export interface MannWhitneyResult {
  /** U statistic for arm A. */
  u: number;
  /** Normal-approx z (sign matches "A − B": negative => A stochastically lower). */
  z: number;
  /** Two-sided p-value in [0, 1]; 1 when there is no signal or an arm is empty. */
  pValue: number;
}

/**
 * Mann-Whitney U (rank-sum) with tie correction and normal approximation.
 * Rank-based per the design §3 — robust to the bounded/bimodal/miscalibrated
 * graded-score distribution. No I/O. (#1019)
 */
export function mannWhitneyU(a: number[], b: number[]): MannWhitneyResult {
  const nA = a.length;
  const nB = b.length;
  if (nA === 0 || nB === 0) return { u: 0, z: 0, pValue: 1 };

  const all = [...a.map((v) => ({ v, g: 0 })), ...b.map((v) => ({ v, g: 1 }))];
  all.sort((x, y) => x.v - y.v);

  // Average ranks (1-based), tie-aware.
  const ranks = new Array(all.length).fill(0);
  let i = 0;
  let tieTerm = 0; // Σ (t³ − t) over tie groups, for the variance correction
  while (i < all.length) {
    let j = i;
    while (j + 1 < all.length && all[j + 1]!.v === all[i]!.v) j++;
    const avgRank = (i + 1 + (j + 1)) / 2;
    for (let k = i; k <= j; k++) ranks[k] = avgRank;
    const t = j - i + 1;
    if (t > 1) tieTerm += t * t * t - t;
    i = j + 1;
  }

  let rankSumA = 0;
  for (let k = 0; k < all.length; k++) if (all[k]!.g === 0) rankSumA += ranks[k]!;

  const uA = rankSumA - (nA * (nA + 1)) / 2;
  const n = nA + nB;
  const meanU = (nA * nB) / 2;
  const varU = (nA * nB / (n * (n - 1))) * ((n * n * n - n) / 12 - tieTerm / 12);
  if (varU <= 0) return { u: uA, z: 0, pValue: 1 };

  const z = (uA - meanU) / Math.sqrt(varU);
  const pValue = 2 * (1 - standardNormalCdf(Math.abs(z)));
  return { u: uA, z, pValue };
}
```

`standardNormalCdf` already exists in this file (used by `twoProportionZTest`); reuse it. If it is `function`-scoped below its first use, leave it — hoisting applies.

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd client && yarn vitest run test/learner/revert-stats.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add client/src/learner/revert-stats.ts client/test/learner/revert-stats.test.ts
git commit -m "feat(learner): tie-corrected Mann-Whitney U for the graded tier (#1019)"
```

---

### Task 8: Two-tier `decideRevert`

**Files:**
- Modify: `client/src/learner/revert-decision.ts` (`RevertPolicy`, `DEFAULT_REVERT_POLICY`, `CodeDigestAggregate`, `RevertReason`, `decideRevert`)
- Test: `client/test/learner/revert-decision.test.ts`

- [ ] **Step 1: Write the failing tests**

Add to `client/test/learner/revert-decision.test.ts`:

```typescript
const P = DEFAULT_REVERT_POLICY;
const arm = (codeDigest: string, attempts: number, passes: number, gradedScores: number[]): CodeDigestAggregate =>
  ({ codeDigest, attempts, passes, passRate: attempts ? passes / attempts : 0, gradedScores });

describe('two-tier graded gate (#1019)', () => {
  it('Tier 2 rescues an insufficient-binary case with a significant graded regression', () => {
    const withCommit = arm('w', 5, 1, [0.1, 0.15, 0.2, 0.1, 0.05]);   // < minSamplesPerArm (30) on binary
    const atParent = arm('p', 5, 4, [0.85, 0.9, 0.8, 0.95, 0.88]);
    const d = decideRevert({ withCommit, atParent }, P);
    expect(d.reason).toBe('graded_regression_provisional');
    expect(d.recommendRevert).toBe(true);
  });

  it('holds (does not revert) when binary says regress but graded says improve', () => {
    const withCommit = arm('w', 40, 18, [0.9, 0.9, 0.9, 0.9, 0.9, 0.9, 0.9, 0.9, 0.9, 0.9]);
    const atParent = arm('p', 40, 30, [0.4, 0.4, 0.4, 0.4, 0.4, 0.4, 0.4, 0.4, 0.4, 0.4]);
    const d = decideRevert({ withCommit, atParent }, P);
    expect(d.reason).toBe('binary_graded_disagree');
    expect(d.recommendRevert).toBe(false);
  });

  it('reverts on significant binary regression when graded agrees (or is absent)', () => {
    const withCommit = arm('w', 40, 8, []);   // no graded data
    const atParent = arm('p', 40, 34, []);
    const d = decideRevert({ withCommit, atParent }, P);
    expect(d.reason).toBe('significant_regression');
    expect(d.recommendRevert).toBe(true);
  });

  it('abstains when both tiers are underpowered', () => {
    const withCommit = arm('w', 3, 1, [0.5, 0.5, 0.5]);
    const atParent = arm('p', 3, 2, [0.5, 0.5, 0.5]);
    const d = decideRevert({ withCommit, atParent }, P);
    expect(d.reason).toBe('insufficient_samples');
    expect(d.recommendRevert).toBe(false);
  });

  it('degrades to binary-only when there are no graded scores (v1 window)', () => {
    const withCommit = arm('w', 5, 1, []);   // binary insufficient, no graded
    const atParent = arm('p', 5, 4, []);
    const d = decideRevert({ withCommit, atParent }, P);
    expect(d.reason).toBe('insufficient_samples');
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd client && yarn vitest run test/learner/revert-decision.test.ts`
Expected: FAIL — `gradedScores` not on `CodeDigestAggregate`; reasons/logic absent.

- [ ] **Step 3: Extend the types**

In `client/src/learner/revert-decision.ts`:

Add policy fields to `RevertPolicy` + defaults:

```typescript
  /** Minimum per-arm graded samples before the graded (Tier 2) test runs. Default 10. */
  gradedMinSamplesPerArm: number;
  /** Two-sided significance threshold for the graded test. Default 0.05. */
  gradedAlpha: number;
```

```typescript
export const DEFAULT_REVERT_POLICY: RevertPolicy = {
  minSamplesPerArm: 30,
  alpha: 0.05,
  recentAttemptsWindow: 200,
  gradedMinSamplesPerArm: 10,
  gradedAlpha: 0.05,
};
```

Add `gradedScores` to `CodeDigestAggregate`:

```typescript
  /** Per-attempt graded scores (passedCount/totalCount) within the window. May be empty (v1). */
  gradedScores: number[];
```

Extend `RevertReason`:

```typescript
export type RevertReason =
  | 'significant_regression'
  | 'insufficient_samples'
  | 'not_significant'
  | 'no_regression'
  | 'graded_regression_provisional'
  | 'binary_graded_disagree';
```

- [ ] **Step 4: Rewrite `decideRevert` as two-tier**

Replace the body of `decideRevert` (keep the signature and the `base` object):

```typescript
import { twoProportionZTest, mannWhitneyU } from './revert-stats.js';

export function decideRevert(
  input: RevertDecisionInput,
  policy: RevertPolicy = DEFAULT_REVERT_POLICY,
): RevertDecision {
  const { withCommit, atParent } = input;
  const base = {
    withCommit: { codeDigest: withCommit.codeDigest, n: withCommit.attempts, passRate: withCommit.passRate },
    atParent: { codeDigest: atParent.codeDigest, n: atParent.attempts, passRate: atParent.passRate },
  };

  const mean = (xs: number[]) => (xs.length ? xs.reduce((s, v) => s + v, 0) / xs.length : 0);
  const gradedReady =
    withCommit.gradedScores.length >= policy.gradedMinSamplesPerArm &&
    atParent.gradedScores.length >= policy.gradedMinSamplesPerArm;
  const gradedDelta = mean(withCommit.gradedScores) - mean(atParent.gradedScores);

  // Tier 1 — binary objective.
  const binaryUnderpowered =
    withCommit.attempts < policy.minSamplesPerArm || atParent.attempts < policy.minSamplesPerArm;

  if (!binaryUnderpowered) {
    const stats = twoProportionZTest({
      passesA: withCommit.passes, totalA: withCommit.attempts,
      passesB: atParent.passes, totalB: atParent.attempts,
    });
    const significant = stats.pValue < policy.alpha;
    if (stats.delta >= 0) {
      return { ...base, delta: stats.delta, pValue: stats.pValue, significant, recommendRevert: false, reason: 'no_regression' };
    }
    if (!significant) {
      return { ...base, delta: stats.delta, pValue: stats.pValue, significant, recommendRevert: false, reason: 'not_significant' };
    }
    // Binary says significant regression. Confirmation guardrail: if graded
    // data exists and DISAGREES (graded improved), hold rather than revert.
    if (gradedReady && gradedDelta > 0) {
      return { ...base, delta: stats.delta, pValue: stats.pValue, significant: true, recommendRevert: false, reason: 'binary_graded_disagree' };
    }
    return { ...base, delta: stats.delta, pValue: stats.pValue, significant: true, recommendRevert: true, reason: 'significant_regression' };
  }

  // Tier 2 — graded sensitivity (only when binary is underpowered).
  if (gradedReady) {
    const mw = mannWhitneyU(withCommit.gradedScores, atParent.gradedScores);
    if (mw.pValue < policy.gradedAlpha && gradedDelta < 0) {
      return { ...base, delta: gradedDelta, pValue: mw.pValue, significant: true, recommendRevert: true, reason: 'graded_regression_provisional' };
    }
  }

  return { ...base, delta: withCommit.passRate - atParent.passRate, pValue: 1, significant: false, recommendRevert: false, reason: 'insufficient_samples' };
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `cd client && yarn vitest run test/learner/revert-decision.test.ts && yarn vitest run test/learner/revert-decision.git-fixture.test.ts`
Expected: PASS. (The git-fixture test builds aggregates — Step 6 closes its `gradedScores` requirement.)

- [ ] **Step 6: Thread `gradedScores` from the row into the aggregate**

In `client/src/cli/commands/codedigest-revert-check.ts` (and any other builder of `CodeDigestAggregate` from a `CodeDigestRewardRow` — grep `attempts:` near `passRate:`), add `gradedScores: row.gradedScores,` when constructing the aggregate. Update the git-fixture test helper similarly (pass `gradedScores: []` where unspecified).

Run: `cd client && yarn typecheck`
Expected: zero errors.

- [ ] **Step 7: Commit**

```bash
git add client/src/learner/revert-decision.ts client/src/cli/commands/codedigest-revert-check.ts client/test/learner/revert-decision.test.ts
git commit -m "feat(learner): two-tier keep/revert gate — binary objective + graded sensitivity (#1019)"
```

---

## Phase 5 — Boundary guard

### Task 9: Assert the graded score never reaches emissions

**Files:**
- Test: `client/test/learner/emissions-boundary.test.ts` (new)
- Modify (doc): `client/plugins/learner/skills/learn/consolidator-prompt.md` (one note)

- [ ] **Step 1: Write the failing test**

Create `client/test/learner/emissions-boundary.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { globSync } from 'glob';

/**
 * Invariant 2 (#1019): the graded score (gradedScore / gradedScores / passedCount
 * / totalCount) is consumed ONLY by the learning loop, never by any
 * emissions/reward/distribution code path. Until the withheld-test challenge
 * ships, a graded score must not size on-chain reward.
 */
describe('graded-score emissions boundary', () => {
  const emissionsFiles = globSync('src/{earning,reward*,x402,distribution}/**/*.ts', { cwd: 'client', absolute: true })
    .concat(globSync('src/**/*reward*.ts', { cwd: 'client', absolute: true }))
    .filter((f) => !f.includes('/learner/') && !f.includes('codedigest-reward') && !f.endsWith('.test.ts'));

  it('no emissions/reward module references the graded fields', () => {
    const offenders = emissionsFiles.filter((f) => {
      const src = readFileSync(f, 'utf8');
      return /\bgradedScore(s)?\b|\bpassedCount\b|\btotalCount\b/.test(src);
    });
    expect(offenders, `graded fields leaked into emissions: ${offenders.join(', ')}`).toEqual([]);
  });
});
```

- [ ] **Step 2: Run test to verify it passes immediately**

Run: `cd client && yarn vitest run test/learner/emissions-boundary.test.ts`
Expected: PASS (nothing in emissions reads graded fields yet — the test is a standing guard). If it FAILS, an emissions module already references a graded field — that is a real violation; remove the reference before proceeding.

- [ ] **Step 3: Document the boundary in the Consolidator prompt**

In `client/plugins/learner/skills/learn/consolidator-prompt.md`, add a short note where it describes the revert signal:

```markdown
> The graded score (Tier 2) lowers the variance of the keep/revert decision only.
> It never overrules the binary verdict, and it MUST NOT be used to size on-chain
> reward — that path is gated on the withheld-test challenge (#1019, design §5.5).
```

- [ ] **Step 4: Commit**

```bash
git add client/test/learner/emissions-boundary.test.ts client/plugins/learner/skills/learn/consolidator-prompt.md
git commit -m "test(learner): standing boundary guard — graded score never sizes emissions (#1019)"
```

---

## Final verification

- [ ] **Step 1: Full typecheck + targeted suites**

Run:
```bash
cd packages/sdk && yarn vitest run && cd ../indexer && yarn vitest run && cd ../../client && yarn typecheck && yarn vitest run test/learner test/discovery test/harnesses/impls/swe-rebench-v2-evaluator
```
Expected: all green, zero type errors.

- [ ] **Step 2: Confirm backward-compat path by eye**

Re-read the design §7. Confirm: a v1 verdict → `passedCount/totalCount = 0` → `gradedScores` entry omitted → Tier 2 sees `< gradedMinSamplesPerArm` → abstains → gate behaves exactly as before. No new code path runs for non-upgraded operators.

- [ ] **Step 3: Push + open the PR**

```bash
git push -u origin design/graded-reward-signal-lever-a
gh pr create --repo Jinn-Network/mono --base next \
  --title "feat(learner): graded reward signal for the learning loop (Lever A)" \
  --body "Implements #1019. Closes #1019.

Design: docs/superpowers/specs/2026-06-03-graded-reward-signal-lever-a-design.md

Exposes the per-test graded score the swe-rebench-v2 grader already computes,
carries it on-chain alongside the existing pass/fail bit (additive verdict.v2),
and threads it into the Consolidator's keep/revert gate as a two-tier decision
(binary objective + Mann-Whitney graded sensitivity). Additive and
backward-compatible; graded score never overrules the bit and never sizes
emissions (boundary guarded by test)."
```

---

## Self-review notes (author)

- **Spec coverage:** §5.1 → Tasks 1–2; §5.2 → Tasks 3–4; §5.3 → Tasks 5–6; §5.4 → Tasks 7–8; §5.5 → Task 9; §7 backward-compat → Final Step 2 + Task 8 tests (e), (degrade); §8 testing → every task's tests. All §5/§7/§8 requirements map to a task.
- **Type consistency:** `passedCount`/`totalCount` (payload + indexer + parser), `gradedScores: number[]` (row → aggregate → gate), `mannWhitneyU(a,b) → {u,z,pValue}`, reasons `graded_regression_provisional` / `binary_graded_disagree` — names used identically across Tasks 1–9.
- **Open item carried from spec §10:** `totalCount` definition is "as the runner reported" (`passed.length + failed.length` in Task 2). If the log-parser undercounts collection-errored tests, that flows through as a smaller denominator — acceptable for a sensitivity tier; revisit under Lever B if it biases decisions.
