# Validated Clean Pilot Slate V3 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build and activate a deterministic 24-task SWE-rebench v3 slate drawn from metadata-clean, current-semantics validated tasks with all evaluated distillation source instances excluded, then make it the resumable pilot's default denominator.

**Architecture:** A pure pilot-selection module owns quality classification, provenance exclusion, deterministic ordering, and admission verification. A small builder script materializes the existing content-addressed slate format plus a screening sidecar. The pilot loads v3 for new default runs while existing output directories continue solely from their frozen instances.

**Tech Stack:** TypeScript, Node.js, Vitest, existing SWE-rebench pool/slate/validation APIs, JSON artifacts.

## Global Constraints

- Use `nebius/SWE-rebench-leaderboard`; never use the 20-row sample as the implicit pilot source.
- Select exactly 24 tasks that are `scorable: true` under `EVAL_SEMANTICS_VERSION === '4'` and have present, parseable, all-clean `A` quality metadata.
- Exclude every `instanceId` in the paired distillation `selection.json` selected clusters.
- Keep v1 and v2 immutable; create and activate v3.
- Preserve explicit `--instances` and `--instances-file` diagnostics.
- Resume existing `--out` directories without reloading or reselecting live task data.
- Unit tests make no live solver, grader, Docker, or model calls.

---

### Task 1: Pure Validated-Clean Selection

**Files:**
- Create: `client/src/pilot/task-selection.ts`
- Create: `client/test/pilot/task-selection.test.ts`

**Interfaces:**
- Consumes: `PoolTask`, `ValidatedPoolEntry`, and selected-cluster JSON from eval-prep.
- Produces: `isCleanBenchmarkTask(task)`, `distillationSourceIds(selection)`, `selectValidatedCleanTasks(args)`, and `verifySelectedTaskAdmission(args)`.

- [ ] **Step 1: Write failing quality and provenance tests**

Cover an all-`A` row, each true `B1`-`B6` flag, missing/malformed metadata, extraction of every selected cluster `instanceIds` value, and exclusion of those IDs.

```ts
expect(isCleanBenchmarkTask(taskWith([{ code: 'A', detected_issues: cleanFlags }]))).toBe(true);
expect(isCleanBenchmarkTask(taskWith([{ code: 'B3', detected_issues: { ...cleanFlags, B3: true } }]))).toBe(false);
expect(distillationSourceIds({ selected: [{ instanceIds: ['repo__one-1'] }] }))
  .toEqual(new Set(['repo__one-1']));
```

- [ ] **Step 2: Run the focused test and confirm it fails**

Run: `cd client && yarn vitest run test/pilot/task-selection.test.ts`

Expected: module import failure because `task-selection.ts` does not exist.

- [ ] **Step 3: Implement fail-closed metadata parsing and provenance extraction**

`isCleanBenchmarkTask` must require a non-empty `meta.llm_metadata` array, require every assessment code to equal `A`, and reject any true `detected_issues` value. `distillationSourceIds` must validate `selected` and collect non-empty strings from every selected cluster's `instanceIds`.

- [ ] **Step 4: Add failing deterministic-selection tests**

Prove that selection requires a scorable entry with a row hash, excludes provenance IDs and active older-slate IDs, returns exactly the requested count, is unchanged when pool order changes, and throws when fewer eligible tasks remain.

```ts
const selected = selectValidatedCleanTasks({
  pool: shuffled,
  scorableEntries,
  excludedIds,
  count: 24,
  seed: 'jinn.pilot.validated-clean.v3',
});
expect(selected.map((task) => task.instance_id)).toEqual(expectedIds);
```

- [ ] **Step 5: Implement stable selection and verification**

Order candidates by SHA-256 of `${seed}:${instance_id}`, then by `instance_id`. Return structured selected entries containing `instance_id`, `hf_dataset`, `hf_split`, and the validation `rowHash`. Verification must throw actionable errors for non-clean metadata, missing/current-semantics validation, provenance overlap, split mismatch, or row-hash mismatch.

- [ ] **Step 6: Run the focused tests**

Run: `cd client && yarn vitest run test/pilot/task-selection.test.ts`

Expected: all task-selection tests pass.

### Task 2: Build and Activate Slate V3

**Files:**
- Create: `client/scripts/build-pilot-slate.ts`
- Create: `client/src/solver-types/slates/held-out-slate.swe-rebench-v2.v3.json`
- Create: `client/src/solver-types/slates/held-out-slate.swe-rebench-v2.v3.screening-report.json`
- Modify: `client/src/solver-types/_swe-rebench-v2-held-out-slate.ts`
- Modify: `client/test/solver-types/swe-rebench-v2-held-out-slate.test.ts`

**Interfaces:**
- Consumes: Task 1 selectors, `loadSweRebenchV2Pool()`, `ValidatedPoolStore.getScorableEntries()`, v1/v2 active IDs, and an eval-prep `selection.json` path.
- Produces: immutable v3 slate and screening artifacts; active train-stream exclusion for v3.

- [ ] **Step 1: Write failing slate activation tests**

Assert `ACTIVE_HELD_OUT_SLATE_VERSIONS` equals `['v1', 'v2', 'v3']`, v3 loads with 24 unique IDs and a valid declared hash, and active-slate union includes a known v3 ID.

- [ ] **Step 2: Run the held-out slate test and confirm it fails**

Run: `cd client && yarn vitest run test/solver-types/swe-rebench-v2-held-out-slate.test.ts`

