# Generator Health Visibility Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Surface live generator health (last poll time, last error, last poll summary) on the launched-record API so the operator dashboard's Generator panel stops showing a blank "Last poll" — making a stalled generator visible instead of silent.

**Architecture:** This is a **daemon wiring gap only** — the consuming halves already exist. The SPA `GeneratorPanel` already renders `record.generatorState?.lastPollAt` and `record.generatorState?.lastError` (`client/src/dashboard/spa/src/pages/launcher-launched/GeneratorPanel.tsx`). The `LaunchedSolverNetRecord` store schema already declares `generatorState` optional (`client/src/solvernets/store.ts:116`), and the SPA type already declares it (`client/src/dashboard/spa/src/api/types.ts:533`). The generator already exposes `getState()`, and `launched-record-dispatcher.ts` already projects it into `LauncherGeneratorStateSnapshot` and collects per-record state readers. The **only** missing link: `GET /v1/solvernets/launched/:id` and `GET /v1/solvernets/launched` return the *persisted* record without merging the *live* generator state. This plan threads a `getGeneratorState` reader into the endpoint and merges it into the response.

**Tech Stack:** TypeScript (Node 22, ESM), Hono (HTTP), Vitest.

**Issue:** [#471](https://github.com/Jinn-Network/mono/issues/471). Companion to #466 (a populated `lastError` is exactly what surfaces an HF-pool-fetch outage).

---

## What already exists (do NOT rebuild)

| Layer | Symbol | File | State |
|---|---|---|---|
| Generator state source | `getState()` → `SweRebenchV2GeneratorStateSnapshot` | `client/src/solver-types/swe-rebench-v2.ts` | ✅ built |
| Projection | `projectLauncherGeneratorState`, `LauncherGeneratorStateSnapshot`, `generatorStatesBySolverType` | `client/src/solvernets/launched-record-dispatcher.ts`, `client/src/api/launcher-status.ts` | ✅ built |
| Record schema | `generatorState` (optional) on `LaunchedSolverNetRecord` | `client/src/solvernets/store.ts:116` | ✅ built |
| SPA type | `generatorState?: LaunchedGeneratorState` | `client/src/dashboard/spa/src/api/types.ts:533` | ✅ built |
| SPA render | `<MetaItem label="Last poll" value={formatTimestamp(record.generatorState?.lastPollAt)} />` + `GeneratorError` | `client/src/dashboard/spa/src/pages/launcher-launched/GeneratorPanel.tsx` | ✅ built |

## File Structure (what this plan changes)

| File | Responsibility | Change |
|---|---|---|
| `client/src/api/solvernets-endpoints.ts` | Add `getGeneratorState` to `SolverNetsLaunchDeps`; merge the live snapshot into the `/launched/:id` and `/launched` responses. | **Modify** (deps interface ~L92-111; `GET /launched/:id` handler L1083-1127; `GET /launched` handler from L1378) |
| `client/test/api/solvernets-endpoints.test.ts` | Test that the endpoint merges live generator state into the response. | **Modify** (add cases) |
| `client/src/main.ts` | Construct the `getGeneratorState` reader from the live per-record generator state readers and pass it into `addSolverNetsEndpoints` deps. | **Modify** (where `wireLaunchedRecordGenerators` result is consumed and SolverNets endpoints are wired) |

---

## Task 1: Merge live generator state into the launched-record API

**Files:**
- Modify: `client/src/api/solvernets-endpoints.ts`
- Test: `client/test/api/solvernets-endpoints.test.ts`

The `GET /v1/solvernets/launched/:id` handler (L1083) returns `{ ...record, summary? }` from two code paths (in-memory `recordRef`, L1100-1103; disk `record`, L1123-1126). The `GET /v1/solvernets/launched` list handler (L1378) returns an array of records. Both must merge the live `generatorState` for each record when a reader is available, falling back to the record's persisted `generatorState` otherwise.

- [ ] **Step 1: Add the dep**

In `client/src/api/solvernets-endpoints.ts`, extend `SolverNetsLaunchDeps` (interface at ~L92-111) with a new optional field, after `lifecycleTransition`:

```ts
  /**
   * Live generator-state reader, keyed by `solverNetId`. Returns the running
   * generator's current poll/error snapshot, or `undefined` when the record
   * has no active generator. When omitted, responses fall back to the
   * record's persisted `generatorState`. See #471.
   */
  getGeneratorState?: (solverNetId: string) => LauncherGeneratorStateSnapshot | undefined;
```

Add the import at the top of the file (next to the other `launcher-status`/`launched-record-dispatcher` imports):

```ts
import type { LauncherGeneratorStateSnapshot } from './launcher-status.js';
```

- [ ] **Step 2: Add a merge helper**

Add this helper near the other private helpers in `solvernets-endpoints.ts` (e.g. just below the deps interfaces, before the route definitions):

```ts
/**
 * Overlay the live generator-state snapshot onto a launched record. The live
 * snapshot wins over the record's persisted `generatorState` (which is only a
 * best-effort checkpoint); when there is no live reader or no active
 * generator, the persisted value is returned unchanged. See #471.
 */
function withLiveGeneratorState(
  record: LaunchedSolverNetRecord,
  getGeneratorState: SolverNetsLaunchDeps['getGeneratorState'],
): LaunchedSolverNetRecord {
  const live = getGeneratorState?.(record.solverNetId);
  if (!live) return record;
  return { ...record, generatorState: live };
}
```

- [ ] **Step 3: Apply the helper in `GET /v1/solvernets/launched/:id`**

In the `GET /v1/solvernets/launched/:id` handler (L1083), both return paths must run the record through `withLiveGeneratorState` before responding.

In the in-memory path (currently L1100-1103):

```ts
        const liveRecord = withLiveGeneratorState(
          entry.recordRef.current,
          deps.launch.getGeneratorState,
        );
        return c.json({
          ...liveRecord,
          ...(summary !== undefined ? { summary } : {}),
        });
```

In the disk path (currently L1123-1126):

```ts
    const liveRecord = withLiveGeneratorState(record, deps.launch?.getGeneratorState);
    return c.json({
      ...liveRecord,
      ...(summary !== undefined ? { summary } : {}),
    });
```

- [ ] **Step 4: Apply the helper in `GET /v1/solvernets/launched` (list)**

In the `GET /v1/solvernets/launched` handler (from L1378), map each record through `withLiveGeneratorState(record, deps.launch?.getGeneratorState)` before serialising the array. Read the handler body first to match its exact record-iteration shape; the change is one `.map()` (or an in-loop reassignment) applying the same helper.

- [ ] **Step 5: Write the test**

In `client/test/api/solvernets-endpoints.test.ts`, add a test in the launched-record GET describe block. Build the endpoint app with a `launch` deps block whose `getGeneratorState` returns a fixed snapshot for a known `solverNetId`, seed a launched record in the store, `GET /v1/solvernets/launched/:id`, and assert the response `generatorState` equals the live snapshot (not the persisted one). Add a second test: with `getGeneratorState` returning `undefined`, the response `generatorState` equals the record's persisted value (unchanged). Model the app construction and store seeding on the existing launched-record GET tests already in that file.

- [ ] **Step 6: Run the test**

Run: `cd client && yarn vitest run test/api/solvernets-endpoints.test.ts`
Expected: PASS — existing tests still green, plus the 2 new cases.

- [ ] **Step 7: Typecheck + commit**

Run: `cd client && yarn typecheck` → exit 0.

```bash
git add client/src/api/solvernets-endpoints.ts client/test/api/solvernets-endpoints.test.ts
git commit -m "feat(client): merge live generator state into the launched-record API (#471)"
```

---

## Task 2: Wire the live state reader in `main.ts`

**Files:**
- Modify: `client/src/main.ts`

`wireLaunchedRecordGenerators` (in `launched-record-dispatcher.ts`) returns `generatorStatesBySolverType: Map<string, () => LauncherGeneratorStateSnapshot | undefined>` and `generators: WiredLaunchedRecordGenerator[]` (each with `solverType` + `getLauncherState`). The launched records are keyed by `solverNetId`; the state readers are keyed by `solverType`. Build a `solverNetId → snapshot` reader and pass it to the SolverNets endpoints.

- [ ] **Step 1: Read the wiring site**

Read `client/src/main.ts` where `wireLaunchedRecordGenerators` is consumed (around L2302, `for (const [solverType, getState] of wired.generatorStatesBySolverType)`) and where `addSolverNetsEndpoints` (or equivalent) is called with `SolverNetsLaunchDeps`. Also read `client/src/solvernets/daemon-init.ts` for the `PendingGeneratorSpawn` shape — its `recordRef.current.solverNetId` is the key needed to map a record to its generator. Confirm how a `solverNetId` maps to a `solverType` (the launched record carries `summary.contractId`/`contractVersion`, or use `resolveContractFromSolverNetId` from `launched-record-dispatcher.ts`).

- [ ] **Step 2: Build the reader and pass it into the endpoint deps**

Construct a `getGeneratorState` function that, given a `solverNetId`, resolves the record's `solverType` (via the pending-generator entry's record, or `resolveContractFromSolverNetId`) and calls the matching reader from `generatorStatesBySolverType`. Pass it as `getGeneratorState` in the `SolverNetsLaunchDeps` block handed to the SolverNets endpoints. Keep it a closure over the live `wired` result so it always reflects current state.

