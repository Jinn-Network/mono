# Design note — #1584 Resolve the api/ ↔ daemon/ bidirectional dependency

## Grounding: the actual import edges

There is **no single import cycle** here — there are two separate coupling problems, and only the peer-sync edge is a true two-way cycle. Grep confirms:

- **api → daemon (concrete):**
  - `api/peers.ts:15` → `daemon/loop-heartbeat.js` (`recordLoopTick`)
  - `api/gather-status.ts:15` → `daemon/spend-cap-gate.js` (`isOverSpendCap`)
- **daemon → api (concrete):**
  - `daemon/daemon.ts:9` → `api/peers.js` (`PeerSync`) — **this is the real cycle**: `PeerSync` lives in `api/` but is a daemon loop, and it reaches back into `daemon/loop-heartbeat`, while `daemon.ts` reaches into `api/` to construct it. `api/peers` is imported nowhere else in `client/src/`.
- **api → engine internals (concrete):**
  - Four build endpoints instantiate `new TaskRunPersistence(store.db)`: `task-runs-build.ts`, `prediction-v1-build.ts`, `portfolio-v0-build.ts`, `loop-completion-build.ts`.
  - Two type-only imports of `PersistedTaskRun`: `task-run-routing.ts`, `portfolio-v0-build.ts` (that's the "six endpoints" — 4 value + 2 type consumers of the engine persistence module).

The API's usage of `TaskRunPersistence` is **narrow and read-only**: exactly three methods — `getInFlight()`, `getByState(state)`, `getGatingRows()` — plus the `PersistedTaskRun` row shape. The build fns already take `store` and reach into `store.db` internally, so there is no wiring change at the call sites in `gather-status.ts`.

## Chosen approach (strangler-fig, minimal layering)

**Move the mis-filed loop; invert the persistence coupling behind a read-model port; relocate the one shared predicate.** Three independent moves, each individually grep-verifiable, no rewrite:

1. **`PeerSync` is a daemon loop — move it to `daemon/`.** It already imports `daemon/loop-heartbeat` and is constructed only by `daemon.ts`. Moving `api/peers.ts` → `daemon/peer-sync.ts` deletes the `daemon → api/peers` edge and the `api/peers → daemon/loop-heartbeat` edge in one stroke — the whole peer-sync cycle collapses because both ends now live under `daemon/`. (`PeerSync` uses `Store` and `auth/erc8128`, both neutral shared modules, so nothing new gets pulled into `daemon/`.)

2. **Introduce a `TaskRunReadModel` port that the API depends on; engine implements it.** Define a small read-only interface in a neutral location — `api/task-run-read-model.ts` (owned by the consumer, so the API depends only inward on an abstraction it defines):
   ```ts
   export interface TaskRunReadModel {
     getInFlight(): PersistedTaskRun[];
     getByState(state: TaskRunState): PersistedTaskRun[];
     getGatingRows(): Array<{ phasesJson: string | null; deliveredTxHash: string | null }>;
   }
   ```
   The four build fns take a `TaskRunReadModel` argument instead of calling `new TaskRunPersistence(store.db)` themselves. `gather-status.ts` (the single caller, itself invoked from `server.ts` with `store`) constructs the concrete implementation once and injects it. Because `TaskRunPersistence` already structurally satisfies this interface, the concrete construction is the only place engine-persistence is named on the read path — and that construction belongs to `gather-status`, which is the composition seam, not to the leaf endpoints.

   To satisfy the ACs' literal "no `api/` module imports `harnesses/engine/persistence`" grep, the concrete instantiation is pushed **out of `api/`**: expose a factory on the neutral `Store` (e.g. `store.taskRunReadModel()` returning a `TaskRunReadModel`), so `gather-status.ts` calls `store.taskRunReadModel()` and never names `TaskRunPersistence`. `Store` already owns `store.db` and is the neutral data-access module both layers legitimately share, so this is the natural home. Engine keeps `TaskRunPersistence` as the implementation.

3. **Relocate the shared spend-cap predicate.** `isOverSpendCap` is a pure function shared by the daemon gate and the `/v1/status` block (its own doc comment says so). The `gather-status.ts:15` import is the last `api → daemon` value edge. Move `isOverSpendCap` into a neutral spend module the API can import without touching `daemon/` — simplest: extract it to `types/` or a small `spend/spend-cap.ts` that both `daemon/spend-cap-gate.ts` (re-exports/imports it) and `api/gather-status.ts` import. The stateful `gateClaimBySpendCap` + memo stays in `daemon/`.

## Neutral types

- `PersistedTaskRun` and `TaskRunState` are the shared types both layers need. `PersistedTaskRun` is defined in `harnesses/engine/persistence.ts`; `TaskRunState` in `harnesses/engine/state.ts`. The read-model port needs `PersistedTaskRun`. Cleanest: **move `PersistedTaskRun` (and keep referencing `TaskRunState` from `engine/state`, or move both) into a neutral `types/task-run.ts`**, re-exported by `persistence.ts` for back-compat. This lets `api/task-run-read-model.ts` and `api/task-run-routing.ts` type-import from `types/` instead of `harnesses/engine/persistence`, closing the two type-only edges the AC grep would otherwise catch.

## Coverage of acceptance criteria

- **AC1 (peer-sync + loop-heartbeat under `daemon/`; no `api/` → `daemon/` or `→ engine/persistence`):** Move 1 relocates `PeerSync`; Move 3 relocates `isOverSpendCap`; the type moves close the type-only edges. After these, grep `from.*daemon` and `TaskRunPersistence|engine/persistence` over `client/src/api/` is empty. ✅
- **AC2 (six build/status endpoints consume a read-model interface):** Move 2 replaces the four `new TaskRunPersistence` sites with an injected `TaskRunReadModel`; the two type consumers switch to the neutral type. ✅
- **AC3 (`yarn test` passes):** `TaskRunPersistence` already satisfies the port structurally; behavior is unchanged; injection point is the single `gather-status` seam. Tests that construct build fns get a `TaskRunReadModel` (real `store.taskRunReadModel()` or a small fake). ✅

## Concrete moves

- **Move** `client/src/api/peers.ts` → `client/src/daemon/peer-sync.ts`; update the sole importer `daemon/daemon.ts:9`.
- **Extract** `PersistedTaskRun` (and optionally `TaskRunState`) → `client/src/types/task-run.ts`; re-export from `harnesses/engine/persistence.ts` / `state.ts` for back-compat.
- **Add** `client/src/api/task-run-read-model.ts` defining `TaskRunReadModel` (imports the type from `types/`).
- **Add** a `taskRunReadModel()` factory method on `Store` (`store/store.ts`) returning a `TaskRunReadModel` backed by `new TaskRunPersistence(this.db)` — keeps `TaskRunPersistence` construction out of `api/`.
- **Flip** the four build fns (`task-runs-build.ts`, `prediction-v1-build.ts`, `portfolio-v0-build.ts`, `loop-completion-build.ts`) to accept a `TaskRunReadModel` param instead of instantiating persistence; drop their `harnesses/engine/persistence` imports.
- **Flip** `task-run-routing.ts` and `portfolio-v0-build.ts` type imports of `PersistedTaskRun` from `harnesses/engine/persistence` → `types/task-run`.
- **Extract** `isOverSpendCap` → neutral `client/src/spend/spend-cap.ts` (or `types/`); import from `daemon/spend-cap-gate.ts` and `api/gather-status.ts`; drop the `api → daemon` import at `gather-status.ts:15`.
- **Update** `gather-status.ts` to obtain the read-model via `store.taskRunReadModel()` and pass it to the four build fns.

## Risks / notes

- **Scope discipline:** `gather-status.ts` also imports `solvernets/daemon-init.js` (`solvernets-endpoints.ts:76`) and `status-build.ts` references daemon-populated fields, but those live under `solvernets/`, not `daemon/` — out of scope for the AC greps and left untouched (Rule 3: surgical).
- **The `Store` factory choice** trades a hair of purity (`Store` now knows about the engine `TaskRunPersistence`) for satisfying the literal AC grep without a DI framework. `Store` is already the shared DB-access seam both layers use, so this is the least-invasive home; the alternative (inject the read-model from `server.ts` where the daemon composes everything) is also fine but touches more wiring. Prefer the `Store` factory for minimality.
- **Back-compat re-exports** keep the type move from rippling into engine/daemon call sites; verify no duplicate-identity type issues via `yarn typecheck`.