Expected: v3 is absent from active versions or its artifact cannot be loaded.

- [ ] **Step 3: Implement the builder**

Accept `--distillation-dir`, optional `--state-dir`, optional `--out-dir`, `--count` defaulting to `24`, and fixed seed `jinn.pilot.validated-clean.v3`. Load `selection.json`, hash its bytes, select from the production pool, and write:

```json
{
  "schemaVersion": "held-out-slate.v1",
  "solverType": "swe-rebench-v2.v1",
  "version": "v3",
  "generatedAt": "<ISO timestamp>",
  "instanceIds": ["<24 deterministic IDs>"],
  "hash": "sha256:<canonical artifact hash>"
}
```

The screening sidecar must include semantics version, seed, policy version, validation timestamp, selection SHA-256, excluded source IDs, and selected entries with split, row hash, checked-at, reason, and quality code evidence.

- [ ] **Step 4: Run the builder against the paired distillation artifact**

Run:

```bash
cd client
PATH=/Users/adrianobradley/.nvm/versions/node/v22.22.2/bin:$PATH \
  yarn tsx scripts/build-pilot-slate.ts \
  --distillation-dir "$HOME/.jinn-client/distillation-evals/claude-paired-11-2026-07-10"
```

Expected: v3 slate and screening report contain exactly 24 tasks, no selected distillation source ID, and only current-semantics validated clean tasks.

- [ ] **Step 5: Activate v3 and run tests**

Add `'v3'` to `ACTIVE_HELD_OUT_SLATE_VERSIONS`, then run:

`cd client && yarn vitest run test/pilot/task-selection.test.ts test/solver-types/swe-rebench-v2-held-out-slate.test.ts`

Expected: both files pass.

### Task 3: Make V3 the Pilot Default

**Files:**
- Modify: `client/scripts/run-pilot.ts`
- Modify: `client/src/pilot/resume.ts`
- Modify: `client/test/pilot/run-pilot-resume.test.ts`
- Modify: `client/test/pilot/resume.test.ts`

**Interfaces:**
- Consumes: shipped v3 slate/screening report, production pool, current `ValidatedPoolStore`, and existing frozen-run APIs.
- Produces: default v3 task refs for new runs and unchanged explicit-instance behavior.

- [ ] **Step 1: Write failing default-source tests**

Inject pool/validation/slate dependencies and prove a new run receives all 24 v3 refs, explicit instances bypass the default selector, and no sample-dataset ID appears. Add failure cases for stale semantics, missing validation, dirty metadata, provenance overlap, split mismatch, and row-hash mismatch.

- [ ] **Step 2: Write the resume regression test**

Create an existing output with frozen instances, make live task-source dependencies throw, rerun, and assert the run reports/skips completed records without calling any live selector or fetcher.

- [ ] **Step 3: Run focused tests and confirm failures**

Run:

`cd client && yarn vitest run test/pilot/run-pilot-resume.test.ts test/pilot/resume.test.ts`

Expected: default source remains the hardcoded sample and/or resume reaches live selection.

- [ ] **Step 4: Implement default-source resolution**

Represent CLI instances as optional until task-source resolution. `--instances` and `--instances-file` set an explicit-source marker. For a new non-explicit run, load and verify shipped v3 plus its screening report and materialize its refs. For an existing non-forced `--out`, read `manifest.json` and `instances.json` first and use their frozen refs without consulting the current pool.

- [ ] **Step 5: Persist source identity in the manifest**

Add optional semantic fields `taskSource` and `slateHash` so new runs bind reports to v3. Legacy manifests normalize without these fields. Compatibility checks compare them when present.

- [ ] **Step 6: Run pilot tests**

Run:

```bash
cd client
yarn vitest run \
  test/pilot/task-selection.test.ts \
  test/pilot/run-pilot-resume.test.ts \
  test/pilot/resume.test.ts \
  test/pilot/solve.test.ts \
  test/pilot/tally.test.ts
```

Expected: all pilot tests pass.

### Task 4: Full Verification and Dry Selection

**Files:**
- Modify only files required by failures found during verification.

**Interfaces:**
- Consumes: completed Tasks 1-3.
- Produces: merge-ready implementation and a frozen 72-attempt dry-run manifest.

- [ ] **Step 1: Run combined regression tests**

```bash
cd client
yarn vitest run \
  test/pilot/task-selection.test.ts \
  test/pilot/repo.test.ts \
  test/pilot/run-pilot-resume.test.ts \
  test/pilot/resume.test.ts \
  test/pilot/solve.test.ts \
  test/pilot/tally.test.ts \
  test/solver-types/swe-rebench-v2-held-out-slate.test.ts \
  test/solver-types/swe-rebench-v2-validated-pool.test.ts
```

Expected: all tests pass.

- [ ] **Step 2: Run type checking and formatting checks**

Run: `cd client && yarn typecheck && git diff --check`

Expected: both commands exit zero.

- [ ] **Step 3: Run a no-model dry selection**

Run the pilot with the three-arm file, `--dry-run`, a fresh temporary `--out`, and `--max-new-solves 0`. Verify `manifest.json` contains 24 v3 tasks and `attemptCount: 72`, while no solver or grader starts.

- [ ] **Step 4: Review the final diff**

Confirm v1/v2 artifacts are unchanged, generated skill outputs are not tracked, the 20-row sample is absent from default configuration, and unrelated dirty-worktree changes were not reverted.
