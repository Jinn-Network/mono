# Terminal-Bench 2.1 Official-Suite Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Colophon can lock the official Terminal-Bench 2.1 method, run Harbor under that lock, account every cell, and emit a Hub-shaped job plus submit instructions when the run is actually leaderboard-complete.

**Architecture:** Jinn owns campaign (lock, cells, replacements, Report). Harbor owns the trial. Official `-k 5` is five locked scientific replicates, each a TEP Submission with `attempts.maxTotal = 1`, observed as the Harbor Trial starts. Harbor `retry.max_retries` stays `0`. One Harbor Job per arm spans selected tasks × 5 trials. Hub export is a derived artifact, not the claim of record.

**Tech Stack:** TypeScript, Zod, Vitest, existing `@colophon-claims/core` Harbor adapter, `@jinn-network/benchmarking-run`, wilson@1.

## Global Constraints

- PRs target `next`. Stack on #2733 / PR #2734 when unmerged.
- TDD: no production code without a failing test first.
- Report v2 gains no new required fields.
- Do not batch Inspect. Do not synthesize TEP for a foreign Hub job.
- CI never downloads the full TB 2.1 dataset.
- American English identifiers (`distill`, never `distil`).
- Existing TB 2.0 one-task path stays and cannot claim `terminal-bench-2.1`.
- `SUPPORTED_HARBOR_VERSION_RANGE` remains `0.21.x` unless a later finding supersedes DR-2026-08-17-b decision 7.
- Issues: design #2739, grain #2740, intake #2741, batched Job #2742, Hub export #2743. Follow-ons #2744 (SWE-bench Verified official) and #2745 (Inspect-as-specified) are filed, not built.

---

### Task 1: Harbor job grain — planned trials ≠ hidden retry (#2740)

**Files:**
- Modify: `packages/benchmark-product/core/src/runtime/harbor/manifest.ts`
- Modify: `packages/benchmark-product/core/src/runtime/harbor/launcher.ts`
- Modify: `packages/benchmark-product/core/src/venue/provisioner.ts`
- Modify: `packages/benchmark-product/core/src/runtime/adapter.ts`
- Modify: `packages/benchmark-product/core/src/runtime/harbor/harbor.test.ts`
- Modify: `packages/benchmark-product/core/src/runtime/harbor/host.ts` (pass through `retryPolicy` / `taskNames`)

**Interfaces:**
- Consumes: existing `HarborJobConfigSchema` literals of 1
- Produces: `n_attempts` and `n_concurrent_trials` as positive integers; `max_retries` literal 0; `harborArmJobName(runSha256, armId)`; `assertHarborTrialMatchesCell(...)`; `jobGrain: "per-dispatch" | "per-arm"` on selection (default `per-dispatch`)

- [ ] **Step 1: Write the failing test**

Add tests in `harbor.test.ts` (or a sibling `harbor-job-grain.test.ts`):

1. `HarborJobConfigSchema` accepts `{ n_attempts: 5, n_concurrent_trials: 2, retry: { max_retries: 0 }, datasets: [{ task_names: ["a"], n_tasks: 1, ... }] }` and rejects `max_retries: 1`.
2. `assertHarborTrialMatchesCell` accepts a job with `n_total_trials: 5` when the harvested trial is attempt 2 of task `a`, and still rejects `stats.n_retries !== 0` or `source_trial` set.
3. `harborArmJobName` is `jinn-<24 hex of run>-<armId>` and is stable.
4. Fake Harbor that emits 5 trial directories in one job: harvest maps each trial to a distinct jinn identity; evidence files are not merged; TB 2.0 path still requires one trial when `jobGrain` is `per-dispatch`.

- [ ] **Step 2: Run test to verify it fails**

Run: `yarn --cwd packages/benchmark-product/core test src/runtime/harbor/harbor.test.ts`
Expected: FAIL on schema literals / `assertSingleHarborTrial` / fake Harbor `n_attempts !== 1`.

- [ ] **Step 3: Write minimal implementation**

- Change `retryPolicy.nAttempts` / `nConcurrent` from `z.literal(1)` to `z.number().int().positive()`.
- Keep `maxRetries: z.literal(0)`.
- Dataset `task_names` / `n_tasks` may be N; keep TB 2.0 callers on length 1.
- `assertSingleHarborTrial` remains for `per-dispatch` jobs (`n_attempts === 1`, `n_total_trials === 1`).
- Add `assertHarborRetryPinnedOff` used by both grains.
- Harvest: when `jobGrain === "per-arm"`, select the trial whose task name and 1-based attempt equal the cell's mapped task and replicate; do not require `trialConfigs.length === 1`.
- Structure check in `adapter.ts`: compare job name to per-dispatch or per-arm helper; require `maxRetries === 0`; allow `nAttempts === k`.

