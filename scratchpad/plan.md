# Plan — Issue #1584: Resolve the api ↔ daemon bidirectional dependency

Shape: **refactor** (strangler-fig, stacked, individually reviewable moves; TDD/architecture-test discipline).

## Goal / success criteria (from the issue)

1. Peer-sync loop and loop-heartbeat consumers live under `daemon/`; **no module in `client/src/api/` imports from `client/src/daemon/` or `client/src/harnesses/engine/persistence`** (grep-verified in the PR).
2. The six build/status endpoints consume a **read-model interface** instead of `TaskRunPersistence`.
3. `yarn test` passes.

The refactor is behavior-preserving. `TaskRunPersistence` already structurally satisfies the read-only port, so no runtime behavior changes.

---

## Verification of the design (Stage-1 checks, done)

### The current `api/ → {daemon, engine/persistence}` edges (grep evidence)

```
api/task-run-routing.ts:1       import type { PersistedTaskRun }  from '../harnesses/engine/persistence.js'   (type-only)
api/portfolio-v0-build.ts:16    import { TaskRunPersistence }     from '../harnesses/engine/persistence.js'   (value)
api/portfolio-v0-build.ts:17    import type { PersistedTaskRun }  from '../harnesses/engine/persistence.js'   (type-only)
api/loop-completion-build.ts:24 import { TaskRunPersistence }     from '../harnesses/engine/persistence.js'   (value)
api/prediction-v1-build.ts:10   import { TaskRunPersistence, type PersistedTaskRun } from '.../persistence.js' (value+type)
api/task-runs-build.ts:2        import { TaskRunPersistence, type PersistedTaskRun } from '.../persistence.js' (value+type)
api/gather-status.ts:15         import { isOverSpendCap }         from '../daemon/spend-cap-gate.js'          (value)
api/peers.ts:15                 import { recordLoopTick }         from '../daemon/loop-heartbeat.js'          (value)
```

And the reverse edge that closes the cycle:
```
daemon/daemon.ts:9              import { PeerSync }               from '../api/peers.js'
```

`PeerSync` is imported **only** by `daemon/daemon.ts` (grep confirmed; `daemon.ts:254` field, `:363` construction). So moving it is a clean single-importer relocation.

`recordLoopTick` / `getLoopTick` (`daemon/loop-heartbeat.ts`) is already under `daemon/`. Its only `api/` consumer is `api/peers.ts`; every other consumer is already in `daemon/`, `harnesses/engine/`, or `adapters/`. Once `peers.ts` moves, no `api/` module imports `loop-heartbeat` — AC-1's "loop-heartbeat consumers live under `daemon/`" is satisfied by the peers move alone (no separate move of loop-heartbeat needed; it is already home).

### Chosen injection seam — **factory method on `Store`** (`store.taskRunReadModel()`)

Cycle check (the risk the design flagged):

```
store/store.ts:9   import { TASK_RUNS_SCHEMA } from '../harnesses/engine/persistence.js'   (value — ALREADY EXISTS)
engine/persistence.ts imports: better-sqlite3 (type), ./state.js, ../../types/task.js
```

`store → engine/persistence` **already exists** today (value import of `TASK_RUNS_SCHEMA`). `engine/persistence.ts` does **not** import from `store/` (grep of persistence.ts + its transitive deps `state.ts`, `types/task.ts` shows no `store` import). Therefore adding `store.taskRunReadModel()` that does `new TaskRunPersistence(this.db)` introduces **no new cycle** — it reuses an edge that is already present and one-directional.

Decision: **put the factory on `Store`** (`client/src/store/store.ts`). This keeps `api/` free of any `engine/persistence` import and avoids threading a concrete read-model through `server.ts`. The alternative (construct the concrete read-model in `server.ts` and thread it into `gather-status`) is viable but strictly more wiring; we take the Store-factory seam because the `store → persistence` edge is pre-existing and neutral.

### The read-model port — 3 methods, all read-only

`api/` uses exactly three `TaskRunPersistence` methods:

- `getInFlight(): PersistedTaskRun[]`  (persistence.ts:620)
- `getByState(state: TaskRunState): PersistedTaskRun[]`  (persistence.ts:612)
- `getGatingRows(): Array<{ phasesJson: string | null; deliveredTxHash: string | null }>`  (persistence.ts:682)

Method-by-consumer:
- `task-runs-build.ts` → `getInFlight`, `getByState('COMPLETE'|'FAILED'|'RACE_LOST')`
- `prediction-v1-build.ts` → same
- `portfolio-v0-build.ts` → same
- `loop-completion-build.ts` → `getGatingRows`