- [ ] **Step 3: Typecheck + build**

Run: `cd client && yarn typecheck && yarn build`
Expected: exit 0, 0 `error TS`.

- [ ] **Step 4: Commit**

```bash
git add client/src/main.ts
git commit -m "feat(client): wire live generator-state reader into SolverNets endpoints (#471)"
```

---

## Manual verification (after Task 2)

1. `cd client && yarn build && node dist/bin/jinn.js run` against the operator's `~/.jinn-client` (SWE-rebench v2 launched).
2. Open the dashboard handshake URL → Launcher → the SWE-rebench v2 launched record.
3. Confirm the Generator panel's **"Last poll"** shows a real timestamp (not `—`) once the generator has polled, and that if the generator's pool fetch fails (#466 territory) the **"Last error"** block renders the failure.
4. Hit `GET /v1/solvernets/launched/<id>` directly and confirm the JSON carries a `generatorState` object with `lastPollAt` / `lastPollSummary`.

---

## Self-Review

**1. Spec coverage (#471 acceptance criteria):**
- *"launched-record API exposes generator runtime state: last poll, last error, last poll summary"* → Task 1 merges the live `LauncherGeneratorStateSnapshot` (which carries `lastPollAt`, `lastError`, `lastPollSummary`) into the `/launched/:id` and `/launched` responses. ✓
- *"Launcher · Launched page renders last poll, last error, recent posting activity"* → already built in `GeneratorPanel.tsx` (`PanelShell` "Last poll" `MetaItem` + `GeneratorError`); Task 1 supplies the data it was already coded to read. Verified by manual step 3. ✓

**2. Placeholder scan:** Tasks 1 carries complete code. Task 2 is deliberately specified as "read these two files, then build the closure" because the exact `main.ts` mount-site symbols are not pinned in this plan — this is a precise instruction (named files, named symbols, named key-mapping helper), not a vacuous placeholder. The implementer confirms the line numbers at execution time.

**3. Type consistency:** `getGeneratorState` returns `LauncherGeneratorStateSnapshot | undefined` (from `launcher-status.ts`) in both the dep declaration (Task 1) and the `main.ts` closure (Task 2). `withLiveGeneratorState` returns `LaunchedSolverNetRecord` with `generatorState` overwritten — the field is already `GeneratorStateSchema.optional()` on that type (`store.ts:116`); confirm `LauncherGeneratorStateSnapshot` satisfies `GeneratorStateSchema` during Task 1 typecheck, and if it does not, the narrower of the two is the daemon's `GeneratorStateSchema` — adjust the projection in `launched-record-dispatcher.ts`'s `projectLauncherGeneratorState` rather than weakening the schema.

**Note:** This plan is intentionally shorter than the #466 plan — most of #471 (SPA panel, SPA type, record schema, state projection) was already built; only the API merge was missing.
