# Indexer `finalized` Mismatch Fix — Implementation Plan (issue #530)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the Ponder indexer's `task.finalized` boolean match the on-chain verdict-delivery finalization rule (`validVerdictCount >= requiredVerdicts`) instead of flipping true on the first `SolutionDeliveryClaimed` (start of evaluation).

**Architecture:** This is a `fix` shape — regression-test-first. The bug lives in two pure handlers in `packages/indexer/src/handlers.ts`. `handleSolutionDeliveryClaimed` wrongly sets `finalized = true`; the real finalization signal is `handleVerdictDeliveryClaimed`. We move the `finalized` write to the verdict handler, recomputing it from the count of delivered `verdict` rows for the `(taskId, attemptIndex, chainId)` attempt scope against the task's `requiredVerdicts` — mirroring the rule already in `metrics.ts:attemptFinalization`. We keep the stored, indexed boolean (no schema change, ~8 read sites depend on it). Counting delivered verdict rows requires a row-scan capability the narrow `HandlerDb` does not yet expose, so we add one narrow async method (`countVerdicts`) to `HandlerDb`, implement it in the real Ponder wiring via `context.db.sql` (Ponder 0.16's raw-drizzle escape hatch), and in the in-memory test fake via a `rows()` scan. Comments in `handlers.ts`, `ponder.schema.ts`, and `README.md` that call `SolutionDeliveryClaimed` "the terminal success state" get corrected.

**Tech Stack:** TypeScript, Ponder 0.16 (`context.db` indexing store + `context.db.sql` raw drizzle), drizzle-orm (`count` / `and` / `eq` re-exported from `ponder`), Vitest, in-memory db fake (`test/helpers/in-memory-db.ts`).

---

## Contract grounding (why this is the correct rule, not a guess)

From `contracts/src/tasks/TaskCoordinator.sol`:

- `claimEvaluation` (line ~440): `verdictIndex = attempt.verdictClaimCount;` then `attempt.verdictClaimCount++`. So `verdictIndex` is a 0-based dense **claim** counter per attempt.
- `recordVerdict` (line ~540): `attempt.validVerdictCount++` on each **delivered** verdict, then (line ~555) `if (attempt.validVerdictCount == evalPolicy.requiredVerdicts) { attemptFinalized = true; ... }`. Pass/fail is decided separately by `passVerdictCount >= passThreshold` and does **not** affect finalization.

From `contracts/src/staking/JinnRouterV3.sol`:

- `SolutionDeliveryClaimed` (emitted line ~381) fires when a solution slot is delivered — the **start** of the evaluation phase, not finalization.
- `VerdictDeliveryClaimed` (emitted line ~425) fires **once per `recordVerdict`** — i.e. once per *delivered* verdict. It carries `(evaluator, requestId, taskId, attemptIndex, verdictIndex, verdictCode)` but **not** `attemptFinalized`, so the indexer must recompute.

**Why count rows, not `verdictIndex + 1`:** `verdictIndex` tracks *claims* (`verdictClaimCount`), but a claimed verdict can expire undelivered. Finalization keys on *delivered* verdicts (`validVerdictCount`). Each indexed `verdict` row corresponds to one delivered verdict (`VerdictDeliveryClaimed`), so counting delivered `verdict` rows for the attempt scope equals on-chain `validVerdictCount`. Using `verdictIndex + 1` would over-count when an earlier-claimed verdict never delivered. Counting rows is the only sound approach.

**Finalization rule (mirrors `metrics.ts:attemptFinalization`):**
`finalized = requiredVerdicts > 0 && deliveredVerdictCount >= requiredVerdicts`. The verdict row for the current event is inserted first (idempotent `onConflictDoNothing`), so the count is taken *after* the insert and includes the current delivery. Monotonic — once true, never flipped back to false.

**Scope of the count:** per the JinnRouter event, finalization is **per-attempt**, but `task.finalized` is a single task-level boolean. The on-chain `task.finalizedAttemptCount` increments when *any* attempt finalizes; the indexed task-level `finalized` boolean is the v0.1 proxy meaning "at least one attempt has finalized". We therefore set `task.finalized = true` as soon as the *current attempt's* delivered-verdict count reaches `requiredVerdicts`. This matches the existing single-boolean model and the read sites, and is monotonic. (A future per-attempt finalization entity is out of scope — issue #530 only asks `finalized` to stop being true for not-yet-finalized tasks.)