`getByState` takes `TaskRunState`; the port will accept `TaskRunState` (imported type). `TaskRunState` comes from `harnesses/engine/state.ts`, so to keep `api/` clean the port's method should accept a **widened `string`** OR the neutral type must also be reachable without importing `engine/`. Simplest: the port method signature is `getByState(state: TaskRunState): readonly PersistedTaskRun[]` where **both `TaskRunState` and `PersistedTaskRun` are re-exported from the neutral `types/task-run.ts`** (see Step 2). All four call sites pass string literals that are valid `TaskRunState` members, so no cast is needed.

### Neutral types move

`PersistedTaskRun` currently lives in `harnesses/engine/persistence.ts:153`. `TaskRunState` lives in `harnesses/engine/state.ts`. Move (or re-export) both into a neutral `client/src/types/task-run.ts`:
- `api/task-run-routing.ts` and `api/task-run-read-model.ts` type-import `PersistedTaskRun` from `types/task-run.js`.
- `persistence.ts` re-exports both for back-compat so no other importer breaks and existing test imports (`import { TaskRunPersistence } from '.../persistence.js'`, `import type { PersistedTaskRun }`) keep working.

### Spend-cap predicate move

`isOverSpendCap` (pure, stateless) is defined in `daemon/spend-cap-gate.ts` and used by both `daemon/spend-cap-gate.ts` (internally, in `gateClaimBySpendCap`) and `api/gather-status.ts:791`. Relocate the pure predicate to a neutral `client/src/spend/spend-cap.ts`; both consumers import from there. The stateful `gateClaimBySpendCap` + `lastPausedByCredential` memo + `_resetSpendCapGateMemoForTests` stay in `daemon/spend-cap-gate.ts` and import `isOverSpendCap` from `spend/spend-cap.js`. `spend/` already exists (`spend/credential.ts`, `spend/ai-units.ts`), and `gather-status.ts` already imports from `spend/` — so this is a neutral home with no cycle risk.

### Call sites that must change (complete enumeration)

**Build fns (signature change: accept a `TaskRunReadModel` param):**
- `api/task-runs-build.ts` — `gatherTaskRunsStatus(store)` → `gatherTaskRunsStatus(readModel)` (drop `new TaskRunPersistence(store.db)`; `store` no longer needed — verify no other `store.*` use in this fn: it uses only `store.db`, so the param can become `readModel: TaskRunReadModel`).
- `api/prediction-v1-build.ts` — `gatherPredictionV1Status(store, options)` → `gatherPredictionV1Status(readModel, options)` (fn body uses only `store.db`).
- `api/portfolio-v0-build.ts` — `gatherPortfolioV0Status(store, workingDirRoot)` → needs BOTH the read-model AND `workingDirRoot` (uses `store.db` for persistence + a Claude-outcome dir scan that is independent of the read-model). Keep signature `(readModel: TaskRunReadModel, workingDirRoot)`; the dir scan does not touch `store`. **Verify** in Step 5 that `portfolio-v0-build.ts` uses `store` only for `store.db` (grep showed only `new TaskRunPersistence(store.db)` at :161).
- `api/loop-completion-build.ts` — `gatherLoopCompletion(store)` → `gatherLoopCompletion(readModel)` (uses only `new TaskRunPersistence(store.db).getGatingRows()` at :93).

**Composition seam (obtains read-model, injects it):**
- `api/gather-status.ts`:
  - `:573` `gatherTaskRunsStatus(store)` → pass `store.taskRunReadModel()`
  - `:563` `gatherPortfolioV0Status(store, …)` → pass `store.taskRunReadModel()`
  - `:607` `gatherPredictionV1Status(store, {…})` → pass `store.taskRunReadModel()`
  - `:778` `gatherLoopCompletion(store)` → pass `store.taskRunReadModel()`
  - `:791` `isOverSpendCap(...)` — swap import from `daemon/spend-cap-gate.js` to `spend/spend-cap.js`.
  - Build a single `const trm = store.taskRunReadModel();` once near the top of `gatherGatheredStatusRaw` and reuse for the three raw-path build fns; `gatherLoopCompletion` in `gatherStatusForApi` gets its own `store.taskRunReadModel()` (or thread it — the two functions are separate; simplest is one call each).