- [ ] **Step 4: Run tests**

Run: `yarn --cwd packages/benchmark-product/core test src/runtime/harbor src/runtime/terminal-bench-2`
Expected: PASS. Existing TB 2.0 one-task tests still pass.

- [ ] **Step 5: Commit**

```bash
git commit -m "$(cat <<'EOF'
feat(colophon): allow planned Harbor trials without inner retry

Official TB 2.1 needs k=5 inside one Job. Keep max_retries=0 and the TB 2.0 one-trial path.

EOF
)"
```

---

### Task 2: TB 2.1 intake, named slices, lock, quote (#2741)

**Files:**
- Create: `packages/benchmark-product/core/src/runtime/suite-protocol/manifest.ts`
- Create: `packages/benchmark-product/core/src/runtime/suite-protocol/comparability.ts`
- Create: `packages/benchmark-product/core/src/runtime/suite-protocol/suite-protocol.test.ts`
- Create: `packages/benchmark-product/core/src/runtime/terminal-bench-2-1/manifest.ts`
- Create: `packages/benchmark-product/core/src/runtime/terminal-bench-2-1/host.ts`
- Create: `packages/benchmark-product/core/src/runtime/terminal-bench-2-1/terminal-bench-2-1.test.ts`
- Create: `packages/benchmark-product/core/src/operations/terminal-bench-2-1.ts`
- Modify: `packages/benchmark-product/core/src/operations/index.ts`
- Modify: `packages/benchmark-product/core/src/operations/run-quote.ts`
- Modify: `packages/benchmark-product/core/src/operations/run-lock.ts`
- Modify: `packages/benchmark-product/core/src/report/claim.ts`
- Modify: `packages/benchmark-product/core/src/operations/report.ts` (canonical limitations)

**Interfaces:**
- Consumes: Harbor selection + TB 2.0 registry snapshot pattern
- Produces:
  - `TERMINAL_BENCH_2_1_DATASET_ID = "terminal-bench/terminal-bench-2-1"`
  - `namedSliceTaskNames(snapshot, coverage)` → lexicographic first 1 / first 10 / all
  - `deriveSuiteComparability({ coverage, executionConformance, k, selectedCount, datasetCount, atifPresent })`
  - `selectTerminalBench21Runtime(context, input)`
  - QuotePresentation optional `suite?: { executionConformance, coverage, leaderboardSubmitReady, cellCount, harborVersion }`

- [ ] **Step 1: Write the failing test**

Fixture registry snapshot with 12 task ids. Assert:

1. `one_task` → first name; `ten_task` → first 10; `full` → all 12; custom list is `custom` and cannot be `leaderboard_submit_ready`.
2. `replicates` on the draft after select is 5; Benchmark has one Task per selected name.
3. `deriveSuiteComparability` for 1-task × 5 with official env is `{ executionConformance: true, coverage: "one_task", leaderboardSubmitReady: false }`.
4. Full coverage + k=5 + ATIF + official env is `leaderboard_submit_ready`.
5. Quote presentation includes `tasks × arms × 5` and the three bits.
6. `runLock` on `coverage: "full"` without a quote that recorded those bits refuses.
7. CI fixtures never fetch the live dataset.

- [ ] **Step 2: Run test to verify it fails**

Run: `yarn --cwd packages/benchmark-product/core test src/runtime/suite-protocol src/runtime/terminal-bench-2-1 src/operations/terminal-bench-2-1.ts`

- [ ] **Step 3: Write minimal implementation**

Seal `SuiteProtocolSelection` into Harbor `profiles` plus a registration artifact role
`https://product.jinn.network/artifact-roles/suite-protocol/selection/v1`.
Force `Draft.replicates = 5` and wilson@1 (or leave analysis unset if the draft already has wilson; refuse binary-instrument).
Official env: Harbor environment configuration must omit timeout/resource overrides.
Quote: extend `buildQuotePresentation`.
Lock: if suite coverage is `full`, require the last quote presentation to carry `leaderboardSubmitReady` computation inputs (spec digest already invalidates edits).

- [ ] **Step 4: Run tests** — expect PASS, including existing TB 2.0 tests.

- [ ] **Step 5: Commit** `feat(colophon): intake Terminal-Bench 2.1 named slices`

