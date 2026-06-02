# `jinn eval` Orchestrator Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add `jinn eval <slate> --checkpoint <cid>` — runs a frozen-mode slate against a checkpoint, persists per-task pass/fail, and emits a Wilson-CI resolved-rate comparison vs the parent checkpoint.

**Architecture:** Four layers, pure-first. (1) Wilson-CI math (pure). (2) `instance_id → SweRebenchV2Task` resolver over an injected `HfFetcher`. (3) `eval_results` SQLite table + store methods. (4) An orchestrator that ties slate → resolver → `runHarnessOnce({mode:'frozen'})` → `SweRebenchV2Evaluator.grade` → store → comparison, with every external boundary (harness, `fetchImplStateDirToLocal`, `EvalRunner`, `HfFetcher`) constructor-injected. (5) A thin CLI shell. The injected seams (Tasks 2,3,4) are the **thin slice #819 mocks**.

**Tech Stack:** TypeScript, Vitest, better-sqlite3, viem, zod, yargs `CommandModule`.

**Verification (every task):** `cd client && yarn typecheck` (zero errors) + the task's targeted `yarn vitest run <file>`. The orchestrator (Task 5) must pass with NO Docker/IPFS via injected mocks.

---

### Task 1: Wilson score interval + delta (pure math) — AC#2

**Files:**
- Create: `client/src/eval/wilson.ts`
- Test: `client/test/eval/wilson.test.ts`

- [ ] **Step 1: Write failing tests.** `wilsonInterval(passed, scorable, z=1.96)` returns `{ p, lo, hi }`. Cases: `(8,10)` → p=0.8, lo≈0.49, hi≈0.94 (assert `toBeCloseTo`, 2 dp); `(0,0)` → `{ p:0, lo:0, hi:0 }` (no NaN); `(10,10)` → hi≈1.0; lo never <0, hi never >1. Then `compareRates(child:{passed,scorable}, parent:{passed,scorable})` returns `{ child:Interval, parent:Interval, delta:number, verdict:'trustworthy'|'within-noise' }` where `delta = child.p − parent.p` and verdict is `'trustworthy'` iff intervals do NOT overlap (`child.lo > parent.hi || parent.lo > child.hi`), else `'within-noise'`.
- [ ] **Step 2: Run, verify fail.** `cd client && yarn vitest run test/eval/wilson.test.ts` → FAIL (module not found).
- [ ] **Step 3: Implement.** Standard Wilson formula; guard `scorable===0`. **Judgment call: write-small, do NOT add a stats dep** — this repo avoids deps and the formula is ~10 lines.
- [ ] **Step 4: Run, verify pass.**
- [ ] **Step 5: Commit** `feat(eval): add Wilson score interval + rate comparison`.

---

### Task 2: `instance_id → SweRebenchV2Task` resolver (injected HfFetcher) — AC#1, **#819 SEAM**

**Files:**
- Create: `client/src/eval/resolve-slate-tasks.ts`
- Test: `client/test/eval/resolve-slate-tasks.test.ts`

The slate stores only ids; `SweRebenchV2Task` (`packages/sdk/src/swe-rebench-v2.ts`: `instance_id`, `interface`, `hf_dataset` `/^[^/]+\/[^/]+$/`, `hf_split` `/^\d{4}_\d{2}$/`) needs `hf_dataset`/`hf_split` re-fetched. `HfFetcher` (`swe-rebench-v2-evaluator/index.ts:24`) only returns an `HfRow` (no `hf_dataset`/`hf_split` echo), so the resolver takes the dataset+split as args (operator-supplied / slate-level) and verifies each id exists via `fetchTaskRow`.

- [ ] **Step 1: Write failing tests.** `resolveSlateTasks({ instanceIds:Set, hf_dataset, hf_split, fetcher })` → ordered `SweRebenchV2Task[]` (sorted by `instance_id`). Mock `HfFetcher.fetchTaskRow` returns a stub `HfRow`. Assert: each task has `instance_id`, `hf_dataset`, `hf_split`, `interface:''`; a fetcher `throw` for one id propagates loud (no silent drop). Returned `HfRow`s are passed through alongside (return `Array<{ task: SweRebenchV2Task; row: HfRow }>` so Task 5 reuses the row — avoids a second fetch).
- [ ] **Step 2: Run, verify fail.**
- [ ] **Step 3: Implement.** Iterate sorted ids, `await fetcher.fetchTaskRow(...)`, build `{ task, row }`. No retry logic here (the `HttpHfFetcher` owns retries).
- [ ] **Step 4: Run, verify pass.**
- [ ] **Step 5: Commit** `feat(eval): add slate instance_id → task resolver`.