---

## File structure

- `packages/indexer/src/handlers.ts` — extend `HandlerDb` with `countVerdicts`; rewrite `handleVerdictDeliveryClaimed` (add `task` param, recompute finalized); strip the `finalized` write from `handleSolutionDeliveryClaimed`; fix comments.
- `packages/indexer/src/index.ts` — wrap `context.db` with a `countVerdicts` implementation backed by `context.db.sql`; pass the `task` table into the `VerdictDeliveryClaimed` registration.
- `packages/indexer/test/helpers/in-memory-db.ts` — implement `countVerdicts` via a `rows()` scan so the fake satisfies the extended `HandlerDb`.
- `packages/indexer/test/handlers.test.ts` — replace the wrong `SolutionDeliveryClaimed → finalized true` assertion with its inverse; add `VerdictDeliveryClaimed` finalization cases.
- `packages/indexer/ponder.schema.ts` — correct the `Task.finalized` comment + the schema header NOTE.
- `packages/indexer/README.md` — correct the "No TaskFinalized" known-limitations paragraph.

---

## Task 1: Regression test — `SolutionDeliveryClaimed` must NOT finalize

**Files:**
- Modify: `packages/indexer/test/handlers.test.ts:207-229` (the `describe('SolutionDeliveryClaimed', ...)` block)

This task encodes the bug's first half: the current test asserts the *wrong* behaviour (`SolutionDeliveryClaimed` → `finalized true`). We invert it. The handler signature change to `handleSolutionDeliveryClaimed` is NOT needed (it keeps `{ event, context, task }`), only its behaviour changes in Task 4.

- [ ] **Step 1: Rewrite the `SolutionDeliveryClaimed` describe block to assert non-finalization**

Replace the entire block at lines 205-229 (from the `// ── Area 4` comment through the closing `});` of the describe) with:

```typescript
// ── Area 4: SolutionDeliveryClaimed no longer finalizes (issue #530) ──────────
// SolutionDeliveryClaimed is a solution-slot delivery — the START of evaluation,
// not finalization. On-chain finalization is validVerdictCount >= requiredVerdicts
// (TaskCoordinator.recordVerdict). The finalized flag is recomputed in
// handleVerdictDeliveryClaimed; this handler must leave finalized untouched.

describe('SolutionDeliveryClaimed', () => {
  it('does NOT mark the task finalized (it is the start of evaluation, not the end)', async () => {
    await handleTaskCreated({ event: taskCreatedEvent({ taskId: 7n }), context, task });
    expect(db.get(task, { id: '7' })?.finalized).toBe(false);
    await handleSolutionDeliveryClaimed({
      event: solutionDeliveryClaimedEvent({ taskId: 7n }),
      context,
      task,
    });
    // Issue #530: finalized must stay false — the task is still Open until
    // delivered verdicts reach requiredVerdicts.
    expect(db.get(task, { id: '7' })?.finalized).toBe(false);
  });

  it('skips (does not crash) when the task row does not exist (TaskCreated predates startBlock)', async () => {
    await expect(
      handleSolutionDeliveryClaimed({
        event: solutionDeliveryClaimedEvent({ taskId: 9999n }),
        context,
        task,
      }),
    ).resolves.toBeUndefined();
    expect(db.count(task)).toBe(0);
  });
});
```

- [ ] **Step 2: Run the test to verify the first case FAILS (bug still present)**

Run: `cd packages/indexer && yarn test handlers.test.ts -t "does NOT mark the task finalized"`
Expected: FAIL — `expected true to be false` (the current handler still sets `finalized: true`). The "skips" case still PASSES.

- [ ] **Step 3: Commit the failing regression test**

```bash
git add packages/indexer/test/handlers.test.ts
git commit -m "test(indexer): SolutionDeliveryClaimed must not finalize (issue #530, failing)"
```

---

## Task 2: Regression tests — `VerdictDeliveryClaimed` recomputes finalized

