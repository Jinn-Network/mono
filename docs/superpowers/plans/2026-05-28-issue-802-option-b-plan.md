# Issue #802 — swe-rebench-v2 re-post on claim-budget exhaustion (Option B) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Flip the swe-rebench-v2 generator's re-post trigger from a local time window (`last_posted_at + posting_window_ms`) to observed on-chain claim-budget exhaustion (indexer-derived), and remove the abandon cap so hard instances retry indefinitely.

**Architecture:** The generator already reconciles per-instance *success* counts against the indexer via `DiscoveryAPI.getInstanceSuccessCounts` and aborts the tick on indexer outage. We add a sibling query `getInstanceClaimCounts({ manifestCid })` that returns per-on-chain-taskId consumed-slots-vs-maxClaims, modelled one-for-one on the success-counts query (same outage / floor / fallback semantics). The generator records the on-chain `taskId` it posted for each instance in its local `generator-state.json` ledger (the on-chain `task`/`attempt` tables carry no `instance_id`, so the taskId→instance join is local), then classifies a posting `live` while `consumed < maxClaims`, `repostable` once `consumed >= maxClaims && successful < N`, and `saturated` once `successful >= N`. The `abandoned` state and `N_max_postings_per_task` cap are removed (the cap defaults to `Infinity`, opt-in).

**Tech Stack:** TypeScript (Node 22, ESM), Vitest, viem, Ponder GraphQL indexer. All work is in `client/`. Run `corepack enable` once, then `yarn install` in `client/`.

---

## Pre-flight (read before starting)

- Design note: `docs/superpowers/specs/2026-05-28-issue-802-option-b-design.md` (primary input; follow its "AC#5 (revised)" section — escrow reclaim is OUT of scope, no refunds, `posting_window_ms` stays as the on-chain deadline).
- DR being amended: `log/decisions/2026-05-22-swe-rebench-v2-generation-claiming-semantics.md` (DR-2026-05-22-a).
- Test SOP: `docs/runbooks/testing.md`. Shape = `feat` → TDD (write the failing test first for each behavioural change).

**Verified facts the plan relies on (grounded by reading source):**

1. `client/tsconfig.json` has `"exclude": [..., "test", ...]` and `"include": ["src"]`. `yarn typecheck` (`tsc --noEmit`) does NOT typecheck `test/`, and Vitest transpiles test files with esbuild (types stripped). **Consequence:** adding a method to the `DiscoveryAPI` interface will NOT break the many existing `: DiscoveryAPI` / `satisfies DiscoveryAPI` test mocks that omit it. You only need to add the new method to the three *source* implementations (`http.ts`, `onchain.ts`, `with-fallback.ts`) for `yarn typecheck` to pass. New test mocks you author should still include it for honesty, but you do NOT have to retrofit every existing mock.
2. The on-chain `taskId` is assigned by `TaskPostingService.postCandidate` and surfaces as `postResult.taskId` inside `CreatorLoop.tick` (`client/src/daemon/creator.ts:73`). The generator's `tick()` runs earlier and only knows its own UUID — it never sees the on-chain taskId. So the `last_task_id` ledger write must happen in `CreatorLoop.tick`, gated on swe-rebench-v2, mirroring the existing `recordSuccess` hook in `delivery-watcher.ts:55-70`. This is a real wiring path the design note under-specifies; this plan makes it explicit (Tasks 3–4).
3. Indexer schema (`packages/indexer/ponder.schema.ts`): `task.id` (decimal-string taskId, primary key), `task.maxClaims` (`integer().notNull()`), `task.manifestDigest` (`hex().notNull()`, indexed), `attempt.taskId` (`text().notNull()`, indexed). So consumed-slots = count of `attempt` rows for a taskId; budget = that task's `maxClaims`. The success-counts query's two-leg pattern (`OPERATOR_COUNT_TASKS_QUERY` → tasks for a `manifestDigest`, then `ATTEMPTS_FOR_TASKS_QUERY` → attempts batched by `taskId_in`) is directly reusable. **All design assumptions about indexer availability hold.**
4. Divergence from the design's "one-for-one" floor framing, flagged but resolved: unlike `getInstanceSuccessCounts` (IPFS-enrichment-only, so its floor genuinely cannot reconstruct), `getInstanceClaimCounts` data IS reconstructible on the on-chain floor (`OnchainDiscoveryAPI.findClaimableTasks` already derives `maxClaims` + `attemptCount` per task from `TaskCreated`/`TaskAttemptCreated` logs — `onchain.ts:801-815`). The plan still makes the floor a **no-op empty Map** and makes `withFallback` route `getInstanceClaimCounts` to the primary only (never the floor), exactly mirroring success-counts. Rationale: the load-bearing requirement (AC#4/AC#5, design Approach + Trade-off 1) is "abort the tick on indexer outage; never under-count." An empty floor that silently returns "0 consumed for every task" would mark every posting `live` and suppress all reposts — the same under-count bug success-counts was hardened against. Keeping the floor empty + non-routed is the symmetric, safe choice and keeps the diff minimal. (If a future issue wants a live on-chain claim floor, that is its own scoped change.)

**Establish a green baseline first.** Run `cd client && yarn install` then `yarn typecheck` (expect EXIT 0) and the targeted suites in Task 9's verify command (expect all pass). Do not start editing until baseline is green.

---

## File Structure

Files created or modified, by responsibility:

- `client/src/discovery/types.ts` — add `InstanceClaimCount` result type + `getInstanceClaimCounts` to the `DiscoveryAPI` interface (with the abort-on-outage JSDoc contract).
- `client/src/discovery/http.ts` — implement `getInstanceClaimCounts` (two-leg paginated GraphQL: tasks-for-digest, then attempts-for-tasks; group consumed-vs-maxClaims by taskId).
- `client/src/discovery/onchain.ts` — add `getInstanceClaimCounts` floor stub returning an empty Map.
- `client/src/discovery/with-fallback.ts` — route `getInstanceClaimCounts` to the primary only (never floor), mirroring `getInstanceSuccessCounts`.
- `client/src/solver-types/_swe-rebench-v2-state.ts` — add `last_task_id` to `TaskCounters` + a `recordLastTaskId(instance_id, taskId)` method; default it everywhere counters are defaulted.
- `client/src/daemon/creator.ts` — record `last_task_id` after a swe-rebench-v2 posting (mirrors the delivery-watcher `recordSuccess` hook).
- `client/src/solver-types/swe-rebench-v2-auto.ts` — rewrite `classifyPoolTask` / `selectNextPostingCandidates` to a claim-budget model; drop `abandoned` + the in-batch cap; default `N_max_postings_per_task` to `Infinity`.
- `client/src/solver-types/swe-rebench-v2.ts` — wire `getInstanceClaimCounts` reconciliation into the tick (mirror the success-counts abort-on-outage block); pass consumed/maxClaims into classification; keep `posting_window_ms` as the on-chain deadline; drop `abandoned` from `lastPollSummary`.
- `client/src/api/launcher-status.ts`, `client/src/solvernets/launched-record-dispatcher.ts`, `client/src/dashboard/spa/src/api/types.ts`, `client/src/dashboard/spa/src/pages/launcher-launched/GeneratorPanel.tsx` — remove `abandoned` from the launcher-status pool-summary surface chain (required so Task 8's snapshot change does not break the rendered surface).
- `log/decisions/2026-05-22-swe-rebench-v2-generation-claiming-semantics.md` — short "superseded by #802" note at the top of §Decision.

Test files:

- `client/test/discovery/http.test.ts` — new `getInstanceClaimCounts` describe block.
- `client/test/discovery/onchain.test.ts` — new floor-stub test.
- `client/test/discovery/with-fallback.test.ts` — new non-routing test.
- `client/test/solver-types/swe-rebench-v2-state.test.ts` — `last_task_id` persistence tests.
- `client/test/solver-types/swe-rebench-v2-auto.test.ts` — rewrite classification tests for the claim-budget model.
- `client/test/solver-types/swe-rebench-v2-generator-cooldown.test.ts` — update the time-window assertions (rename describe, drop `abandoned` expectations); add exhaustion-driven repost + abort-on-outage generator tests.
- `client/test/daemon/creator.test.ts` (new or existing) — `last_task_id` wiring test.
- `client/test/main/launched-record-dispatcher.test.ts` — drop `abandoned` from pool-summary fixtures/expectations.
- `client/src/dashboard/spa/src/pages/launcher-launched/GeneratorPanel.test.tsx` — drop the `abandoned` fixture + render assertion.

---

## Acceptance-criteria → task map

- **AC#1** (exhausted + successes<N re-posts within one tick): Tasks 5, 7, 8.
- **AC#2** (reach N → saturated, stop): Tasks 5, 7 (the `successful >= N` branch is preserved).
- **AC#3** (hard instance retried indefinitely; abandon cap removed/opt-in): Tasks 5, 6.
- **AC#4** (exhaustion from indexer counts, not `last_posted_at + posting_window_ms`): Tasks 1, 2, 5, 7.
- **AC#5 revised** (time-driven repost *trigger* removed; on-chain claim-window deadline unchanged; no escrow reclaim): Tasks 5, 7 (deadline still derives from `posting_window_ms` at `swe-rebench-v2.ts:652`; no refund code touched), Task 11 (DR note).
- **Indexer-outage aborts the tick (never under-count)**: Tasks 3 (interface contract), 4 (withFallback), 8 (generator abort block + test).
- **Do-not-break existing surfaces** (carve-out): Task 9 removes `abandoned` from the launcher-status / SPA pool-summary chain that Task 8's snapshot change would otherwise break.

---

## Task 1: Add the `getInstanceClaimCounts` result type to discovery types

**Files:**
- Modify: `client/src/discovery/types.ts` (add type near `ClaimableTaskCandidate`, ~line 50; add interface method after `getInstanceSuccessCounts`, ~line 295)

- [ ] **Step 1: Add the result-shape type**

In `client/src/discovery/types.ts`, immediately after the `ClaimableTaskCandidate` interface (ends at line 50), add:

```typescript
/**
 * Per-on-chain-task claim-budget snapshot for a launched SolverNet. Returned by
 * `getInstanceClaimCounts`, keyed by **on-chain taskId** (decimal string) — NOT
 * by instance_id, because the on-chain `task`/`attempt` tables carry no
 * instance_id (only IPFS enrichment does). The generator owns the
 * taskId → instance_id join via its local `generator-state.json` ledger
 * (`last_task_id`), so it looks up its known posted taskIds in this map.
 */
export interface InstanceClaimCount {
  /** On-chain taskId (decimal string), matching `task.id` in the indexer. */
  taskId: string;
  /** Number of attempt rows recorded for this task = consumed claim slots. */
  consumed: number;
  /** maxClaims from the task's TaskCreated event = the one-way claim budget. */
  maxClaims: number;
}
```

- [ ] **Step 2: Add the interface method with its outage contract**

In `client/src/discovery/types.ts`, inside the `DiscoveryAPI` interface, after the `getInstanceSuccessCounts(...)` method (closes at line 294), add:

```typescript
  /**
   * Returns the per-task claim-budget snapshot for every task posted on the
   * SolverNet identified by `manifestCid`. Keyed by on-chain taskId; each value
   * carries `consumed` (count of `attempt` rows) and `maxClaims` (the one-way
   * claim budget from TaskCreated). A task is *exhausted* when
   * `consumed >= maxClaims`.
   *
   * Modelled one-for-one on `getInstanceSuccessCounts`: backed by the indexer's
   * `task` + `attempt` tables. Throws `DiscoveryUnavailableError` when the
   * backing is unreachable — callers MUST NOT silently fall through to
   * local-only state. The `withFallback` wrapper enforces this by never routing
   * `getInstanceClaimCounts` to the floor: an empty Map from the floor is
   * indistinguishable from "every task has 0 consumed slots", which would mark
   * every posting `live` and suppress all reposts (the under-count bug this
   * method exists to avoid — #802, mirroring #669).
   *
   * The on-chain floor implementation returns an empty Map (the runtime path is
   * never the floor for this method — `withFallback` propagates the error
   * instead). The claim data IS reconstructible on-chain, but the floor stays a
   * no-op to keep the abort-on-outage guarantee symmetric with
   * `getInstanceSuccessCounts`.
   */
  getInstanceClaimCounts(args: {
    manifestCid: string;
  }): Promise<Map<string, InstanceClaimCount>>;
```

- [ ] **Step 3: Verify it compiles (will fail until impls exist)**

Run: `cd client && yarn typecheck`
Expected: FAIL — `Property 'getInstanceClaimCounts' is missing` on the three implementation return objects in `http.ts`, `onchain.ts`, `with-fallback.ts`. (This confirms the interface is now binding; Tasks 2–4 add the implementations.)

- [ ] **Step 4: Commit**

```bash
git add client/src/discovery/types.ts
git commit -m "feat(802): add getInstanceClaimCounts to DiscoveryAPI interface"
```

---

## Task 2: Implement `getInstanceClaimCounts` in HttpDiscoveryAPI

**Files:**
- Modify: `client/src/discovery/http.ts` (add query string near `INSTANCE_SUCCESS_COUNTS_QUERY` ~line 232; add impl after `getInstanceSuccessCounts` ~line 1050; add to the returned object ~line 1061)
- Test: `client/test/discovery/http.test.ts` (new describe block after the existing `getInstanceSuccessCounts` block, ~line 1158)

The existing `getSolverNetOperatorCount` (`http.ts:802-859`) already pages tasks for a `manifestDigest` (leg 1) then pages attempts via `taskId_in` (leg 2). Reuse that exact two-leg pattern, but capture each task's `maxClaims` in leg 1 and count attempts per taskId in leg 2.

- [ ] **Step 1: Write the failing test**

Add to `client/test/discovery/http.test.ts` (the file already imports `createHttpDiscoveryAPI`, `DiscoveryUnavailableError`, `vi`, and has an `isReadyProbe(url)` helper — reuse them):

```typescript
describe('HttpDiscoveryAPI.getInstanceClaimCounts (#802)', () => {
  it('returns consumed-vs-maxClaims per taskId for the SolverNet', async () => {
    // Leg 1: tasks-for-digest page (id + maxClaims + chainId).
    const tasksPage = {
      data: {
        tasks: {
          items: [
            { id: '100', maxClaims: 5, chainId: 84532 },
            { id: '101', maxClaims: 3, chainId: 84532 },
          ],
          pageInfo: { hasNextPage: false, endCursor: null },
        },
      },
    };
    // Leg 2: attempts for those task ids (5 for task 100 = exhausted; 1 for 101 = live).
    const attemptsPage = {
      data: {
        attempts: {
          items: [
            { taskId: '100' }, { taskId: '100' }, { taskId: '100' },
            { taskId: '100' }, { taskId: '100' },
            { taskId: '101' },
          ],
          pageInfo: { hasNextPage: false, endCursor: null },
        },
      },
    };
    let leg = 0;
    const fetchImpl = vi.fn(async (url: string) => {
      if (isReadyProbe(url)) return new Response('ok', { status: 200 });
      leg += 1;
      return new Response(JSON.stringify(leg === 1 ? tasksPage : attemptsPage), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }) as unknown as typeof fetch;

    const api = createHttpDiscoveryAPI({ url: 'http://stub/graphql', fetchImpl });
    const counts = await api.getInstanceClaimCounts({ manifestCid: 'bafymanifest' });

    expect(counts.get('100')).toEqual({ taskId: '100', consumed: 5, maxClaims: 5 });
    expect(counts.get('101')).toEqual({ taskId: '101', consumed: 1, maxClaims: 3 });
    expect(counts.size).toBe(2);
  });

  it('reports zero consumed for a task with no attempts yet', async () => {
    const tasksPage = {
      data: {
        tasks: {
          items: [{ id: '200', maxClaims: 4, chainId: 84532 }],
          pageInfo: { hasNextPage: false, endCursor: null },
        },
      },
    };
    const attemptsPage = {
      data: { attempts: { items: [], pageInfo: { hasNextPage: false, endCursor: null } } },
    };
    let leg = 0;
    const fetchImpl = vi.fn(async (url: string) => {
      if (isReadyProbe(url)) return new Response('ok', { status: 200 });
      leg += 1;
      return new Response(JSON.stringify(leg === 1 ? tasksPage : attemptsPage), {
        status: 200, headers: { 'content-type': 'application/json' },
      });
    }) as unknown as typeof fetch;

    const api = createHttpDiscoveryAPI({ url: 'http://stub/graphql', fetchImpl });
    const counts = await api.getInstanceClaimCounts({ manifestCid: 'bafymanifest' });
    expect(counts.get('200')).toEqual({ taskId: '200', consumed: 0, maxClaims: 4 });
  });

  it('returns an empty Map when the SolverNet has no tasks', async () => {
    const empty = {
      data: { tasks: { items: [], pageInfo: { hasNextPage: false, endCursor: null } } },
    };
    const fetchImpl = vi.fn(async (url: string) => {
      if (isReadyProbe(url)) return new Response('ok', { status: 200 });
      return new Response(JSON.stringify(empty), {
        status: 200, headers: { 'content-type': 'application/json' },
      });
    }) as unknown as typeof fetch;
    const api = createHttpDiscoveryAPI({ url: 'http://stub/graphql', fetchImpl });
    const counts = await api.getInstanceClaimCounts({ manifestCid: 'bafymanifest' });
    expect(counts.size).toBe(0);
  });

  it('throws DiscoveryUnavailableError when GraphQL returns errors', async () => {
    const fetchImpl = vi.fn(async (url: string) => {
      if (isReadyProbe(url)) return new Response('ok', { status: 200 });
      return new Response(JSON.stringify({ errors: [{ message: 'indexer cold' }] }), {
        status: 200, headers: { 'content-type': 'application/json' },
      });
    }) as unknown as typeof fetch;
    const api = createHttpDiscoveryAPI({ url: 'http://stub/graphql', fetchImpl });
    await expect(api.getInstanceClaimCounts({ manifestCid: 'bafymanifest' }))
      .rejects.toBeInstanceOf(DiscoveryUnavailableError);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd client && yarn vitest run test/discovery/http.test.ts -t "getInstanceClaimCounts"`
Expected: FAIL — `api.getInstanceClaimCounts is not a function`.

- [ ] **Step 3: Add the leg-1 query string**

In `client/src/discovery/http.ts`, after the `INSTANCE_SUCCESS_COUNTS_QUERY` block (ends ~line 258), add a tasks-for-digest query that also selects `maxClaims`. (`OPERATOR_COUNT_TASKS_QUERY` at line 180 selects only `id`+`chainId`; we need `maxClaims` too, so add a dedicated query rather than widen the shared one.)

```typescript
/**
 * Leg 1 of getInstanceClaimCounts (#802): page every task id + maxClaims for a
 * SolverNet's manifestDigest. Leg 2 reuses ATTEMPTS_FOR_TASKS_QUERY to count
 * attempts (= consumed slots) per task. Same two-leg shape as
 * getSolverNetOperatorCount; the only delta is selecting maxClaims here.
 */
const CLAIM_COUNT_TASKS_QUERY = `
query ClaimCountTasks($manifestDigest: String!, $limit: Int!, $after: String) {
  tasks(
    where: { manifestDigest: $manifestDigest },
    limit: $limit,
    after: $after,
    orderBy: "id",
    orderDirection: "asc"
  ) {
    items {
      id
      maxClaims
      chainId
    }
    pageInfo {
      hasNextPage
      endCursor
    }
  }
}
`;
```

- [ ] **Step 4: Add the leg-1 response type**

In `client/src/discovery/http.ts`, after the `OperatorCountAttemptsPage` interface (~line 367), add:

```typescript
interface ClaimCountTasksPage {
  tasks: {
    items: Array<{ id: string; maxClaims: number; chainId: number }>;
    pageInfo?: { hasNextPage: boolean; endCursor: string | null };
  };
}
```

- [ ] **Step 5: Implement `getInstanceClaimCounts`**

In `client/src/discovery/http.ts`, after the `getInstanceSuccessCounts` function (closes at line 1050, before the `return { ... }` object), add. Note: `ATTEMPTS_FOR_TASKS_QUERY` returns `attempts.items[].taskId`, batched via `taskId_in` + `chainId` — exactly what leg 2 needs; reuse it. The attempt-paging loop mirrors `getSolverNetOperatorCount` leg 2.

```typescript
  // ── getInstanceClaimCounts (#802) ──────────────────────────────────────────
  // Per-task consumed-vs-maxClaims for a SolverNet. Two legs, mirroring
  // getSolverNetOperatorCount: leg 1 pages tasks (+ maxClaims) for the
  // manifestDigest; leg 2 pages attempts (consumed slots) batched by taskId_in.
  async function getInstanceClaimCounts(args: {
    manifestCid: string;
  }): Promise<Map<string, InstanceClaimCount>> {
    await ensureReady();

    const manifestDigest = manifestDigestForCid(args.manifestCid).toLowerCase();

    // Leg 1: task ids + maxClaims for this SolverNet (single-chain → shared chainId).
    const maxClaimsByTaskId = new Map<string, number>();
    const taskIds: string[] = [];
    let chainId: number | undefined;
    let taskCursor: string | null = null;
    for (let page = 0; page < MAX_OPERATOR_COUNT_TASK_PAGES; page++) {
      const data: ClaimCountTasksPage = await postGql<ClaimCountTasksPage>(
        gqlUrl,
        fetchImpl,
        CLAIM_COUNT_TASKS_QUERY,
        { manifestDigest, limit: ATTEMPTS_PAGE_LIMIT, after: taskCursor },
      );
      for (const row of data.tasks?.items ?? []) {
        taskIds.push(row.id);
        maxClaimsByTaskId.set(row.id, row.maxClaims);
        if (chainId === undefined) chainId = row.chainId;
      }
      const pageInfo = data.tasks?.pageInfo;
      if (!pageInfo?.hasNextPage || !pageInfo.endCursor) break;
      taskCursor = pageInfo.endCursor;
    }

    if (taskIds.length === 0 || chainId === undefined) {
      return new Map();
    }

    // Leg 2: count attempts per taskId (= consumed slots), batched by taskId_in.
    const consumedByTaskId = new Map<string, number>();
    let attemptCursor: string | null = null;
    for (;;) {
      const data: AttemptsPage = await postGql<AttemptsPage>(
        gqlUrl,
        fetchImpl,
        ATTEMPTS_FOR_TASKS_QUERY,
        { taskIds, chainId, limit: ATTEMPTS_PAGE_LIMIT, after: attemptCursor },
      );
      for (const a of data.attempts?.items ?? []) {
        consumedByTaskId.set(a.taskId, (consumedByTaskId.get(a.taskId) ?? 0) + 1);
      }
      const pageInfo = data.attempts?.pageInfo;
      if (!pageInfo?.hasNextPage || !pageInfo.endCursor) break;
      attemptCursor = pageInfo.endCursor;
    }

    const out = new Map<string, InstanceClaimCount>();
    for (const taskId of taskIds) {
      out.set(taskId, {
        taskId,
        consumed: consumedByTaskId.get(taskId) ?? 0,
        maxClaims: maxClaimsByTaskId.get(taskId) ?? 0,
      });
    }
    return out;
  }
```

- [ ] **Step 6: Add the import and register the method on the returned object**

In `client/src/discovery/http.ts`, change the type import at the top of the file. Find the existing import of discovery types (the file already imports `DiscoveryAPI`, `ClaimableTaskCandidate`, etc. and `DiscoveryUnavailableError`) and add `InstanceClaimCount` to it. Then add `getInstanceClaimCounts,` to the returned object (the block at lines 1052-1062), e.g. after `getInstanceSuccessCounts,`:

```typescript
    getInstanceSuccessCounts,
    getInstanceClaimCounts,
  };
```

- [ ] **Step 7: Run the test to verify it passes**

Run: `cd client && yarn vitest run test/discovery/http.test.ts -t "getInstanceClaimCounts"`
Expected: PASS (4 tests).

- [ ] **Step 8: Commit**

```bash
git add client/src/discovery/http.ts client/test/discovery/http.test.ts
git commit -m "feat(802): implement HttpDiscoveryAPI.getInstanceClaimCounts"
```

---

## Task 3: Add the on-chain floor stub for `getInstanceClaimCounts`

**Files:**
- Modify: `client/src/discovery/onchain.ts` (add stub after `getInstanceSuccessCounts` ~line 1288; register on returned object ~line 1299; add type import)
- Test: `client/test/discovery/onchain.test.ts` (new test after the `getInstanceSuccessCounts` block ~line 1447)

- [ ] **Step 1: Write the failing test**

Add to `client/test/discovery/onchain.test.ts` (the file already imports `createOnchainDiscoveryAPI`):

```typescript
describe('OnchainDiscoveryAPI.getInstanceClaimCounts (#802)', () => {
  it('returns an empty Map as the floor stub (never the runtime path)', async () => {
    const api = createOnchainDiscoveryAPI({
      rpcUrl: 'http://127.0.0.1:65535',
      chainId: 84532,
    });
    const counts = await api.getInstanceClaimCounts({ manifestCid: 'bafyany' });
    expect(counts).toBeInstanceOf(Map);
    expect(counts.size).toBe(0);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd client && yarn vitest run test/discovery/onchain.test.ts -t "getInstanceClaimCounts"`
Expected: FAIL — `api.getInstanceClaimCounts is not a function`.

- [ ] **Step 3: Add the stub**

In `client/src/discovery/onchain.ts`, after the `getInstanceSuccessCounts` stub (closes at line 1288), add:

```typescript
  // ── getInstanceClaimCounts (#802) — empty Map stub ─────────────────────────
  // The claim data (task.maxClaims + attempt counts) IS reconstructible from
  // TaskCreated / TaskAttemptCreated logs, but the floor stays a no-op to keep
  // the abort-on-outage guarantee symmetric with getInstanceSuccessCounts:
  // withFallback never routes this method to the floor, so an empty Map here is
  // never the runtime path. Returning empty (rather than a live scan) avoids a
  // floor that would mark every posting `live` and suppress all reposts (#802).
  async function getInstanceClaimCounts(): Promise<Map<string, InstanceClaimCount>> {
    return new Map();
  }
```

- [ ] **Step 4: Add the type import and register the method**

In `client/src/discovery/onchain.ts`, add `InstanceClaimCount` to the existing discovery-types import (the file imports `DiscoveryAPI`, `PluginScoreHistoryRow`, etc. from `./types.js`). Then add `getInstanceClaimCounts,` to the returned object (the block at lines 1290-1300), after `getInstanceSuccessCounts,`.

- [ ] **Step 5: Run the test to verify it passes**

Run: `cd client && yarn vitest run test/discovery/onchain.test.ts -t "getInstanceClaimCounts"`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add client/src/discovery/onchain.ts client/test/discovery/onchain.test.ts
git commit -m "feat(802): add OnchainDiscoveryAPI.getInstanceClaimCounts floor stub"
```

---

## Task 4: Route `getInstanceClaimCounts` through withFallback (primary only)

**Files:**
- Modify: `client/src/discovery/with-fallback.ts` (add method after `getInstanceSuccessCounts` ~line 256)
- Test: `client/test/discovery/with-fallback.test.ts` (new test after the existing success-counts non-routing test ~line 399)

- [ ] **Step 1: Write the failing test**

Add to `client/test/discovery/with-fallback.test.ts` (imports `withFallback`, `DiscoveryUnavailableError`, `DiscoveryAPI`, `vi` already present; `makeWrapper` helper exists):

```typescript
it('does NOT fall through to floor for getInstanceClaimCounts — propagates DiscoveryUnavailableError so the launcher aborts (#802)', async () => {
  // An empty Map from the floor is indistinguishable from "every task has 0
  // consumed slots", which would mark every posting `live` and suppress all
  // reposts. The wrapper must propagate the error so the launcher tick aborts.
  const primary = {
    getInstanceClaimCounts: vi.fn(async () => {
      throw new DiscoveryUnavailableError('indexer down');
    }),
  } as unknown as DiscoveryAPI;
  const floor = {
    getInstanceClaimCounts: vi.fn(async () => new Map()),
  } as unknown as DiscoveryAPI;
  const api = makeWrapper(primary, floor);
  await expect(
    api.getInstanceClaimCounts({ manifestCid: 'bafy' }),
  ).rejects.toBeInstanceOf(DiscoveryUnavailableError);
  expect(floor.getInstanceClaimCounts).not.toHaveBeenCalled();
});
```

Place it inside the same `describe` block that contains the success-counts non-routing test (so `makeWrapper` is in scope).

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd client && yarn vitest run test/discovery/with-fallback.test.ts -t "getInstanceClaimCounts"`
Expected: FAIL — `api.getInstanceClaimCounts is not a function`.

- [ ] **Step 3: Implement the non-routing method**

In `client/src/discovery/with-fallback.ts`, inside the returned object, after the `getInstanceSuccessCounts(args) { ... }` method (closes at line 256), add:

```typescript
    getInstanceClaimCounts(args) {
      // Never fall through to the floor for this method — an empty Map from the
      // floor is indistinguishable from "every task has 0 consumed slots",
      // which would mark every posting `live` and suppress all reposts (#802,
      // mirroring the #669 contract on getInstanceSuccessCounts). Propagate the
      // error so the launcher aborts its tick rather than under-counting.
      return primary.getInstanceClaimCounts(args);
    },
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd client && yarn vitest run test/discovery/with-fallback.test.ts -t "getInstanceClaimCounts"`
Expected: PASS.

- [ ] **Step 5: Typecheck the source layer (interface now fully implemented)**

Run: `cd client && yarn typecheck`
Expected: EXIT 0 — all three source impls now satisfy `DiscoveryAPI`.

- [ ] **Step 6: Commit**

```bash
git add client/src/discovery/with-fallback.ts client/test/discovery/with-fallback.test.ts
git commit -m "feat(802): route getInstanceClaimCounts to primary only in withFallback"
```

---

## Task 5: Add `last_task_id` to the generator state ledger

**Files:**
- Modify: `client/src/solver-types/_swe-rebench-v2-state.ts`
- Test: `client/test/solver-types/swe-rebench-v2-state.test.ts`

The current `TaskCounters` is `{ posted, successful, last_posted_at }` defaulted in five places (lines 50, 55, 64, plus the auto module's inline defaults). Add an optional `last_task_id?: string` and a `recordLastTaskId` method. Keep `last_posted_at` (still the on-chain deadline source; AC#5 keeps `posting_window_ms`).

- [ ] **Step 1: Write the failing test**

Add to `client/test/solver-types/swe-rebench-v2-state.test.ts`:

```typescript
  it('defaults last_task_id to undefined', async () => {
    const store = new GeneratorStateStore({ stateDir: dir });
    expect((await store.getCounters('a')).last_task_id).toBeUndefined();
  });

  it('records and persists last_task_id without disturbing other counters', async () => {
    const store = new GeneratorStateStore({ stateDir: dir });
    await store.recordPosted('a');
    await store.recordLastTaskId('a', '12345');
    const c = await store.getCounters('a');
    expect(c.last_task_id).toBe('12345');
    expect(c.posted).toBe(1);

    const reloaded = new GeneratorStateStore({ stateDir: dir });
    expect((await reloaded.getCounters('a')).last_task_id).toBe('12345');
  });

  it('overwrites last_task_id on a fresh posting', async () => {
    const store = new GeneratorStateStore({ stateDir: dir });
    await store.recordLastTaskId('a', '100');
    await store.recordLastTaskId('a', '200');
    expect((await store.getCounters('a')).last_task_id).toBe('200');
  });
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd client && yarn vitest run test/solver-types/swe-rebench-v2-state.test.ts`
Expected: FAIL — `store.recordLastTaskId is not a function` / `last_task_id` undefined assertions on the missing field.

- [ ] **Step 3: Add the field and method**

In `client/src/solver-types/_swe-rebench-v2-state.ts`:

Change the interface (lines 12-16):

```typescript
export interface TaskCounters {
  posted: number;
  successful: number;
  last_posted_at: number; // ms epoch
  /** On-chain taskId of the most-recent posting for this instance (#802).
   *  Set by CreatorLoop after the post resolves; used by the generator to look
   *  up claim exhaustion via DiscoveryAPI.getInstanceClaimCounts. */
  last_task_id?: string;
}
```

Add the method after `recordSuccess` (after line 68):

```typescript
  async recordLastTaskId(instance_id: string, taskId: string): Promise<void> {
    const state = await this.load();
    const c = state.tasks[instance_id] ?? { posted: 0, successful: 0, last_posted_at: 0 };
    c.last_task_id = taskId;
    state.tasks[instance_id] = c;
    await this.save();
  }
```

The three existing default literals (`{ posted: 0, successful: 0, last_posted_at: 0 }` at lines 50, 55, 64) need no change — `last_task_id` is optional and defaults to `undefined`.

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd client && yarn vitest run test/solver-types/swe-rebench-v2-state.test.ts`
Expected: PASS (all, including the new 3).

- [ ] **Step 5: Commit**

```bash
git add client/src/solver-types/_swe-rebench-v2-state.ts client/test/solver-types/swe-rebench-v2-state.test.ts
git commit -m "feat(802): add last_task_id ledger to swe-rebench-v2 generator state"
```

---

## Task 6: Wire the `last_task_id` write into CreatorLoop after posting

**Files:**
- Modify: `client/src/daemon/creator.ts` (record after a successful swe-rebench-v2 post, ~line 80)
- Test: `client/test/daemon/creator.test.ts` (create if absent; otherwise extend)

This mirrors the delivery-watcher's `recordSuccess` hook (`delivery-watcher.ts:55-70`): gate on `solverType === 'swe-rebench-v2.v1'`, read `instance_id` from the posted task's spec, call `getSweRebenchV2StateStore().recordLastTaskId(instance_id, taskId)`. The on-chain taskId is `postResult.taskId`. Skip idempotent results (no new on-chain task).

- [ ] **Step 1: Check whether a creator test exists**

Run: `ls client/test/daemon/creator.test.ts 2>/dev/null && echo EXISTS || echo MISSING`

If MISSING, create the file in Step 2 with the full scaffold below. If EXISTS, add only the new `describe` block.

- [ ] **Step 2: Write the failing test**

Create/extend `client/test/daemon/creator.test.ts`. The test drives `CreatorLoop.tick()` with a stub adapter that returns a known on-chain taskId, a swe-rebench-v2 candidate carrying `spec.instance_id`, and an in-memory `Store`, then asserts the generator state ledger recorded `last_task_id`. Use the real `GeneratorStateStore` rooted at a temp `JINN_SWE_REBENCH_V2_STATE_DIR` (the hook resolves the store via `getSweRebenchV2StateStore()`, which honours that env var — see `swe-rebench-v2.ts:813-818`).

```typescript
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CreatorLoop } from '../../src/daemon/creator.js';
import { GeneratorStateStore } from '../../src/solver-types/_swe-rebench-v2-state.js';
import type { ExecutionAdapter } from '../../src/adapters/adapter.js';
import type { Store } from '../../src/store/store.js';
import type { TaskSource, TaskCandidate } from '../../src/tasks/sources.js';
import type { Task } from '../../src/types/task.js';

function sweCandidate(instanceId: string): TaskCandidate {
  const task = {
    id: `uuid-${instanceId}`,
    description: `SWE-rebench v2: ${instanceId}`,
    solverType: 'swe-rebench-v2.v1',
    role: 'restoration',
    window: { startTs: 0, endTs: 1 },
    spec: { instance_id: instanceId },
  } as unknown as Task;
  return {
    sourceKey: 'swe-rebench-v2',
    task,
    postingPolicy: { kind: 'once_per_safe' },
  } as unknown as TaskCandidate;
}

function source(candidates: TaskCandidate[]): TaskSource {
  return {
    sourceKey: 'swe-rebench-v2',
    collect: async () => candidates,
  } as unknown as TaskSource;
}

// Minimal in-memory Store: only the methods CreatorLoop / TaskPostingService touch.
function memStore(): Store {
  const config = new Map<string, string>();
  const posts = new Map<string, unknown>();
  return {
    getConfigValue: (k: string) => config.get(k),
    setConfigValue: (k: string, v: string) => { config.set(k, v); },
    getTaskPostRecord: () => undefined,
    acquireTaskPostLock: () => true,
    releaseTaskPostLock: () => {},
    upsertTaskPostRecord: (r: { sourceKey: string }) => { posts.set(r.sourceKey, r); },
    recordOwnActivity: () => {},
  } as unknown as Store;
}

describe('CreatorLoop — swe-rebench-v2 last_task_id ledger (#802)', () => {
  let stateDir: string;
  beforeEach(() => {
    stateDir = mkdtempSync(join(tmpdir(), 'jinn-creator-802-'));
    process.env['JINN_SWE_REBENCH_V2_STATE_DIR'] = stateDir;
  });
  afterEach(() => {
    delete process.env['JINN_SWE_REBENCH_V2_STATE_DIR'];
    rmSync(stateDir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it('records the on-chain taskId for the posted instance', async () => {
    const adapter = {
      postTask: vi.fn(async () => ({ taskId: '424242', taskCid: 'bafytaskcid' })),
    } as unknown as ExecutionAdapter;
    const loop = new CreatorLoop(adapter, [source([sweCandidate('org__repo-1')])], memStore());

    await loop.tick();

    const store = new GeneratorStateStore({ stateDir });
    expect((await store.getCounters('org__repo-1')).last_task_id).toBe('424242');
  });

  it('does not record last_task_id for non-swe-rebench-v2 candidates', async () => {
    const other = { ...sweCandidate('x'), task: { ...sweCandidate('x').task, solverType: 'prediction.v1' } } as TaskCandidate;
    const adapter = {
      postTask: vi.fn(async () => ({ taskId: '999', taskCid: 'bafy' })),
    } as unknown as ExecutionAdapter;
    const loop = new CreatorLoop(adapter, [source([other])], memStore());

    await loop.tick();

    const store = new GeneratorStateStore({ stateDir });
    expect((await store.getCounters('x')).last_task_id).toBeUndefined();
  });
});
```

NOTE: if the real `TaskPostingService.postCandidate` requires more `Store` methods than the stub provides, extend `memStore()` with no-op shims until the test runs — match the method names referenced in `client/src/tasks/posting-service.ts` (`getTaskPostRecord`, `acquireTaskPostLock`, `releaseTaskPostLock`, `upsertTaskPostRecord`, `recordOwnActivity`) and in `client/src/observability/emit-event.ts` (`emitEvent` writes via the store — add a no-op for whatever it calls). Run the test and add shims iteratively until only the assertion fails.

- [ ] **Step 3: Run the test to verify it fails**

Run: `cd client && yarn vitest run test/daemon/creator.test.ts -t "last_task_id"`
Expected: FAIL — `last_task_id` is `undefined` (the hook does not exist yet).

- [ ] **Step 4: Add the hook to CreatorLoop**

In `client/src/daemon/creator.ts`, add an import at the top (after line 8):

```typescript
import { getSweRebenchV2StateStore } from '../solver-types/swe-rebench-v2.js';
```

Then, inside `tick()`, right after `postedTaskIds.push(taskId);` (line 80) and still inside the `try` block, add:

```typescript
        // #802: record the on-chain taskId for swe-rebench-v2 postings so the
        // generator can detect claim-budget exhaustion via the indexer
        // (getInstanceClaimCounts). Mirrors the delivery-watcher recordSuccess
        // hook. Only on a fresh post (idempotent results carry no new task).
        if (state.solverType === 'swe-rebench-v2.v1') {
          const instanceId = state.spec?.['instance_id'];
          if (typeof instanceId === 'string' && instanceId.length > 0) {
            getSweRebenchV2StateStore().recordLastTaskId(instanceId, taskId).catch((err) => {
              console.warn(
                `[creator] swe-rebench-v2 recordLastTaskId failed for ${instanceId}: ${err instanceof Error ? err.message : err}`,
              );
            });
          }
        }
```

(The `if (postResult.idempotent) continue;` at line 71 already short-circuits idempotent results before this code runs, so the "fresh post only" requirement is satisfied for free.)

- [ ] **Step 5: Run the test to verify it passes**

Run: `cd client && yarn vitest run test/daemon/creator.test.ts -t "last_task_id"`
Expected: PASS (2 tests).

- [ ] **Step 6: Guard against an import cycle**

`creator.ts` now imports from `swe-rebench-v2.ts`. `delivery-watcher.ts` already imports `getSweRebenchV2StateStore` from the same module with no cycle, so this is safe — but confirm by typechecking.

Run: `cd client && yarn typecheck`
Expected: EXIT 0.

- [ ] **Step 7: Commit**

```bash
git add client/src/daemon/creator.ts client/test/daemon/creator.test.ts
git commit -m "feat(802): record swe-rebench-v2 on-chain taskId in CreatorLoop"
```

---

## Task 7: Rewrite classification to the claim-budget model

**Files:**
- Modify: `client/src/solver-types/swe-rebench-v2-auto.ts`
- Test: `client/test/solver-types/swe-rebench-v2-auto.test.ts` (rewrite the `selectNextPostingCandidate` describe block)

The classifier currently keys `live` vs `repostable` on `now - last_posted_at >= posting_window_ms` and has an `abandoned` branch + an in-batch cap. We replace the time logic with a per-instance consumed/maxClaims snapshot supplied by the caller, drop `abandoned`, and drop the in-batch cap. `N_max_postings_per_task` defaults to `Infinity` and is no longer consulted for eligibility (it stays in the type as an opt-in ceiling for callers who set it, but is not used to abandon).

Design decision (state explicitly): `classifyPoolTask` gains a fourth argument — a per-instance claim snapshot `{ consumed, maxClaims } | undefined`. `undefined` means "no live posting observed on-chain for this instance" (either never posted, or posted-but-not-yet-indexed), which classifies as `unposted` when `posted === 0` and `repostable` otherwise (a posting we made that the indexer can't see yet is treated as needing a (re)post — but see Task 7 Step 7's note: the generator only calls classification after a successful indexer read, and an instance with a `last_task_id` not present in the claim map means that task was finalized/refunded out of the `task` set, i.e. effectively exhausted → `repostable`).

- [ ] **Step 1: Rewrite the classification tests**

Replace the entire `describe('selectNextPostingCandidate', ...)` block (lines 23-140) in `client/test/solver-types/swe-rebench-v2-auto.test.ts` with claim-budget tests. The selector now needs the claim snapshot; pass it via a new `SelectArgs.claimCounts: Map<string, { consumed: number; maxClaims: number }>` field (added in Step 3). Keep the top-of-file `config` constant but treat `posting_window_ms` as irrelevant to classification.

```typescript
describe('classifyPoolTask (claim-budget model, #802)', () => {
  const pool = [
    { instance_id: 'a', language: 'python' },
    { instance_id: 'b', language: 'go' },
    { instance_id: 'c', language: 'python' },
  ];

  it('classifies successful >= N as saturated (unchanged)', () => {
    const counters = new Map([
      ['a', { posted: 5, successful: 5, last_posted_at: 0 }],
      ['b', { posted: 0, successful: 0, last_posted_at: 0 }],
    ]);
    const next = selectNextPostingCandidate({ pool, counters, config, now: 1000 });
    expect(next?.instance_id).toBe('b');
  });

  it('keeps a posting with slots remaining as live (does NOT repost)', () => {
    const counters = new Map([
      ['a', { posted: 1, successful: 0, last_posted_at: 1, last_task_id: '10' }],
      ['b', { posted: 0, successful: 0, last_posted_at: 0 }],
    ]);
    const claimCounts = new Map([['10', { consumed: 2, maxClaims: 5 }]]);
    const next = selectNextPostingCandidate({ pool, counters, claimCounts, config, now: 1000 });
    // a is live (2 < 5), so b (unposted) is chosen.
    expect(next?.instance_id).toBe('b');
    expect(summarizePoolState({ pool, counters, claimCounts, config, now: 1000 }))
      .toMatchObject({ live: 1, unposted: 2, repostable: 0, saturated: 0 });
  });

  it('classifies an exhausted posting with successes < N as repostable', () => {
    const counters = new Map([
      ['a', { posted: 1, successful: 1, last_posted_at: 1, last_task_id: '10' }],
    ]);
    const claimCounts = new Map([['10', { consumed: 5, maxClaims: 5 }]]);
    const batch = selectNextPostingCandidates({ pool, counters, claimCounts, config, now: 1000 });
    expect(batch.map((t) => t.instance_id)).toContain('a');
    expect(summarizePoolState({ pool, counters, claimCounts, config, now: 1000 }))
      .toMatchObject({ repostable: 1 });
  });

  it('treats a posted instance with no claim snapshot as repostable (its task left the live set)', () => {
    const counters = new Map([
      ['a', { posted: 3, successful: 0, last_posted_at: 1, last_task_id: '99' }],
    ]);
    const claimCounts = new Map(); // '99' not present → finalized/refunded out
    const batch = selectNextPostingCandidates({ pool, counters, claimCounts, config, now: 1000 });
    expect(batch.map((t) => t.instance_id)).toContain('a');
  });

  it('retries a hard instance indefinitely — no abandon cap', () => {
    const counters = new Map([
      ['a', { posted: 9999, successful: 0, last_posted_at: 1, last_task_id: '10' }],
    ]);
    const claimCounts = new Map([['10', { consumed: 5, maxClaims: 5 }]]);
    // Even with the default N_max_postings_per_task, an exhausted hard instance reposts.
    const batch = selectNextPostingCandidates({ pool, counters, claimCounts, config, now: 1000 });
    expect(batch.map((t) => t.instance_id)).toContain('a');
  });

  it('classifies an unposted instance as unposted', () => {
    const counters = new Map([['a', { posted: 0, successful: 0, last_posted_at: 0 }]]);
    const claimCounts = new Map();
    expect(summarizePoolState({ pool: [{ instance_id: 'a', language: 'python' }], counters, claimCounts, config, now: 1 }))
      .toMatchObject({ unposted: 1, live: 0, repostable: 0, saturated: 0 });
  });

  it('round-robins language among eligible candidates', () => {
    const counters = new Map();
    const next = selectNextPostingCandidate({
      pool, counters, claimCounts: new Map(), config, now: 1, lastPostedLanguage: 'python',
    });
    expect(next?.language).toBe('go');
  });

  it('returns empty when all instances are live or saturated', () => {
    const counters = new Map([
      ['a', { posted: 1, successful: 5, last_posted_at: 1, last_task_id: '10' }], // saturated
      ['b', { posted: 1, successful: 0, last_posted_at: 1, last_task_id: '11' }], // live
      ['c', { posted: 1, successful: 5, last_posted_at: 1, last_task_id: '12' }], // saturated
    ]);
    const claimCounts = new Map([
      ['10', { consumed: 5, maxClaims: 5 }],
      ['11', { consumed: 0, maxClaims: 5 }],
      ['12', { consumed: 5, maxClaims: 5 }],
    ]);
    expect(selectNextPostingCandidate({ pool, counters, claimCounts, config, now: 1 })).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run the rewritten tests to verify they fail**

Run: `cd client && yarn vitest run test/solver-types/swe-rebench-v2-auto.test.ts -t "claim-budget"`
Expected: FAIL — `claimCounts` is not a recognised arg / classification still time-based.

- [ ] **Step 3: Update the types and `DEFAULT_GENERATOR_CONFIG`**

In `client/src/solver-types/swe-rebench-v2-auto.ts`:

Change `DEFAULT_GENERATOR_CONFIG` (lines 27-33) — default the abandon cap to unbounded:

```typescript
export const DEFAULT_GENERATOR_CONFIG: GeneratorConfig = {
  N_target_successes: 5,
  // #802: abandon cap is opt-in; default unbounded so hard instances retry
  // indefinitely. A launcher may still set a finite ceiling in the manifest.
  N_max_postings_per_task: Infinity,
  posting_window_ms: 24 * 60 * 60 * 1000, // on-chain claim-window deadline only (AC#5)
  post_batch_size: 25,
  claimLeaseTtlSeconds: 60 * 60,
};
```

Add a claim-snapshot type and remove `'abandoned'` from the kind union (lines 35-50):

```typescript
/** Per-instance on-chain claim-budget snapshot, keyed by instance_id, derived
 *  by the generator from DiscoveryAPI.getInstanceClaimCounts joined on the
 *  instance's last_task_id (#802). */
export interface InstanceClaimSnapshot {
  consumed: number;
  maxClaims: number;
}

export type SweRebenchV2PoolCountKind =
  | 'unposted'
  | 'live'
  | 'repostable'
  | 'saturated';

export interface SweRebenchV2PoolCounts {
  poolSize: number;
  posted: number;
  unposted: number;
  live: number;
  repostable: number;
  saturated: number;
}
```

Add `claimCounts` to `SelectArgs` (lines 52-60):

```typescript
export interface SelectArgs {
  pool: PoolTask[];
  counters: Map<string, TaskCounters>;
  config: GeneratorConfig;
  now: number;
  /** Per-instance claim-budget snapshot (#802). Absent entry ⇒ no live posting
   *  observed on-chain for that instance. */
  claimCounts?: Map<string, InstanceClaimSnapshot>;
  lastPostedLanguage?: string;
}
```

- [ ] **Step 4: Rewrite `classifyPoolTask`**

Replace lines 62-71:

```typescript
export function classifyPoolTask(
  counters: TaskCounters,
  config: GeneratorConfig,
  claim: InstanceClaimSnapshot | undefined,
): SweRebenchV2PoolCountKind {
  // saturated is the first branch and is unchanged (AC#2).
  if (counters.successful >= config.N_target_successes) return 'saturated';
  // Never posted ⇒ unposted.
  if (counters.posted === 0 || !counters.last_task_id) return 'unposted';
  // Posted, but the indexer shows no live posting for its last_task_id (the
  // task left the claimable set — finalized/refunded/exhausted). Repost.
  if (!claim) return 'repostable';
  // Live while the on-chain claim budget has slots left; exhausted ⇒ repostable.
  return claim.consumed >= claim.maxClaims ? 'repostable' : 'live';
}
```

NOTE: `now` is dropped from `classifyPoolTask`'s signature (classification is no longer time-based). Update `summarizePoolState` and both selectors accordingly.

- [ ] **Step 5: Rewrite `summarizePoolState`**

Replace lines 73-90:

```typescript
export function summarizePoolState(args: SelectArgs): SweRebenchV2PoolCounts {
  const counts: SweRebenchV2PoolCounts = {
    poolSize: args.pool.length,
    posted: 0,
    unposted: 0,
    live: 0,
    repostable: 0,
    saturated: 0,
  };
  for (const task of args.pool) {
    const counters =
      args.counters.get(task.instance_id) ??
      { posted: 0, successful: 0, last_posted_at: 0 };
    const claim = counters.last_task_id
      ? args.claimCounts?.get(counters.last_task_id)
      : undefined;
    counts[classifyPoolTask(counters, args.config, claim)] += 1;
  }
  return counts;
}
```

NOTE: `claimCounts` is keyed by `last_task_id` (taskId), not instance_id — the generator builds it that way in Task 8 by joining `getInstanceClaimCounts` (keyed by taskId) directly. Confirm the selector lookups below use `counters.last_task_id` as the key. (The auto-module test in Step 1 passes `claimCounts` keyed by taskId, e.g. `'10'`, matching `last_task_id: '10'`.)

- [ ] **Step 6: Rewrite `selectNextPostingCandidates`**

Replace lines 104-138 — drop the in-batch cap loop and the `now`-based classification; eligibility is `unposted || repostable`:

```typescript
/**
 * Choose up to post_batch_size eligible tasks to post on JinnRouter.
 *
 * Eligibility (#802):
 *   - successful_count[task] < N_target_successes (else saturated)
 *   - the instance has no live on-chain posting: either unposted, or its
 *     last posting's claim budget is exhausted (consumed >= maxClaims) or has
 *     left the claimable set.
 *
 * Among eligible tasks, prefer a different language than the last-posted one.
 * Tie-break by lower posted_count, then earliest last_posted_at, then
 * instance_id (deterministic).
 */
export function selectNextPostingCandidates(args: SelectArgs): PoolTask[] {
  const claimFor = (instanceId: string): InstanceClaimSnapshot | undefined => {
    const tid = args.counters.get(instanceId)?.last_task_id;
    return tid ? args.claimCounts?.get(tid) : undefined;
  };
  const eligible = args.pool.filter((task) => {
    const c =
      args.counters.get(task.instance_id) ??
      { posted: 0, successful: 0, last_posted_at: 0 };
    const kind = classifyPoolTask(c, args.config, claimFor(task.instance_id));
    return kind === 'unposted' || kind === 'repostable';
  });
  if (eligible.length === 0) return [];

  const differentLanguage = args.lastPostedLanguage
    ? eligible.filter((t) => t.language !== args.lastPostedLanguage)
    : eligible;
  const candidates = differentLanguage.length > 0 ? differentLanguage : eligible;

  candidates.sort((a, b) => {
    const cA = args.counters.get(a.instance_id) ?? { posted: 0, successful: 0, last_posted_at: 0 };
    const cB = args.counters.get(b.instance_id) ?? { posted: 0, successful: 0, last_posted_at: 0 };
    if (cA.posted !== cB.posted) return cA.posted - cB.posted;
    if (cA.last_posted_at !== cB.last_posted_at) return cA.last_posted_at - cB.last_posted_at;
    return a.instance_id.localeCompare(b.instance_id);
  });

  // De-dupe instance_ids within the batch (a pool may list an instance twice);
  // each instance gets at most one posting per tick. No abandon cap (#802).
  const seenInstance = new Set<string>();
  const selected: PoolTask[] = [];
  for (const candidate of candidates) {
    if (selected.length >= args.config.post_batch_size) break;
    if (seenInstance.has(candidate.instance_id)) continue;
    seenInstance.add(candidate.instance_id);
    selected.push(candidate);
  }
  return selected;
}
```

`selectNextPostingCandidate` (singular, line 140-142) is unchanged — it forwards to the batch selector with `post_batch_size: 1`.

- [ ] **Step 7: Run the rewritten auto tests to verify they pass**

Run: `cd client && yarn vitest run test/solver-types/swe-rebench-v2-auto.test.ts -t "claim-budget"`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add client/src/solver-types/swe-rebench-v2-auto.ts client/test/solver-types/swe-rebench-v2-auto.test.ts
git commit -m "feat(802): classify swe-rebench-v2 postings by claim budget, drop abandon cap"
```

---

## Task 8: Wire exhaustion detection into the generator tick

**Files:**
- Modify: `client/src/solver-types/swe-rebench-v2.ts`
- Test: `client/test/solver-types/swe-rebench-v2-auto.test.ts` (generator-level describe; reuse the single-instance pool-cache pattern at lines 194-297)

The tick currently (a) loads counters, (b) reconciles successes via `getInstanceSuccessCounts` with an abort-on-outage block (lines 590-621), then (c) calls `selectNextPostingCandidates`/`summarizePoolState` with `now`. We add a parallel claim-counts reconciliation that builds a `claimCounts` Map (keyed by taskId), aborts the tick identically on outage, and passes `claimCounts` into selection/summary. `summarizePoolState`'s snapshot loses `abandoned`.

- [ ] **Step 1: Write the failing generator tests**

Add to `client/test/solver-types/swe-rebench-v2-auto.test.ts` a new describe block (model it on the existing `#669` test at lines 194-297 — single-instance pool-cache + python-floor + stub DiscoveryAPI). Cover: (a) exhausted instance reposts on next tick; (b) live instance does not repost; (c) indexer outage on `getInstanceClaimCounts` aborts the tick.

```typescript
describe('makeSweRebenchV2GeneratorForLaunchedRecord — claim-exhaustion repost (#802)', () => {
  async function seed(stateDir: string, counters: Record<string, unknown>) {
    await mkdir(stateDir, { recursive: true });
    await writeFile(
      join(stateDir, 'generator-state.json'),
      JSON.stringify({ schemaVersion: 'swe-rebench-v2-generator-state.v1', tasks: counters }),
    );
    await writeFile(
      join(stateDir, 'pool-cache.json'),
      JSON.stringify({
        schemaVersion: 'swe-rebench-v2-pool-cache.v1',
        savedAt: new Date().toISOString(),
        tasks: [{
          instance_id: 'org__repo-1', language: 'python',
          hf_dataset: 'nebius/SWE-rebench-leaderboard', hf_split: '2024_12',
          base_commit: '0000000000000000000000000000000000000000',
        }],
      }),
    );
  }

  function stubDiscovery(over: Partial<DiscoveryAPI>): DiscoveryAPI {
    const notUsed = vi.fn(async () => { throw new Error('not used'); });
    return {
      getInstanceSuccessCounts: vi.fn(async () => new Map<string, number>()),
      getInstanceClaimCounts: vi.fn(async () => new Map()),
      findClaimableTasks: notUsed, listLaunchedSolverNets: notUsed,
      getLifecycleStatus: notUsed, getSolverNetOperatorCount: notUsed,
      queryEnvelopes: notUsed, listPluginPublications: notUsed,
      getPluginScores: notUsed, listBuilderArtifacts: notUsed,
      ...over,
    } as DiscoveryAPI;
  }

  function gen(stateDir: string, discoveryApi: DiscoveryAPI) {
    return makeSweRebenchV2GeneratorForLaunchedRecord({
      recordRef: { current: launchedRecord({ status: 'launched', manifestCid: 'bafy802' }) },
      configRef: { current: { N_target_successes: 5, posting_window_ms: 300_000, admissionMode: 'python-floor' as const } },
      staticConfig: { stateDir, discoveryApi },
    });
  }

  let fetchSpy: ReturnType<typeof vi.spyOn>;
  beforeEach? // (use a plain const + try/finally if beforeEach is not already imported in this file)

  it('reposts an exhausted instance whose successes < N', async () => {
    const stateDir = await mkdtemp(join(tmpdir(), 'jinn-802-'));
    await seed(stateDir, { 'org__repo-1': { posted: 1, successful: 1, last_posted_at: 0, last_task_id: '10' } });
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('HF unreachable in test sandbox'));
    const discovery = stubDiscovery({
      getInstanceClaimCounts: vi.fn(async () => new Map([['10', { taskId: '10', consumed: 5, maxClaims: 5 }]])),
    });
    const g = gen(stateDir, discovery);

    const result = await g();

    expect(result).not.toBeNull();
    expect((result as Task[])[0].spec).toMatchObject({ instance_id: 'org__repo-1' });
    expect(g.getState().lastPollSummary).toMatchObject({ repostable: 0, posted: 1 });
    fetchSpy.mockRestore();
  });

  it('does NOT repost an instance with claim slots remaining (live)', async () => {
    const stateDir = await mkdtemp(join(tmpdir(), 'jinn-802-'));
    await seed(stateDir, { 'org__repo-1': { posted: 1, successful: 0, last_posted_at: 0, last_task_id: '11' } });
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('HF unreachable in test sandbox'));
    const discovery = stubDiscovery({
      getInstanceClaimCounts: vi.fn(async () => new Map([['11', { taskId: '11', consumed: 2, maxClaims: 5 }]])),
    });
    const g = gen(stateDir, discovery);

    const result = await g();

    expect(result).toBeNull();
    expect(g.getState().lastPollSummary).toMatchObject({ live: 1, posted: 0 });
    fetchSpy.mockRestore();
  });

  it('aborts the tick when getInstanceClaimCounts throws (never under-counts)', async () => {
    const { DiscoveryUnavailableError } = await import('../../src/discovery/types.js');
    const stateDir = await mkdtemp(join(tmpdir(), 'jinn-802-'));
    await seed(stateDir, { 'org__repo-1': { posted: 1, successful: 1, last_posted_at: 0, last_task_id: '10' } });
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('HF unreachable in test sandbox'));
    const discovery = stubDiscovery({
      getInstanceClaimCounts: vi.fn(async () => { throw new DiscoveryUnavailableError('indexer down'); }),
    });
    const g = gen(stateDir, discovery);

    const result = await g();

    expect(result).toBeNull(); // aborted, nothing posted
    expect(g.getState().lastError?.message).toContain('claim-budget reconciliation failed');
    expect(g.getState().lastPollSummary).toMatchObject({ posted: 0 });
    fetchSpy.mockRestore();
  });
});
```

(Ensure `mkdtemp` is imported at the top of the test file — it currently imports `mkdtemp, writeFile, mkdir`. `Task` and `DiscoveryAPI` types are already imported.)

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd client && yarn vitest run test/solver-types/swe-rebench-v2-auto.test.ts -t "claim-exhaustion"`
Expected: FAIL — the generator does not yet call `getInstanceClaimCounts`; live/repostable counts wrong; no `claim-budget reconciliation failed` error.

- [ ] **Step 3: Add the claim-counts reconciliation block to the tick**

In `client/src/solver-types/swe-rebench-v2.ts`, immediately after the `getInstanceSuccessCounts` reconciliation block (the `try/catch` ending at line 621) and before `const candidates = selectNextPostingCandidates(...)` (line 623), add. This builds `claimCounts` keyed by taskId and aborts identically on outage. The summary object loses `abandoned` (see Step 4).

```typescript
    // Reconcile claim-budget exhaustion against network truth (#802): a posting
    // is exhausted when its on-chain consumed slots reach maxClaims. Keyed by
    // taskId; the classifier joins via each instance's last_task_id. On indexer
    // outage the tick aborts — falling through to "no exhaustion observed" would
    // mark every posting live and suppress all reposts (the under-count bug).
    let claimCounts: Map<string, { consumed: number; maxClaims: number }> | undefined;
    if (config.discoveryApi && config.solverNetManifestCid) {
      try {
        const network = await config.discoveryApi.getInstanceClaimCounts({
          manifestCid: config.solverNetManifestCid,
        });
        claimCounts = new Map();
        for (const [taskId, snap] of network) {
          claimCounts.set(taskId, { consumed: snap.consumed, maxClaims: snap.maxClaims });
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        lastError = {
          message: `claim-budget reconciliation failed: ${message}`,
          at: new Date().toISOString(),
        };
        console.warn(`[swe-rebench-v2-gen] ${lastError.message} — skipping this tick`);
        lastPollSummary = {
          poolSize: eligiblePool.length,
          posted: 0,
          unposted: 0,
          live: 0,
          repostable: 0,
          saturated: 0,
        };
        return null;
      }
    }
```

- [ ] **Step 4: Pass `claimCounts` into selection/summary and drop `abandoned` from all summary literals**

In `client/src/solver-types/swe-rebench-v2.ts`:

- Pass `claimCounts` to `selectNextPostingCandidates` (line 623-629) and to the two `summarizePoolState` calls (lines 631-637 and 705-711): add `claimCounts,` to each args object. Remove the `now` arg from `summarizePoolState` calls only if you also removed it from the signature in Task 7 — **the signature still accepts `now` via `SelectArgs`, so leaving `now` in the args object is harmless; keep it to minimise diff.** (`SelectArgs.now` remains a field; classification just ignores it.)
- Remove `abandoned: 0,` from every `lastPollSummary = { ... }` literal in this file (lines 466-473, 515-523, 567-575, 610-618, plus the new block in Step 3 already omits it). Search the file for `abandoned:` and delete each line.
- Update the `SweRebenchV2GeneratorStateSnapshot['lastPollSummary']` type (lines 104-113) and the `getState`/`lastPollSummary` shapes: remove the `abandoned: number;` field.

- [ ] **Step 5: Verify there are no remaining `abandoned` references**

Run: `cd client && grep -rn "abandoned" src/solver-types/swe-rebench-v2.ts src/solver-types/swe-rebench-v2-auto.ts`
Expected: no output (all removed).

- [ ] **Step 6: Run the generator tests**

Run: `cd client && yarn vitest run test/solver-types/swe-rebench-v2-auto.test.ts -t "claim-exhaustion"`
Expected: PASS (3 tests).

- [ ] **Step 7: Typecheck**

Run: `cd client && yarn typecheck`
Expected: EXIT 0.

- [ ] **Step 8: Commit**

```bash
git add client/src/solver-types/swe-rebench-v2.ts client/test/solver-types/swe-rebench-v2-auto.test.ts
git commit -m "feat(802): wire claim-exhaustion reconciliation into generator tick"
```

---

## Task 9: Remove `abandoned` from the launcher-status surface chain

**Files:**
- Modify: `client/src/api/launcher-status.ts` (the `LauncherGeneratorPollSummary` pool-summary union member, ~line 40-48)
- Modify: `client/src/solvernets/launched-record-dispatcher.ts` (the pool-summary projection, ~line 182-208)
- Modify: `client/src/dashboard/spa/src/api/types.ts` (the pool-summary union member, ~line 205-213)
- Modify: `client/src/dashboard/spa/src/pages/launcher-launched/GeneratorPanel.tsx` (the rendered `MetaItem`, the inline type, and the `isPoolSummary` guard — lines 667, 672-692)
- Test: `client/test/main/launched-record-dispatcher.test.ts` (lines 58, 132)
- Test: `client/src/dashboard/spa/src/pages/launcher-launched/GeneratorPanel.test.tsx` (lines 291, 301)

**Why this is in scope.** Removing `abandoned` from the generator's `lastPollSummary` (Task 8 Step 4) propagates through a typed chain: generator snapshot → `launched-record-dispatcher.ts` (which *requires* `abandoned !== undefined` at line 197 to project the pool summary — without it the projection silently falls back to the legacy `evaluated/skipped` shape) → `api/launcher-status.ts` type → SPA `api/types.ts` type → SPA `GeneratorPanel.tsx` (whose `isPoolSummary` guard at line 691 requires `abandoned` to be a number, so a missing field makes the whole pool-summary panel vanish). Leaving these would break an existing operator surface — squarely the "strictly required to not break existing surfaces" carve-out in the NON-goals. This is a `tsc -b`-typechecked surface (the SPA build runs `tsc -b`), so it cannot be skipped.

- [ ] **Step 1: Update the dispatcher test (failing first)**

In `client/test/main/launched-record-dispatcher.test.ts`, remove the `abandoned: 5,` line from both pool-summary fixtures (lines 58 and 132). If a nearby assertion checks `lastPollSummary` deep-equals an object containing `abandoned`, remove `abandoned` from the expected object too. Run the test to confirm it now reflects the new shape.

Run: `cd client && yarn vitest run test/main/launched-record-dispatcher.test.ts`
Expected: FAIL — the production projection still requires/emits `abandoned`, so the dispatcher returns it and the (now `abandoned`-free) expectation mismatches (or the projection drops to the legacy shape). This is the failing-test signal.

- [ ] **Step 2: Update the dispatcher projection**

In `client/src/solvernets/launched-record-dispatcher.ts`, in the pool-summary projection block (lines 183-207): delete the `const abandoned = finiteNumber(rawSummary['abandoned']);` line (188), delete `abandoned !== undefined &&` from the guard (line 197), and delete `abandoned,` from the projected object (line 206). The block becomes:

```typescript
    const poolSize = finiteNumber(rawSummary['poolSize']);
    const unposted = finiteNumber(rawSummary['unposted']);
    const live = finiteNumber(rawSummary['live']);
    const repostable = finiteNumber(rawSummary['repostable']);
    const saturated = finiteNumber(rawSummary['saturated']);
    const posted = finiteNumber(rawSummary['posted']);
    if (
      poolSize !== undefined &&
      posted !== undefined &&
      unposted !== undefined &&
      live !== undefined &&
      repostable !== undefined &&
      saturated !== undefined
    ) {
      projected.lastPollSummary = {
        poolSize,
        posted,
        unposted,
        live,
        repostable,
        saturated,
      };
    } else {
```

(The `else` legacy `evaluated/skipped` branch at lines 208-212 is unchanged.)

- [ ] **Step 3: Update the daemon `launcher-status.ts` type**

In `client/src/api/launcher-status.ts`, in the `LauncherGeneratorPollSummary` pool-summary union member (lines 40-48), delete the `abandoned: number;` line (47):

```typescript
  | {
    poolSize: number;
    posted: number;
    unposted: number;
    live: number;
    repostable: number;
    saturated: number;
  };
```

- [ ] **Step 4: Update the SPA `api/types.ts` type**

In `client/src/dashboard/spa/src/api/types.ts`, in the pool-summary union member (lines 205-213), delete the `abandoned: number;` line (212):

```typescript
    | {
      poolSize: number;
      posted: number;
      unposted: number;
      live: number;
      repostable: number;
      saturated: number;
    };
```

- [ ] **Step 5: Update the SPA `GeneratorPanel.tsx`**

In `client/src/dashboard/spa/src/pages/launcher-launched/GeneratorPanel.tsx`:

- Delete the Abandoned `MetaItem` (line 667):
  ```tsx
        <MetaItem label="Abandoned" value={String(summary.abandoned)} testid="launcher-launched-generator-abandoned" />
  ```
- In the `isPoolSummary` inline return type (lines 672-680), delete `abandoned: number;`.
- In the `isPoolSummary` key list (lines 683-691), delete the `'abandoned',` entry.

- [ ] **Step 6: Update the SPA `GeneratorPanel.test.tsx`**

In `client/src/dashboard/spa/src/pages/launcher-launched/GeneratorPanel.test.tsx`: delete the `abandoned: 6,` fixture line (291) and delete the assertion that reads `launcher-launched-generator-abandoned` (line 301). If other assertions in the same test count rendered `MetaItem`s, decrement the expected count by one.

- [ ] **Step 7: Verify there are no remaining generator-summary `abandoned` references**

Run: `cd client && grep -rn "abandoned" src/api/launcher-status.ts src/solvernets/launched-record-dispatcher.ts src/dashboard/spa/src/api/types.ts src/dashboard/spa/src/pages/launcher-launched/GeneratorPanel.tsx`
Expected: no output.

- [ ] **Step 8: Typecheck the daemon and the SPA**

Run: `cd client && yarn typecheck && yarn workspace @jinn-network/operator-spa exec tsc -b`
Expected: both EXIT 0. (If the SPA `tsc -b` is more conveniently run via `yarn build:spa`, that also typechecks; prefer the standalone `tsc -b` to skip the vite bundle.)

- [ ] **Step 9: Run the affected tests**

Run: `cd client && yarn vitest run test/main/launched-record-dispatcher.test.ts src/dashboard/spa/src/pages/launcher-launched/GeneratorPanel.test.tsx`
Expected: PASS.

- [ ] **Step 10: Commit**

```bash
git add client/src/api/launcher-status.ts client/src/solvernets/launched-record-dispatcher.ts client/src/dashboard/spa/src/api/types.ts client/src/dashboard/spa/src/pages/launcher-launched/GeneratorPanel.tsx client/test/main/launched-record-dispatcher.test.ts client/src/dashboard/spa/src/pages/launcher-launched/GeneratorPanel.test.tsx
git commit -m "feat(802): drop abandoned from launcher-status pool summary surface"
```

---

## Task 10: Update the cooldown/window test file to the new model

**Files:**
- Modify: `client/test/solver-types/swe-rebench-v2-generator-cooldown.test.ts`

This file's `posting windows` describe block (lines 122-236) asserts time-window behaviour (`abandoned: 2`, "posting windows") that no longer exists. Update the assertions to the claim-budget model. These generators construct with `staticConfig: { stateDir }` and **no `discoveryApi`** — so the claim-reconciliation block (Task 8 Step 3) is skipped (`config.discoveryApi` is falsy) and `claimCounts` is `undefined`. Under `claimCounts === undefined`: any posted instance with a `last_task_id` and no snapshot classifies `repostable` (its task "left the live set"); but these tests post fresh instances that have NO `last_task_id` until Task 6's hook runs — and the hook is in CreatorLoop, not the generator tick, so within this generator-only test the posted instances keep `last_task_id: undefined`. A posted instance with `posted > 0` and `last_task_id` undefined classifies `unposted` per `classifyPoolTask` (the `!counters.last_task_id` branch). That means without a CreatorLoop, a generator-only test reposts the same instance every tick. Account for this in the assertions below.

- [ ] **Step 1: Rename the describe and fix the "does not let one live posting stall the rest of the pool" test**

Replace lines 150-177. With `post_batch_size: 1` and no discoveryApi, two ticks post the two pool instances round-robin (instance round-robin de-dupe + language tie-break still apply). `abandoned` no longer exists in the summary.

```typescript
  it('posts across the pool round-robin without a time window', async () => {
    vi.setSystemTime(new Date('2026-05-08T12:00:00.000Z'));
    const recordRef = { current: launchedRecord() };
    const configRef = {
      current: {
        N_target_successes: 1,
        posting_window_ms: 86_400_000,
        post_batch_size: 1,
        admissionMode: 'python-floor',
      },
    };
    const gen = makeSweRebenchV2GeneratorForLaunchedRecord({
      recordRef, configRef, staticConfig: { stateDir },
    });

    const first = await gen();
    const second = await gen();

    expect(expectTaskArray(first)[0].spec).toMatchObject({ instance_id: 'org__repo-1' });
    expect(expectTaskArray(second)[0].spec).toMatchObject({ instance_id: 'org__repo-2' });
    expect(gen.getState()).toMatchObject({
      totalPosted: 2,
      lastPollSummary: { posted: 1 },
    });
    expect(gen.getState().lastPollSummary).not.toHaveProperty('abandoned');
  });
```

- [ ] **Step 2: Keep the two maxClaims-sizing tests; remove any `N_max_postings_per_task` assumptions that change behaviour**

The tests "sizes maxClaims to remaining target successes" (lines 179-202) and "applies maxClaimsPerOperator and claimLeaseTtlSeconds overrides" (lines 204-235) assert claim-policy sizing, unrelated to the window change — keep them. Remove `N_max_postings_per_task` from their `configRef` objects (it's now defaulted to `Infinity` and is not eligibility-relevant; leaving it is harmless but tidy to drop). Re-run after each edit.

- [ ] **Step 3: Audit the `admissionMode: required` and re-publication blocks**

The blocks at lines 238-407 and 409-572 use `makeTestGenerator` with `N_max_postings_per_task` / `posting_window_ms` / `post_batch_size`. These exercise pool publication, not the window trigger; they construct with no discoveryApi so `claimCounts` is undefined and posted instances (no `last_task_id`) classify `unposted` → still postable. They should pass unchanged. Run them; if any assert `abandoned` or a window-expiry behaviour, update to the new summary shape (no `abandoned`).

Run: `cd client && yarn vitest run test/solver-types/swe-rebench-v2-generator-cooldown.test.ts`
Expected: PASS (all). Fix any residual `abandoned`/window assertions until green.

- [ ] **Step 4: Commit**

```bash
git add client/test/solver-types/swe-rebench-v2-generator-cooldown.test.ts
git commit -m "test(802): update generator window tests to claim-budget model"
```

---

## Task 11: Add the "superseded by #802" note to the DR

**Files:**
- Modify: `log/decisions/2026-05-22-swe-rebench-v2-generation-claiming-semantics.md`

- [ ] **Step 1: Add a short note at the top of §Decision**

Insert immediately after the `## Decision` heading (line 72), before `### Generic task-generator knobs`:

```markdown
> **Superseded in part by #802 (2026-05-28).** §Decision (4)–(6) below specified
> the swe-rebench-v2 repost trigger as *time-expiry* (`last_posted_at +
> posting_window_ms`), with an `N_max_postings_per_task` abandon cap. Issue #802
> promotes Option B (see §Alternatives): the repost trigger is now **claim-budget
> exhaustion** observed via the indexer (`getInstanceClaimCounts`), not the timer,
> and the abandon cap is removed (defaults to unbounded). `posting_window_ms`
> stays as each posting's on-chain claim-window deadline; only its role as the
> repost trigger is gone. Escrow reclaim remains out of scope (no refunds).
```

- [ ] **Step 2: Verify the note is concise (3–8 lines) and does not rewrite the DR body**

Read the file; confirm only the note was added and §Decision (4)-(6) prose is otherwise untouched.

- [ ] **Step 3: Commit**

```bash
git add log/decisions/2026-05-22-swe-rebench-v2-generation-claiming-semantics.md
git commit -m "docs(802): note Option B supersedes DR-2026-05-22-a repost trigger"
```

---

## Task 12: Full-suite verification

**Files:** none (verification only)

- [ ] **Step 1: Typecheck**

Run: `cd client && yarn typecheck`
Expected: EXIT 0.

- [ ] **Step 2: Run the full touched-area suites**

Run:
```bash
cd client && yarn vitest run \
  test/discovery/http.test.ts \
  test/discovery/onchain.test.ts \
  test/discovery/with-fallback.test.ts \
  test/solver-types/swe-rebench-v2-state.test.ts \
  test/solver-types/swe-rebench-v2-auto.test.ts \
  test/solver-types/swe-rebench-v2-generator-cooldown.test.ts \
  test/daemon/creator.test.ts \
  test/main/launched-record-dispatcher.test.ts \
  src/dashboard/spa/src/pages/launcher-launched/GeneratorPanel.test.tsx
```
Expected: all PASS.

Also typecheck the SPA (the daemon `yarn typecheck` in Step 1 does not cover the SPA workspace):

Run: `cd client && yarn workspace @jinn-network/operator-spa exec tsc -b`
Expected: EXIT 0.

- [ ] **Step 3: Run the whole client test suite to catch collateral breakage**

Run: `cd client && yarn test`
Expected: all PASS. If any unrelated suite references `abandoned`, `posting_window_ms`-as-repost-trigger, or constructs a `DiscoveryAPI` that the runtime now calls `getInstanceClaimCounts` on, fix it minimally (add the method to that mock, or drop the `abandoned` assertion). Search first: `grep -rn "abandoned\|getInstanceClaimCounts" test/` and triage.

- [ ] **Step 4: Final commit if any fixes were needed in Step 3**

```bash
git add -A client/test
git commit -m "test(802): satisfy DiscoveryAPI mocks and drop abandoned assertions"
```

---

## Self-review notes (author)

- **Spec coverage:** AC#1 → Tasks 5,7,8; AC#2 → Tasks 5,7; AC#3 → Tasks 5,6,7; AC#4 → Tasks 1-5,7,8; AC#5 revised → Tasks 5,7,11 (`posting_window_ms` retained as deadline at `swe-rebench-v2.ts:652`; no refund/escrow code touched, verified — `refundUnusedTaskBudget`/`expireAttempt` never referenced); indexer-outage-abort → Tasks 3,4,8. Scope item 1 (new query wired through all impls) → Tasks 1-4. Item 2 (taskId ledger) → Tasks 5,6. Item 3 (rewrite classify/select) → Task 7. Item 4 (drop abandon cap → Infinity) → Task 7. Item 5 (tick wiring, abort pattern) → Task 8. Item 6 (DR note) → Task 11. Do-not-break-surfaces carve-out (abandoned removal chain) → Task 9.
- **Divergence flagged (Task 4 / pre-flight fact 4):** the on-chain floor *could* serve real claim counts (unlike success-counts), but the plan keeps it an empty no-op + non-routed to preserve the abort-on-outage guarantee that AC#4/AC#5 require. This is a deliberate, documented deviation from "one-for-one," not an omission.
- **Wiring path made explicit (Task 6):** the design note's "generator records the posted taskId" glosses over the fact that the on-chain taskId is only known in CreatorLoop, not the generator tick. Task 6 wires it where the data actually exists, mirroring the established `recordSuccess` precedent.
- **Type consistency:** `InstanceClaimCount` (discovery result, keyed taskId, fields `taskId/consumed/maxClaims`) vs `InstanceClaimSnapshot` (auto-module classifier input, fields `consumed/maxClaims`). The generator (Task 8) maps the former to the latter. `recordLastTaskId(instance_id, taskId)` consistent across state store, CreatorLoop, and tests.
- **No placeholders:** every code step shows the exact code; every command states expected output.