---

### Task 3: Batched Harbor Job + observe-as-start (#2742)

**Files:**
- Modify: `packages/benchmark-product/core/src/venue/provisioner.ts`
- Modify: `packages/benchmark-product/core/src/runtime/harbor/launcher.ts`
- Create: `packages/benchmark-product/core/src/runtime/harbor/arm-job.ts` (shared jobs dir, first-writer lock, trial observer)
- Create: `packages/benchmark-product/core/src/runtime/harbor/harbor-batched.test.ts`

**Interfaces:**
- Consumes: `jobGrain: "per-arm"`, `retryPolicy.nAttempts === 5`
- Produces: one `harbor run -c` per arm; `recordHarborDispatchMapping` as each trial `config.json` appears; harvest of that trial only

- [ ] **Step 1: Write the failing test**

Fake Harbor for per-arm grain: one invocation per arm, writes k trial dirs sequentially (config.json then result.json). Draft: 1 named task × 2 arms × 5 replicates = 10 cells.

Assert:

1. `harbor-invocations.log` has exactly 2 `run` lines.
2. Ten cells accounted; each mapping is unique; native prediction bytes differ per trial when the fake writes the replicate index.
3. Mapping files exist before the fake process exits (observer saw `config.json`).
4. Inspect tests still launch per cell (unchanged file).
5. `max_retries > 0` still refused.

- [ ] **Step 2: Run test to verify it fails**

- [ ] **Step 3: Write minimal implementation**

Shared jobs directory per `(workspace, runSha256, armId)`. First cell to enter `setup` writes `harbor-job.json` with all `task_names` and `n_attempts = 5` and spawns Harbor via the existing launcher argv (or a run-level spawn with a file lock). Other cells wait for their trial directory. Observer: `watch`/`poll` for `*/config.json` under the job, then `recordHarborDispatchMapping`. Harvest copies that trial's artifacts only.

- [ ] **Step 4: Run tests** — Harbor batched + Inspect + TB 2.0.

- [ ] **Step 5: Commit** `feat(colophon): run one Harbor Job per arm`

---

### Task 4: Hub export (#2743)

**Files:**
- Create: `packages/benchmark-product/core/src/operations/hub-export.ts`
- Create: `packages/benchmark-product/core/src/operations/hub-export.test.ts`
- Modify: `packages/benchmark-product/core/src/operations/index.ts`
- Modify: `packages/benchmark-product/core/src/report/claim.ts` (optional `suiteComparability`)
- Modify: CLI args if `colophon` already exposes operations (only if a command table already exists)

**Interfaces:**
- Consumes: RunState + suite selection + Harbor job dirs
- Produces: `exportHarborHubPackage(context, { draftId, armId })` →
  `{ ok, mode: "leaderboard-submit" | "inspection-upload" | "refused", instructions: string, jobDir: string }`

- [ ] **Step 1: Write the failing test**

1. `leaderboard_submit_ready` → instructions include `harbor upload --public` and `uv run lb submit`, plus the closed-submissions sentence, plus “Colophon does not place the leaderboard row.”
2. Named slice `execution_conformance` → `inspection-upload`; instructions must not say `lb submit` as the next required step; refuse `mode: "leaderboard-submit"`.
3. `custom` → refused with suite-named export error.
4. No operation imports a foreign Hub UUID into TEP.

- [ ] **Step 2: Run test to verify it fails**

- [ ] **Step 3: Write minimal implementation**

Read sealed suite selection. Refuse unless Harbor jobs exist for the arm. Never call network. Copy is honest.

Canonical closed-submissions sentence:

`Community submissions are currently closed for Terminal-Bench 2.1. Colophon does not place the leaderboard row.`

- [ ] **Step 4: Run tests**

- [ ] **Step 5: Commit** `feat(colophon): export Harbor Hub packaging from accounted runs`

---

### Task 5: Verification

- [ ] Run `yarn --cwd packages/benchmark-product/core test` for Harbor, TB 2.0, TB 2.1, suite-protocol, quote, lock, hub-export, Inspect.
- [ ] Confirm Inspect is not batched.
- [ ] Confirm no full TB 2.1 download in tests.
- [ ] Open stacked PRs to `next` (or onto #2734 while open): docs #2739, then #2740–#2743.

## Copy / legitimacy

Colophon may say: the locked TB 2.1 method ran, complete, checkable.

Colophon may not say: this is a TB 2.1 leaderboard score — unless `leaderboard_submit_ready`.