---

### Task 3: `eval_results` table + store methods — AC#1, AC#2

**Files:**
- Modify: `client/src/store/store.ts` (append to `SCHEMA` after `capture_spans` table ~L507; add methods near other recorders)
- Test: `client/test/store/eval-results.test.ts`

- [ ] **Step 1: Write failing tests.** Open an in-memory `Store`. `recordEvalResult({ checkpoint_cid, slate_hash, slate_version, instance_id, passed:boolean|null, unscorable:boolean, code_digest, run_at_ms, test_log_excerpt })` upserts on PK `(checkpoint_cid, slate_version, instance_id)` (re-record overwrites). `getEvalAggregate(checkpoint_cid, slate_version)` → `{ passed:number, scorable:number, unscorable:number }` where `scorable = count(unscorable=0)`, `passed = count(passed=1 AND unscorable=0)`. `getEvalResults(checkpoint_cid, slate_version)` → ordered rows. Assert an `unscorable` row is EXCLUDED from `scorable` and never counts as a fail.
- [ ] **Step 2: Run, verify fail.**
- [ ] **Step 3: Implement.** Add to `SCHEMA`:
```sql
CREATE TABLE IF NOT EXISTS eval_results (
  checkpoint_cid TEXT NOT NULL,
  slate_hash TEXT NOT NULL,
  slate_version TEXT NOT NULL,
  instance_id TEXT NOT NULL,
  passed INTEGER,
  unscorable INTEGER NOT NULL DEFAULT 0,
  code_digest TEXT NOT NULL,
  run_at_ms INTEGER NOT NULL,
  test_log_excerpt TEXT,
  PRIMARY KEY (checkpoint_cid, slate_version, instance_id)
);
```
Methods use `prepare(...).run/all` with `INSERT ... ON CONFLICT(checkpoint_cid,slate_version,instance_id) DO UPDATE`. Booleans ↔ `0/1`; `passed` nullable when `unscorable`.
- [ ] **Step 4: Run, verify pass** + `yarn vitest run test/store` (no regression to existing store tests).
- [ ] **Step 5: Commit** `feat(store): add eval_results table + recorders`.

---

### Task 4: Eval orchestrator (all seams injected) — AC#1, AC#2, AC#3, **#819 THIN SLICE**

**Files:**
- Create: `client/src/eval/orchestrator.ts`
- Test: `client/test/eval/orchestrator.test.ts`