**Type-only:**
- `api/task-run-routing.ts:1` — import `PersistedTaskRun` from `types/task-run.js`.
- `api/portfolio-v0-build.ts:17` and `api/prediction-v1-build.ts:10` — the `type PersistedTaskRun` import switches to `types/task-run.js`; the value `TaskRunPersistence` import is deleted (build fn no longer constructs it).
- `api/task-runs-build.ts:2` — same: drop the value import, switch the type import to `types/task-run.js`.

**Peer-sync move:**
- `daemon/daemon.ts:9` — `import { PeerSync } from '../api/peers.js'` → `from './peer-sync.js'`.

**Neutral factory:**
- `client/src/store/store.ts` — add `taskRunReadModel(): TaskRunReadModel { return new TaskRunPersistence(this.db); }` (imports `TaskRunPersistence` from `../harnesses/engine/persistence.js` — value import; edge already exists via `TASK_RUNS_SCHEMA`) and imports the `TaskRunReadModel` type from `../api/task-run-read-model.js`. NOTE: importing the port *type* from `api/` into `store/` is a **type-only** import and creates `store → api` at the type level. To avoid any `store → api` edge at all (even type-only), **define the `TaskRunReadModel` port in a neutral module** `client/src/types/task-run-read-model.ts` and have BOTH `api/` (consumers) and `store/` (factory) type-import it from there. (This is cleaner than the design's "consumer-owned in `api/`" placement, which would force `store → api`. Chosen: neutral `types/task-run-read-model.ts`.)

### Test call sites that must change

Existing tests that import moved/renamed symbols:
- `client/test/api/task-runs-build.test.ts` — calls `gatherTaskRunsStatus(store)`; populates via `new TaskRunPersistence(store.db)`. After the param change, update call to `gatherTaskRunsStatus(store.taskRunReadModel())`. `TaskRunPersistence` import stays (still used to seed data) — still resolves via persistence.ts.
- `client/test/api/portfolio-v0-build.test.ts` — `gatherPortfolioV0Status(store)` / `(store, …)` → `gatherPortfolioV0Status(store.taskRunReadModel(), …)`.
- `client/test/api/prediction-v1-build.test.ts` — `gatherPredictionV1Status(store, …)` → `gatherPredictionV1Status(store.taskRunReadModel(), …)`.
- `client/test/harnesses/engine/race-loss-pruning.test.ts:16` and `client/test/harnesses/engine/transient-rpc-stall.test.ts:15` — both call `gatherTaskRunsStatus(...)`; update the arg to `store.taskRunReadModel()`.
- `client/test/api/gather-status.test.ts`, `status-spend.test.ts`, `status-ai-units.test.ts`, `status-cost-surface.test.ts` — call `gatherStatusForApi(store, …)`. **Unchanged** (the read-model is obtained internally via `store.taskRunReadModel()`; the public `gatherStatusForApi(store, status)` signature is preserved).
- `client/test/daemon/spend-cap-gate.test.ts:2` — imports `gateClaimBySpendCap`, `_resetSpendCapGateMemoForTests` from `daemon/spend-cap-gate.js`. **Unchanged** (those stay in `spend-cap-gate.ts`). If any test imports `isOverSpendCap` from `spend-cap-gate.js`, re-export it from there for back-compat OR update the import — grep found no test importing `isOverSpendCap`, so no change needed; still, re-export `isOverSpendCap` from `spend-cap-gate.ts` for zero-churn.

No existing test imports `PeerSync` (grep confirmed — only `daemon.ts` uses it). No existing architecture/grep boundary test exists in `client/test/`.

---

## New tests that lock the refactor

### T-arch — architecture / grep boundary test (write FIRST, must fail before the moves)

`client/test/architecture/api-daemon-boundary.test.ts` (new dir). Reads every `.ts` under `client/src/api/` and asserts **none** contains an import from `../daemon/` or from `../harnesses/engine/persistence`. Implement by scanning file text for `from '../daemon/`, `from '../../daemon/`, `daemon/`-suffixed specifiers, and `harnesses/engine/persistence`. This test FAILS on `main` (8 offending edges) — that failure proves the cycle exists. It PASSES only after all moves land. This is the AC-1 gate.

- Keep the matcher precise: match import specifiers that resolve into `client/src/daemon/` or end in `harnesses/engine/persistence(.js)`. Allow `harnesses/engine/` sub-paths other than `persistence` (only `persistence` is forbidden by the AC).

### T-readmodel — build fns run against a fake `TaskRunReadModel`

`client/test/api/task-run-read-model-fake.test.ts` (new). Construct a hand-rolled fake implementing the 3-method `TaskRunReadModel` port (returning canned `PersistedTaskRun[]` and gating rows), pass it to each of the four build fns, and assert the shaped output. This proves the build fns depend on the **port**, not on `TaskRunPersistence` — AC-2. (This is the TDD artifact for the read-model introduction.)

---

## Step-by-step (each step = one reviewable strangler-fig move; tree compiles between steps)

### Step 0 — Write the failing architecture test (TDD red)
Create `client/test/architecture/api-daemon-boundary.test.ts` (T-arch). Run it; confirm it **fails** listing the current `api/ → daemon` and `api/ → engine/persistence` edges. Commit as the red baseline.
→ Gates AC-1.

### Step 1 — Move `api/peers.ts` → `daemon/peer-sync.ts`
`git mv client/src/api/peers.ts client/src/daemon/peer-sync.ts`. Fix its internal import of `loop-heartbeat` (was `../daemon/loop-heartbeat.js`, becomes `./loop-heartbeat.js`) and of `store`/`auth` (was `../store/store.js` → `../store/store.js` unchanged depth-wise: `api/` and `daemon/` are both one level under `src/`, so `../store/store.js` and `../auth/erc8128.js` stay correct). Update `daemon/daemon.ts:9` import to `./peer-sync.js`.
This deletes the `daemon → api/peers` reverse edge AND the `api/peers → daemon/loop-heartbeat` forward edge, collapsing the real runtime cycle.
→ Tree compiles. `yarn test` still green (no test imports peers).
→ Advances AC-1 (T-arch loses 1 of its `api/→daemon` findings).

### Step 2 — Introduce neutral `types/task-run.ts` for `PersistedTaskRun` + `TaskRunState`
Move the `PersistedTaskRun` interface out of `persistence.ts` into `client/src/types/task-run.ts` and re-export `TaskRunState` there too (re-export from `harnesses/engine/state.ts` — `types/` importing `engine/state` is acceptable; `state.ts` has no `store`/`api` deps, no cycle). In `persistence.ts`, `export type { PersistedTaskRun } from '../../types/task-run.js';` (back-compat) so every existing importer keeps resolving.
→ Tree compiles; all existing imports (tests included) unchanged. Pure relocation.

### Step 3 — Introduce the neutral `TaskRunReadModel` port
Create `client/src/types/task-run-read-model.ts`:
```ts
import type { PersistedTaskRun, TaskRunState } from './task-run.js';
export interface TaskRunReadModel {
  getInFlight(): PersistedTaskRun[];
  getByState(state: TaskRunState): PersistedTaskRun[];
  getGatingRows(): Array<{ phasesJson: string | null; deliveredTxHash: string | null }>;
}
```
`TaskRunPersistence` structurally satisfies this already (verify by adding `implements TaskRunReadModel` to the class in a follow-up-optional micro-edit, OR just rely on structural typing at the factory — structural is enough; do NOT add an `import` of the port into `persistence.ts` unless you also want the nominal check).
→ Tree compiles (new file, no consumers yet).

### Step 4 — Add the factory `store.taskRunReadModel()`
In `client/src/store/store.ts`, add:
```ts
taskRunReadModel(): TaskRunReadModel { return new TaskRunPersistence(this.db); }
```
Import `TaskRunPersistence` (value — edge already exists via `TASK_RUNS_SCHEMA`) and `type { TaskRunReadModel }` from `../types/task-run-read-model.js`. No new cycle (verified: persistence has no `store` dep; the port is neutral).
→ Tree compiles; factory unused so far.

### Step 5 — Convert the four build fns to consume `TaskRunReadModel` (+ write T-readmodel first)
Per-fn, in this order (each independently reviewable; each keeps the tree compiling because `gather-status.ts` is updated in the SAME step for that fn's call site — OR do all four then update gather-status once; simplest: update all four fns and their `gather-status` call sites together in this step, since gather-status won't compile with a half-converted set):

Write **T-readmodel** first (red), then:
- `task-runs-build.ts`: signature `gatherTaskRunsStatus(runs: TaskRunReadModel)`; delete `TaskRunPersistence` value import; switch `PersistedTaskRun` type import to `types/task-run.js`; body uses `runs.getInFlight()` / `runs.getByState(...)`.
- `prediction-v1-build.ts`: `gatherPredictionV1Status(runs: TaskRunReadModel, options)`; same import surgery.
- `portfolio-v0-build.ts`: `gatherPortfolioV0Status(runs: TaskRunReadModel, workingDirRoot?)`; drop `TaskRunPersistence` value import; `PersistedTaskRun` type import → `types/task-run.js`; the Claude-outcome dir scan is untouched (does not use `store`). Verify no other `store.*` reference remains.
- `loop-completion-build.ts`: `gatherLoopCompletion(runs: TaskRunReadModel)`; body `runs.getGatingRows()`; drop `TaskRunPersistence` import.
- `gather-status.ts`: in `gatherGatheredStatusRaw`, `const trm = store.taskRunReadModel();` and pass `trm` to the portfolio/task-runs/prediction fns (`:563`, `:573`, `:607`); in `gatherStatusForApi`, pass `store.taskRunReadModel()` to `gatherLoopCompletion` (`:778`). Public `gatherStatusForApi(store, status)` / `gatherGatheredStatusRaw(store, status)` signatures preserved.

Update the existing build-fn tests to pass `store.taskRunReadModel()`:
- `test/api/task-runs-build.test.ts`, `test/api/portfolio-v0-build.test.ts`, `test/api/prediction-v1-build.test.ts`
- `test/harnesses/engine/race-loss-pruning.test.ts`, `test/harnesses/engine/transient-rpc-stall.test.ts`
(the `gather-status.*` tests are unchanged.)
→ Tree compiles; T-readmodel goes green; existing suites green.
→ Satisfies **AC-2**. Removes the four `api/ → engine/persistence` value edges; the two remaining type-only edges (`portfolio`/`prediction` `PersistedTaskRun`) now point at `types/task-run.js`, not `engine/persistence`. `task-run-routing.ts` type import → `types/task-run.js` (do it in this step). After this step, **zero** `api/ → engine/persistence` imports remain.

### Step 6 — Relocate `isOverSpendCap` to neutral `spend/spend-cap.ts`
Create `client/src/spend/spend-cap.ts` exporting the pure `isOverSpendCap`. In `daemon/spend-cap-gate.ts`, delete the local definition, import `isOverSpendCap` from `../spend/spend-cap.js`, and **re-export** it (`export { isOverSpendCap } from '../spend/spend-cap.js';`) for back-compat. In `api/gather-status.ts:15`, change the import from `../daemon/spend-cap-gate.js` to `../spend/spend-cap.js`.
→ Tree compiles; `test/daemon/spend-cap-gate.test.ts` unchanged and green.
→ Removes the last `api/ → daemon` value edge.

### Step 7 — Flip the architecture test to green + full verification
Run T-arch: it now PASSES (no `api/ → daemon`, no `api/ → engine/persistence`). Run the grep manually as belt-and-suspenders:
```
grep -rn "from '\.\./daemon/\|from '\.\./\.\./daemon/\|harnesses/engine/persistence" client/src/api/    # expect: no matches
```
Run `yarn typecheck` and `yarn test` (full suite).
→ Satisfies **AC-1** and **AC-3**.

---

## AC → step mapping

| Acceptance criterion | Steps |
|---|---|
| Peer-sync + loop-heartbeat consumers under `daemon/`; no `api/ → daemon` or `api/ → engine/persistence` | Step 1 (peers), Step 6 (spend-cap), Step 5 (persistence edges), locked by Step 0 + Step 7 (T-arch) |
| Six build/status endpoints consume a read-model interface | Steps 2–5 (neutral types, port, factory, build-fn conversion + T-readmodel) |
| `yarn test` passes | Step 5 (test updates), Step 7 (full run) |

## Notes / risks

- **No new cycle** from the Store factory: `store → engine/persistence` pre-exists and is one-directional; the port is neutral (`types/`). Confirmed by grep of `persistence.ts` + `state.ts` + `types/task.ts` (no `store` import).
- **`daemon/peer-sync.ts` relative-import depths** are identical to `api/peers.ts` (both one dir under `src/`), so only the `loop-heartbeat` specifier changes (`../daemon/` → `./`). Double-check `auth/erc8128.js` and `store/store.js` specifiers stay `../auth/…`, `../store/…` (they do).
- **`getByState` typing:** the port uses `TaskRunState` (re-exported via `types/task-run.js`). All four call sites pass literal states already valid under `TaskRunState`; no casts.
- **`implements TaskRunReadModel` on `TaskRunPersistence`** is optional (structural typing suffices). Skip it to avoid adding a `types/` import into `engine/persistence.ts` — not required and keeps the move minimal (Rule 3, surgical).
- **Back-compat re-exports** (`PersistedTaskRun` from `persistence.ts`, `isOverSpendCap` from `spend-cap-gate.ts`) keep every non-`api/` importer and existing test compiling with zero churn; they can be removed in a later cleanup PR but are not in scope here.