**Files:**
- Modify: `packages/indexer/test/handlers.test.ts` — extend the existing `describe('VerdictDeliveryClaimed → verdict', ...)` block (lines 467-515) by appending finalization cases, and import `task`-passing into the verdict handler call.

These tests will fail to compile/run until Task 3 changes the `handleVerdictDeliveryClaimed` signature to accept `task`. That's expected for TDD — they're written first, fail, then Task 3 makes them pass.

- [ ] **Step 1: Append the finalization test cases inside the existing `VerdictDeliveryClaimed → verdict` describe block**

Insert the following `it(...)` blocks immediately before the closing `});` of `describe('VerdictDeliveryClaimed → verdict', ...)` at line 515. Each test creates the task first (so `requiredVerdicts` is known) and passes `task` into the handler:

```typescript
  it('issue #530: does not finalize below requiredVerdicts (1 of 2 delivered)', async () => {
    await handleTaskCreated({
      event: taskCreatedEvent({ taskId: 7n, requiredVerdicts: 2 }),
      context,
      task,
    });
    await handleVerdictDeliveryClaimed({
      event: verdictDeliveryClaimedEvent({ taskId: 7n, attemptIndex: 0, verdictIndex: 0 }, { block: 100n }),
      context,
      verdict,
      task,
    });
    expect(db.get(task, { id: '7' })?.finalized).toBe(false);
  });

  it('issue #530: finalizes when delivered verdicts reach requiredVerdicts (2 of 2)', async () => {
    await handleTaskCreated({
      event: taskCreatedEvent({ taskId: 7n, requiredVerdicts: 2 }),
      context,
      task,
    });
    await handleVerdictDeliveryClaimed({
      event: verdictDeliveryClaimedEvent({ taskId: 7n, attemptIndex: 0, verdictIndex: 0 }, { block: 100n }),
      context,
      verdict,
      task,
    });
    expect(db.get(task, { id: '7' })?.finalized).toBe(false);
    await handleVerdictDeliveryClaimed({
      event: verdictDeliveryClaimedEvent({ taskId: 7n, attemptIndex: 0, verdictIndex: 1 }, { block: 101n }),
      context,
      verdict,
      task,
    });
    expect(db.get(task, { id: '7' })?.finalized).toBe(true);
  });

  it('issue #530: stays finalized on a replayed (idempotent) verdict event', async () => {
    await handleTaskCreated({
      event: taskCreatedEvent({ taskId: 7n, requiredVerdicts: 1 }),
      context,
      task,
    });
    const ev = verdictDeliveryClaimedEvent({ taskId: 7n, attemptIndex: 0, verdictIndex: 0 }, { block: 100n });
    await handleVerdictDeliveryClaimed({ event: ev, context, verdict, task });
    expect(db.get(task, { id: '7' })?.finalized).toBe(true);
    // Replay: onConflictDoNothing keeps one verdict row; recount is order-independent
    // and must not flip finalized back to false.
    await handleVerdictDeliveryClaimed({ event: ev, context, verdict, task });
    expect(db.count(verdict)).toBe(1);
    expect(db.get(task, { id: '7' })?.finalized).toBe(true);
  });

  it('issue #530: never finalizes when requiredVerdicts == 0', async () => {
    await handleTaskCreated({
      event: taskCreatedEvent({ taskId: 7n, requiredVerdicts: 0 }),
      context,
      task,
    });
    await handleVerdictDeliveryClaimed({
      event: verdictDeliveryClaimedEvent({ taskId: 7n, attemptIndex: 0, verdictIndex: 0 }, { block: 100n }),
      context,
      verdict,
      task,
    });
    expect(db.get(task, { id: '7' })?.finalized).toBe(false);
  });

  it('issue #530: skips finalized recompute when the task row is absent (predates startBlock), still writes the verdict', async () => {
    // No handleTaskCreated — the task row does not exist.
    await expect(
      handleVerdictDeliveryClaimed({
        event: verdictDeliveryClaimedEvent({ taskId: 4242n, attemptIndex: 0, verdictIndex: 0 }, { block: 100n }),
        context,
        verdict,
        task,
      }),
    ).resolves.toBeUndefined();
    // Verdict row is still recorded (acceleration data is not lost)...
    expect(db.get(verdict, { taskId: '4242', attemptIndex: 0, verdictIndex: 0, chainId: CHAIN_ID })).toBeDefined();
    // ...and no task row was conjured.
    expect(db.count(task)).toBe(0);
  });

  it('issue #530: counts only the matching attempt scope (other attempts do not bleed into the count)', async () => {
    await handleTaskCreated({
      event: taskCreatedEvent({ taskId: 7n, requiredVerdicts: 2 }),
      context,
      task,
    });
    // One delivered verdict on attempt 0 and one on attempt 1 — neither attempt
    // alone reaches requiredVerdicts=2, so the task must not finalize.
    await handleVerdictDeliveryClaimed({
      event: verdictDeliveryClaimedEvent({ taskId: 7n, attemptIndex: 0, verdictIndex: 0 }, { block: 100n }),
      context,
      verdict,
      task,
    });
    await handleVerdictDeliveryClaimed({
      event: verdictDeliveryClaimedEvent({ taskId: 7n, attemptIndex: 1, verdictIndex: 0 }, { block: 101n }),
      context,
      verdict,
      task,
    });
    expect(db.get(task, { id: '7' })?.finalized).toBe(false);
  });
```