Deps interface (all injected — this is the #819 mock surface): `{ harness: Harness; fetchImplStateDirToLocal(cid,dir): Promise<string>; evaluator: SweRebenchV2Evaluator; runHarnessOnce: typeof runHarnessOnce; store: Pick<Store,'recordEvalResult'|'getEvalAggregate'>; }`. Inputs: `{ checkpointManifest, slate: LoadedHeldOutSlate, tasksWithRows: Array<{task,row}>, parentCheckpointCid }`.

- [ ] **Step 1: Write failing tests** (no Docker/IPFS):
  - **AC#1 happy path:** 2-instance slate; `runHarnessOnce` mock returns `{ envelope:{executor:{codeDigest}} }` + a solution `patch` per instance (orchestrator reads the solution from the harness run — mock supplies it); `evaluator.grade` mock → `passed_match` true/false. Assert `recordEvalResult` called twice with correct `passed`, and the result lists per-task pass/fail.
  - **AC#2:** mock `getEvalAggregate` for parent (same `slate_version`) → orchestrator returns `compareRates(...)` output. Assert: when parent aggregate is ABSENT (`scorable:0` AND no rows), it throws a typed `ParentNotEvaluatedError("eval the parent checkpoint first")` — no cross-version compare.
  - **AC#3 freeze-fence:** `runHarnessOnce` mock returns `{ violation }` → orchestrator throws loud `FreezeFenceViolationError` and does NOT call `recordEvalResult` for that instance.
  - **Unscorable:** `evaluator.grade` throws `EvalCouldNotGradeError` or `InsufficientDiskError` → `recordEvalResult({ unscorable:true, passed:null })`; excluded from denominator (assert aggregate scorable unaffected).
- [ ] **Step 2: Run, verify fail.**
- [ ] **Step 3: Implement.** For each `{task,row}`: `fetchImplStateDirToLocal(manifest.implStateDirCid, tmp)` once (hoist outside loop — same checkpoint), `runHarnessOnce({ harness, implStateDir, mode:'frozen', task })`; on `violation` throw; else extract solution patch, `evaluator.grade({ task, solutionPayload:{patch}, row })` in try/catch (catch the two typed errors → unscorable), `recordEvalResult`. After loop: read child + parent aggregates (same `slate_version`), `compareRates`, return `{ perTask, comparison }`.
- [ ] **Step 4: Run, verify pass.**
- [ ] **Step 5: Commit** `feat(eval): add frozen-mode eval orchestrator`.

---

### Task 5: `jinn eval` CLI shell (factory + thin shell) — AC#1, AC#2

**Files:**
- Create: `client/src/cli/commands/eval.ts`
- Modify: `client/src/cli/index.ts` (import + add to `COMMANDS` ~L50)
- Test: `client/test/cli/eval.test.ts`

Mirror `checkpoint.ts`: a pure `evalCommand({ ...resolved deps })` factory tested directly, plus a thin `CommandModule` default export that wires real deps (IPFS fetch → `HarnessCheckpointManifestSchema.parse`, `loadHeldOutSlate(solverType,version)`, `HttpHfFetcher`, `PythonEvalRunner`, `Store`) and renders `--json`/`--human`.

- [ ] **Step 1: Write failing tests.** Drive the factory with mocked deps (the Task 2/3/4 seams): assert `jinn eval v1 --checkpoint <cid>` resolves slate + manifest, runs the orchestrator, and the `--json` output carries `perTask[]` and `comparison{child,parent,delta,verdict}`. Assert `parentCheckpointCid` defaults from `manifest.parentCheckpointCid` and `--parent` overrides it. Assert `CommandModule.name === 'eval'` and is registered in `COMMANDS`.
- [ ] **Step 2: Run, verify fail.**
- [ ] **Step 3: Implement.** Flags: `<slate-version>` positional, `--checkpoint <cid>` (required), `--solver-type` (default `swe-rebench-v2`), `--parent <cid>`, `--json`/`--human`. Use `parseCommandArgs`. **Judgment call: delta CI presentation** — human mode prints `child p̂=0.80 [0.49,0.94] vs parent 0.60 [0.30,0.85]  Δ=+0.20  (within noise)`; recommend two-line table, verdict word last.
- [ ] **Step 4: Run, verify pass** + `yarn vitest run test/cli/eval.test.ts test/cli/help.test.ts`.
- [ ] **Step 5: Commit** `feat(cli): add jinn eval command`.

---

## Acceptance-criteria → step traceability

- **AC#1** (runs slate frozen, writes per-task pass/fail): Task 2 (resolve tasks) + Task 3 (`recordEvalResult`) + Task 4 (orchestrator loop with `mode:'frozen'`, records each result) + Task 5 (CLI invocation). Tested in T2/T3/T4 happy-path + T5 CLI.
- **AC#2** (resolved-rate comparison vs parent + CI): Task 1 (Wilson + `compareRates`) + Task 3 (`getEvalAggregate` for same `slate_version`) + Task 4 (parent-absent → `ParentNotEvaluatedError`, no cross-version compare) + Task 5 (`--parent` override, render). Tested in T1 math, T4 compare/parent-absent, T5 render.
- **AC#3** (freeze-fence holds, no implStateDir mutation): Task 4 orchestrator throws loud on `runHarnessOnce` `{ violation }` and skips recording. Tested in T4 freeze-fence case. (Enforcement itself lives in the already-shipped `runHarnessWithFreezeFence`; we consume it.)

**#819 mock seam:** Tasks 2, 3, 4 are constructor-injected (`HfFetcher`, `Store` methods, `harness`/`fetchImplStateDirToLocal`/`EvalRunner`/`evaluator`). Task 4 is the **thin slice** #819 drives a tiny deterministic slate against with no Docker/IPFS.