- [ ] **Step 2: Run the new tests to verify they FAIL (handler does not yet accept `task` / does not recompute)**

Run: `cd packages/indexer && yarn test handlers.test.ts -t "issue #530"`
Expected: FAIL — TypeScript will reject the extra `task` argument to `handleVerdictDeliveryClaimed` (the current signature is `{ event, context, verdict }`), and even if it ran, `finalized` would never be set by the verdict handler. This is the expected red state for TDD.

- [ ] **Step 3: Commit the failing verdict-finalization tests**

```bash
git add packages/indexer/test/handlers.test.ts
git commit -m "test(indexer): VerdictDeliveryClaimed recomputes finalized (issue #530, failing)"
```

---

## Task 3: Extend the in-memory db fake with `countVerdicts`

**Files:**
- Modify: `packages/indexer/test/helpers/in-memory-db.ts`

The `HandlerDb` interface (Task 4) will gain a `countVerdicts(table, scope)` method. The fake implements it by scanning `rows(table)`. We add it to the fake first so the fake compiles against the new interface once Task 4 lands; doing the fake before the interface is fine because the method is purely additive to the returned object.

- [ ] **Step 1: Add the `countVerdicts` method to the `db` object**

In `createInMemoryDb`, inside the returned `db` object (after the `count(table)` method, before the closing `};` at line 166), add:

```typescript
    async countVerdicts(table, scope) {
      const { taskId, attemptIndex, chainId } = scope;
      return [...tableMap(table).values()].filter(
        (r) =>
          r['taskId'] === taskId &&
          r['attemptIndex'] === attemptIndex &&
          r['chainId'] === chainId,
      ).length;
    },
```

- [ ] **Step 2: Verify the fake still typechecks against the (not-yet-extended) interface**

Run: `cd packages/indexer && yarn typecheck`
Expected: FAIL — `countVerdicts` does not exist on `HandlerDb` yet, so the `InMemoryDb extends HandlerDb` object literal has an excess property error OR the method is fine but unused. (If the object-literal excess-property check fires, that's expected; Task 4 adds the interface member and resolves it.) Do not commit yet — Task 3 and Task 4 land together because the interface and its impl are coupled.

> Note: Steps 1 (fake) and Task 4 Step 1 (interface) are a coupled pair. Implement both, then typecheck. The plan separates them for clarity but they commit together at Task 4 Step 6.

---

## Task 4: Move the `finalized` write into `handleVerdictDeliveryClaimed`; strip it from `handleSolutionDeliveryClaimed`

**Files:**
- Modify: `packages/indexer/src/handlers.ts` — `HandlerDb` interface (lines 36-50), `handleVerdictDeliveryClaimed` (lines 336-362), `handleSolutionDeliveryClaimed` (lines 364-386).

- [ ] **Step 1: Extend the `HandlerDb` interface with `countVerdicts`**

In `packages/indexer/src/handlers.ts`, add a `countVerdicts` member to the `HandlerDb` interface. Insert it after the `update` member (after line 49, before the closing `}` at line 50):

```typescript
  /**
   * Count delivered verdict rows for one attempt scope — the indexer's proxy for
   * TaskCoordinator's on-chain `validVerdictCount`. One indexed `verdict` row per
   * delivered verdict (one `VerdictDeliveryClaimed` event). Used by
   * handleVerdictDeliveryClaimed to recompute task.finalized (issue #530).
   *
   * Real wiring (src/index.ts) backs this with `context.db.sql` (Ponder's raw
   * drizzle escape hatch); the in-memory fake scans its rows.
   */
  countVerdicts: (
    table: unknown,
    scope: { taskId: string; attemptIndex: number; chainId: number },
  ) => Promise<number>;
```

- [ ] **Step 2: Rewrite `handleVerdictDeliveryClaimed` to recompute `finalized`**

Replace the function and its leading comment block (lines 336-362) with:

```typescript
// ── JinnRouter: VerdictDeliveryClaimed → verdict (+ recompute task.finalized) ─
// One row per delivered verdict. verdictCode 0..4 per the VerdictCode enum.
// Idempotent: a replayed event with the same (taskId, attemptIndex, verdictIndex,
// chainId) does not clobber the original (onConflictDoNothing).
//
// Finalization (issue #530): on JinnRouter V3, on-chain finalization is
// `attempt.validVerdictCount == requiredVerdicts` (TaskCoordinator.recordVerdict).
// VerdictDeliveryClaimed fires once per *delivered* verdict, so the count of
// delivered `verdict` rows for this attempt scope equals validVerdictCount.
// After inserting the verdict row, recompute: finalized iff
// requiredVerdicts > 0 && deliveredCount >= requiredVerdicts. Mirrors
// metrics.ts:attemptFinalization. Monotonic — never flips finalized back to
// false (db.update only ever sets it to true here).
//
// Existence guard (mirrors handleSolutionDeliveryClaimed): the matching
// TaskCreated may predate `startBlock`, leaving no `task` row. db.update on a
// missing row throws and crashes the indexer, so look it up first and skip the
// finalized recompute if absent. The verdict row is still written either way.
export async function handleVerdictDeliveryClaimed({
  event,
  context,
  verdict,
  task,
}: {
  event: VerdictDeliveryClaimedEvent;
  context: HandlerContext;
  verdict: unknown;
  task: unknown;
}): Promise<void> {
  const taskId = event.args.taskId.toString();
  const attemptIndex = Number(event.args.attemptIndex);
  const chainId = context.chain.id;

  await context.db
    .insert(verdict)
    .values({
      taskId,
      attemptIndex,
      verdictIndex: Number(event.args.verdictIndex),
      evaluator: event.args.evaluator,
      requestId: event.args.requestId,
      verdictCode: Number(event.args.verdictCode),
      createdAtBlock: event.block.number,
      chainId,
    })
    .onConflictDoNothing();

  // Recompute finalized from the task's requiredVerdicts vs delivered verdicts.
  const existing = (await context.db.find(task, { id: taskId })) as
    | { requiredVerdicts: number; finalized: boolean }
    | null;
  if (!existing) return; // TaskCreated predates startBlock — skip; verdict row already written.
  if (existing.finalized) return; // Monotonic — already final, nothing to do.

  const requiredVerdicts = existing.requiredVerdicts;
  if (requiredVerdicts <= 0) return; // requiredVerdicts == 0 → never finalizes.

  const deliveredCount = await context.db.countVerdicts(verdict, {
    taskId,
    attemptIndex,
    chainId,
  });
  if (deliveredCount >= requiredVerdicts) {
    await context.db.update(task, { id: taskId }).set({ finalized: true });
  }
}
```

- [ ] **Step 3: Strip the `finalized` write from `handleSolutionDeliveryClaimed` and fix its comment**

Replace the comment block + function at lines 364-386 with:

```typescript
// ── JinnRouter: SolutionDeliveryClaimed ──────────────────────────────────────
// A solution-slot delivery — the START of the evaluation phase, NOT finalization
// (issue #530). On-chain finalization is `validVerdictCount >= requiredVerdicts`
// and is handled in handleVerdictDeliveryClaimed. This handler deliberately does
// NOT touch task.finalized.
//
// At v0.1 there is nothing for this handler to persist beyond what TaskAttempt /
// Verdict events already record, but it keeps the existence guard + signature so
// src/index.ts can still register it (and so a future per-attempt
// solution-delivery column has a home). The guard: the matching TaskCreated may
// predate `startBlock`, leaving no `task` row; we look it up and skip if absent
// rather than crash. The daemon's canClaimTask simulation is the correctness
// gate regardless.
export async function handleSolutionDeliveryClaimed({
  event,
  context,
  task,
}: {
  event: SolutionDeliveryClaimedEvent;
  context: HandlerContext;
  task: unknown;
}): Promise<void> {
  const id = event.args.taskId.toString();
  const existing = await context.db.find(task, { id });
  if (!existing) return;
  // Intentionally a no-op on task.finalized — see issue #530. SolutionDeliveryClaimed
  // is the start of evaluation; finalization is recomputed in
  // handleVerdictDeliveryClaimed from delivered-verdict count vs requiredVerdicts.
}
```

- [ ] **Step 4: Wire the real Ponder db's `countVerdicts` and pass `task` into the verdict registration**

In `packages/indexer/src/index.ts`:

(a) Add the drizzle aggregate imports. Find the existing `import { ponder } from 'ponder:registry';` line and add, just below it:

```typescript
import { and, count, eq } from 'ponder';
```

(b) Replace the `JinnRouter:VerdictDeliveryClaimed` registration (the `ponder.on('JinnRouter:VerdictDeliveryClaimed', ...)` block at lines 89-95) with a version that builds a `HandlerContext` whose `db` adds `countVerdicts` over the real `context.db`, and passes `task`:

```typescript
ponder.on('JinnRouter:VerdictDeliveryClaimed', async ({ event, context }) => {
  const baseDb = context.db as unknown as HandlerContext['db'];
  const handlerContext: HandlerContext = {
    chain: context.chain as unknown as HandlerContext['chain'],
    db: {
      ...baseDb,
      // Back countVerdicts with Ponder's raw drizzle (context.db.sql) — the
      // documented read/aggregate escape hatch inside indexing functions
      // (https://ponder.sh/docs/indexing/write#raw-sql).
      countVerdicts: async (table, scope) => {
        const rows = await (context.db as any).sql
          .select({ c: count() })
          .from(table)
          .where(
            and(
              eq((table as any).taskId, scope.taskId),
              eq((table as any).attemptIndex, scope.attemptIndex),
              eq((table as any).chainId, scope.chainId),
            ),
          );
        return Number(rows[0]?.c ?? 0);
      },
    },
  };
  await handleVerdictDeliveryClaimed({
    event: event as unknown as VerdictDeliveryClaimedEvent,
    context: handlerContext,
    verdict,
    task,
  });
});
```

> Note: `context.db` already carries `find / insert / update`, which the spread copies. The arrow methods on `context.db` are not own-enumerable in every drizzle build; if the spread drops them at runtime, fall back to constructing the object explicitly — `db: { find: baseDb.find.bind(baseDb), insert: baseDb.insert.bind(baseDb), update: baseDb.update.bind(baseDb), countVerdicts: ... }`. Prefer the spread first; switch only if the daemon-harness e2e or a typecheck error shows methods missing.

- [ ] **Step 5: Implement `countVerdicts` in the in-memory fake**

This is Task 3 Step 1 — confirm it is present in `packages/indexer/test/helpers/in-memory-db.ts`. If you skipped Task 3, add the method now (see Task 3 Step 1 for the exact code).

- [ ] **Step 6: Typecheck, run the full indexer test suite, commit**

Run: `cd packages/indexer && yarn typecheck`
Expected: PASS (zero errors).

Run: `cd packages/indexer && yarn test handlers.test.ts`
Expected: PASS — all Task 1 + Task 2 cases green, and the pre-existing verdict / task / metadata tests still green.

```bash
git add packages/indexer/src/handlers.ts packages/indexer/src/index.ts packages/indexer/test/helpers/in-memory-db.ts
git commit -m "fix(indexer): recompute task.finalized from delivered verdicts vs requiredVerdicts (issue #530)"
```

---

## Task 5: Correct the stale comments (handlers, schema, README)

**Files:**
- Modify: `packages/indexer/ponder.schema.ts` (header NOTE lines ~27-33; `finalized` column doc lines ~88-93; `Task` table doc lines ~49-55)
- Modify: `packages/indexer/README.md` (known-limitations paragraph lines ~77-90)

(The `handlers.ts` comments were already corrected in Task 4 Steps 2-3.)

- [ ] **Step 1: Fix the `ponder.schema.ts` header NOTE on `Task.finalized`**

Replace the `NOTE on Task.finalized / Task.refunded:` paragraph (lines 27-33) with:

```
 * NOTE on Task.finalized / Task.refunded:
 *   JinnRouter does not emit standalone TaskFinalized or TaskRefunded events at
 *   v0.1. `finalized` is recomputed in handleVerdictDeliveryClaimed: it is set to
 *   true once the count of delivered `verdict` rows for an attempt reaches the
 *   task's `requiredVerdicts` — the indexer's proxy for TaskCoordinator's
 *   on-chain `validVerdictCount == requiredVerdicts` finalization rule (issue
 *   #530). It is NOT set on SolutionDeliveryClaimed (that is the start of
 *   evaluation, not the end). `refunded` is set from TaskBudgetRefunded. The
 *   daemon's canClaimTask simulation compensates at claim time. See
 *   README.md §Known limitations.
```

- [ ] **Step 2: Fix the `Task` table doc comment**

Replace lines 49-55 (the `One JinnRouter task. Created on TaskCreated, marked finalized on / SolutionDeliveryClaimed.` doc) with:

```
/**
 * One JinnRouter task. Created on TaskCreated; `finalized` recomputed on
 * VerdictDeliveryClaimed when delivered verdicts reach requiredVerdicts
 * (issue #530).
 *
 * Supports findClaimableTasks: filter by manifestDigest, finalized, refunded;
 * join with Attempt for attempt/operatorAttempt counts.
 */
```

- [ ] **Step 3: Fix the `finalized` column doc comment**

Replace the `finalized` column doc (lines 88-93) with:

```
    /**
     * True once delivered verdicts for any attempt reach the task's
     * requiredVerdicts — the indexer's proxy for TaskCoordinator's on-chain
     * `validVerdictCount == requiredVerdicts` finalization (issue #530).
     * Recomputed in handleVerdictDeliveryClaimed; NOT set on
     * SolutionDeliveryClaimed. Monotonic.
     */
```

- [ ] **Step 4: Fix the README known-limitations paragraph**

Replace the `### No TaskFinalized / TaskRefunded events` paragraph body (lines 79-90, the two paragraphs ending at "...the simulation is the truth.") with:

```
JinnRouter V3 does not emit a standalone `TaskFinalized` event. The indexer
recomputes `task.finalized` in the `VerdictDeliveryClaimed` handler: it sets
`finalized = true` once the count of delivered `verdict` rows for an attempt
reaches the task's `requiredVerdicts`, mirroring TaskCoordinator's on-chain
`validVerdictCount == requiredVerdicts` rule (issue #530). `finalized` is NOT
set on `SolutionDeliveryClaimed` — that event is the start of the evaluation
phase, not finalization. When `requiredVerdicts == 0` the task never finalizes.

`task.refunded` is populated from `JinnRouter.TaskBudgetRefunded` (wired in
`ebu7.2`). `TaskBudgetRefunded` does exist on V3 — the prior comment claiming
it did not was stale.

The daemon compensates: its `canClaimTask` simulation (in
`client/src/adapters/mech/contracts.ts`) is the correctness gate before any
claim is attempted. The indexer is an acceleration path; the simulation is the
truth.
```

- [ ] **Step 5: Typecheck (comments only — should still pass) and commit**

Run: `cd packages/indexer && yarn typecheck`
Expected: PASS.

```bash
git add packages/indexer/ponder.schema.ts packages/indexer/README.md
git commit -m "docs(indexer): correct finalized comments — VerdictDeliveryClaimed, not SolutionDeliveryClaimed (issue #530)"
```

---

## Task 6: Final verification

**Files:** none (verification only).

- [ ] **Step 1: Full typecheck**

Run: `cd packages/indexer && yarn typecheck`
Expected: PASS, zero errors.

- [ ] **Step 2: Full indexer test suite (not just handlers)**

Run: `cd packages/indexer && yarn test`
Expected: PASS — handler tests (including all `issue #530` cases), metrics tests, plugin drift tests, all green. Confirm no test still asserts `SolutionDeliveryClaimed → finalized true`.

- [ ] **Step 3: Confirm no other code path sets `finalized` on solution delivery**

Run: `cd packages/indexer && grep -rn "finalized" src/ | grep -i "solution\|SolutionDelivery"`
Expected: no matches (the only solution-delivery reference to finalized should be the corrected no-op comment in `handlers.ts`).

Run: `cd packages/indexer && grep -rn "finalized: true\|finalized = true\|finalized: true" src/`
Expected: the only write is in `handleVerdictDeliveryClaimed` (`.set({ finalized: true })`). `TaskCreated` still inserts `finalized: false`. No other write site.

---

## Acceptance criteria → test mapping

| Acceptance criterion (issue #530) | Covered by |
|---|---|
| `SolutionDeliveryClaimed` no longer marks a not-finalized task as finalized | Task 1 — `SolutionDeliveryClaimed > does NOT mark the task finalized` |
| Indexer `finalized` matches on-chain verdict-delivery finalization (`validVerdictCount >= requiredVerdicts`) | Task 2 — `finalizes when delivered verdicts reach requiredVerdicts (2 of 2)` |
| `finalized` stays false below the threshold (the task-188 Open case) | Task 2 — `does not finalize below requiredVerdicts (1 of 2 delivered)` |
| Monotonic — never flips back to false on replay | Task 2 — `stays finalized on a replayed (idempotent) verdict event` |
| Edge: `requiredVerdicts == 0` → never finalizes | Task 2 — `never finalizes when requiredVerdicts == 0` |
| Edge: TaskCreated predates startBlock (existence guard) | Task 2 — `skips finalized recompute when the task row is absent ...` |
| Edge: per-attempt count scope (no cross-attempt bleed) | Task 2 — `counts only the matching attempt scope ...` |
| Fix is systematic, not a one-off (rule mirrors `metrics.ts:attemptFinalization`, recomputed on the correct event) | Task 4 (handler), grounded in `TaskCoordinator.sol:540-556` |
| Stale "terminal success state" comments corrected | Task 4 (handlers.ts) + Task 5 (schema, README) |
| No schema/index change; read sites keep the cheap indexed boolean | By construction — no `ponder.schema.ts` column/index edits, only doc comments |

---

## Verification commands (summary)

- Typecheck: `cd packages/indexer && yarn typecheck`
- Indexer tests: `cd packages/indexer && yarn test`
- Targeted: `cd packages/indexer && yarn test handlers.test.ts -t "issue #530"`

(`yarn test` runs `vitest run` per `packages/indexer/package.json`. The e2e/daemon-harness suites in `client/` are not required for this indexer-only fix.)

---

## Self-review notes

- **Spec coverage:** every acceptance bullet maps to a Task 2 case or a Task 4/5 comment edit (see table). The counting approach is contract-grounded (`validVerdictCount`, not `verdictIndex+1`), with the rationale documented inline.
- **Type consistency:** `handleVerdictDeliveryClaimed`'s new `task` param is added in the signature (Task 4 Step 2), the wiring (Task 4 Step 4), and every test call (Task 2). `countVerdicts(table, { taskId, attemptIndex, chainId })` has the identical signature in the interface (Task 4 Step 1), the fake (Task 3), and the real wiring (Task 4 Step 4). `handleSolutionDeliveryClaimed` keeps its `{ event, context, task }` signature — only behaviour changes — so its existing `index.ts` registration and tests need no signature edit.
- **Placeholder scan:** no TBD/“handle edge cases” — every step has concrete code and an exact command with expected output.
- **Coupling note:** Task 3 (fake method) and Task 4 Steps 1-5 (interface + handlers + wiring) are interdependent and commit together at Task 4 Step 6; Tasks 1 and 2 commit their failing tests first to honour regression-test-first discipline.
