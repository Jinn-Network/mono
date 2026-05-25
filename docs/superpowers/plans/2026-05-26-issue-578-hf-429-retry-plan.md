# Issue #578 — SWE-rebench v2 validation: HF 429 retry-with-backoff plan

**Date:** 2026-05-26
**Shape:** `fix` (Medium)
**Branch:** `fix/578-swe-rebench-v2-validation-script-silently-loses-290-tasks-to`
**Design note:** [`docs/superpowers/specs/2026-05-26-issue-578-hf-429-retry-design.md`](../specs/2026-05-26-issue-578-hf-429-retry-design.md)

Acceptance criteria from the issue body, restated for ergonomic cross-referencing in step descriptions:

- **AC1** — `loadSweRebenchV2Pool` *and* every other validation-pipeline call to `datasets-server.huggingface.co` implements retry-with-backoff on HTTP 429, ≥3 retries and a base delay of 1 s + jitter.
- **AC2** — On exhausted retries, the failure is still recorded for visibility, but the validation pipeline distinguishes "transient 429 — retry next pass" from "permanent ungradable" so the next run reprocesses these instances.
- **AC3** — An optional concurrency cap on parallel HF requests.

Per handbook rule 7 (`fix` shape) the first work that touches code is a failing regression test; steps follow the "write failing test → watch it fail → implement enough to pass" rhythm grouped by test file. Handbook rule 8b applies to the `transientRetryCount` cap (numeric boundary at 5 — tests exercise count=4 vs count=5, not "small vs large"); the boundary requirement is called out inline in Step 7.

---

## Pre-flight

**Step 0 — Confirm `next` baseline is green.**

- Touches: none.
- What changes: run `yarn typecheck` and `yarn test` in `client/` against `HEAD` of the worktree to confirm we start from a green baseline before any test churn. This guards against attributing a pre-existing failure to our change.
- AC: none (hygiene).
- Boundary note: n/a.

---

## Failing-test phase (regression first, per handbook rule 7)

**Step 1 — Add failing test: shared `fetchHfWithRetry` helper exists and retries 429 with jittered backoff.**

- Touches: `client/test/harnesses/impls/swe-rebench-v2-evaluator/hf-fetcher.test.ts` (extend — new `describe('fetchHfWithRetry — shared helper')` block).
- What changes: import a new named export `fetchHfWithRetry` (does not exist yet — compile error or import-undefined error is the failure) plus a re-exported `defaultHfBackoffMs` (or equivalent constant). Add cases:
  1. retries 429 → succeeds on 2nd try; asserts `sleep` was called with a value within the jittered window `[1000 × 0.67, 1000 × 1.33]` for the first delay (NOT exactly `1000`).
  2. exhausts the schedule `[1000, 2000, 4000, 8000]` ms (4 retries → 5 total attempts, ≥3 retries per AC1) and throws an error whose `httpStatus` property equals `429`.
  3. honours `Retry-After: 2` by sleeping exactly `2000` ms (header overrides jittered schedule).
  4. throws on first 4xx that is not 408/429 without retrying (existing `isRetryableStatus` semantics preserved).
- Run `yarn test client/test/harnesses/impls/swe-rebench-v2-evaluator/hf-fetcher.test.ts` and watch these four cases fail to compile or fail to run because `fetchHfWithRetry` is not exported yet. Commit only the test (red).
- AC: AC1.
- Boundary note: assert the jitter band is half-open and symmetric around the base; explicit lower and upper bounds, no "approximately".

**Step 2 — Add failing test: `httpStatus` surfaces on the thrown error from `HttpHfFetcher.fetchTaskRow` when retries are exhausted.**

- Touches: `client/test/harnesses/impls/swe-rebench-v2-evaluator/hf-fetcher.test.ts` (extend `HttpHfFetcher — retry budget for transient failures`).
- What changes: existing test at line 253–264 already asserts the 503 path. Add a new case that mocks a permanent 429 (`retryBackoffMs: [1, 2]`), catches the thrown error, asserts `(err as { httpStatus?: number }).httpStatus === 429`. Today the error is a plain `Error('HF returned 429')` with no `httpStatus`, so this fails. Run and watch it fail.
- AC: AC2 (the `httpStatus` exposure is what the validated-pool catch block keys off).
- Boundary note: n/a.

**Step 3 — Add failing test: `fetchHfSplit` retries 429 and throws loudly on non-2xx (regression for the silent-empty bug).**

- Touches: `client/test/solver-types/swe-rebench-v2-pool.test.ts` (extend — file currently only covers `listMonthlyPartitions` and `buildHistoricalPool`).
- What changes: add a new `describe('fetchHfSplit')` block. Three cases:
  1. **regression** — 429 then 200 with a `rows: [{ row: { instance_id: 'a' } }]` body returns the row (today `fetchHfSplit` doesn't retry, so this would only succeed once the helper is wired).
  2. **regression** — non-2xx (e.g. 500) after retry exhaustion throws an error whose message includes the status code. Today's `fetchHfSplit` parses `body` regardless of `res.statusCode`, returns `(parsed.rows ?? []).map(...)` which silently yields `[]`. The assertion `await expect(...).rejects.toThrow(/500/)` fails on `next`.
  3. wires a `fetchImpl` injectable so the test doesn't open the real `node:https` socket — this is the API change `fetchHfSplit` must accept (see Step 5).
- AC: AC1 (retry on 429), AC2 (loud failure — caller can distinguish empty pool from upstream outage).
- Boundary note: n/a.

**Step 4 — Add failing test: `validatePoolInstances` records `transient:HF-429:<msg>` on a 429 after exhausted retries, re-processes on the next pass, increments `transientRetryCount`, and flips to terminal at the boundary.**

- Touches: `client/test/solver-types/swe-rebench-v2-validated-pool.test.ts` (extend — add a new `describe('validatePoolInstances — transient HF 429 handling')` block).
- What changes: build a stub `HfFetcher` whose `fetchTaskRow` throws `Object.assign(new Error('HF datasets-server returned 429 for nebius/SWE-rebench-leaderboard/2026_02'), { httpStatus: 429 })`. Four cases:
  1. **first pass** — record produces entry with `reason: 'transient:HF-429:HF datasets-server returned 429 for nebius/SWE-rebench-leaderboard/2026_02'`, `scorable: false`, `transientRetryCount: 1`, `lastTransientAt` ISO string.
  2. **second pass without `force`** — the skip-check at line 578 (today `if (!opts.force && await store.getEntry(...))`) must NOT skip a transient entry; the entry is re-processed and `transientRetryCount` becomes `2`.
  3. **boundary at count=4** — seed the store with a pre-existing transient entry at `transientRetryCount: 4`. Run validation; entry advances to `transientRetryCount: 5` AND `reason` flips to `'error:HF-429-permanent-after-5-passes'`. AC2 says "the next run reprocesses these instances" — this confirms we still attempt the 5th pass.
  4. **boundary at count=5** — seed the store with `transientRetryCount: 5` and `reason: 'error:HF-429-permanent-after-5-passes'`. Run validation; the skip-check fires (terminal), `transientRetryCount` and `reason` are unchanged, the fetcher stub's `fetchTaskRow` is NOT called.
- AC: AC2.
- Boundary note: cases (3) and (4) exercise count=4→5 and count=5 stays terminal exactly as the design's `transientRetryCount < 5 / >= 5` cap specifies — not "small vs large".

**Step 5 — Watch the test phase fail.**

- Touches: none.
- What changes: run `yarn test` once. Confirm steps 1–4 fail in the expected ways (compile errors for missing exports; runtime assertion failures for `httpStatus`, silent-empty, missing `transientRetryCount`). Capture the failure list in the PR description as evidence. Commit nothing.
- AC: none (test-discipline checkpoint).
- Boundary note: n/a.

---

## Implementation phase

**Step 6 — Extract `fetchHfWithRetry` in the shared HF fetcher module; add jitter; raise default min-interval; surface `httpStatus`.**

- Touches: `client/src/harnesses/impls/swe-rebench-v2-evaluator/hf-fetcher.ts`.
- What changes:
  - Export a new module-level function `fetchHfWithRetry(url: string, opts: FetchHfWithRetryOptions): Promise<Response>` with the same signature shape as the current private `HttpHfFetcher.fetchWithRetry` but accepting `fetchImpl`, `retryBackoffMs`, `minRequestIntervalMs`, `sleep`, and `limiter` as fields. The function:
    - calls `limiter.schedule(() => fetchImpl(url), …)` for every attempt (preserves the global throttle — see Step 9 / AC3).
    - on a retryable status, sleeps `retryAfterHeaderMs(res.headers.get('Retry-After')) ?? withJitter(retryBackoffMs[attempt])`.
    - on retry exhaustion against a non-OK response, throws `Object.assign(new Error(\`HF returned ${res.status}\`), { httpStatus: res.status })`.
  - Add a module-local `withJitter(baseMs: number): number` that returns `Math.round(baseMs * (1 + (Math.random() * 2 - 1) * 0.33))`. Inject `random` for tests via an optional `random?: () => number` opt (default `Math.random`).
  - Bump constants: `DEFAULT_RETRY_BACKOFF_MS = [1000, 2000, 4000, 8000]` and `DEFAULT_MIN_REQUEST_INTERVAL_MS = 500` (was `250`). Keep the `SharedHfRequestLimiter` instance exported so other modules can reuse it.
  - Reduce `HttpHfFetcher.fetchWithRetry` to a thin wrapper that delegates to `fetchHfWithRetry`. Run the Step 1 + Step 2 tests — they go green.
- AC: AC1 (retries on 429 with jittered ≥1 s base, ≥3 retries), AC2 (`httpStatus` surfaces).
- Boundary note: jitter band is symmetric ±33% of the base; the multiplier constants in `withJitter` match the assertion bounds in Step 1's case (1).

**Step 7 — Replace `fetchHfSplit`'s raw `node:https.request` with the shared helper; add a status-code check.**

- Touches: `client/src/solver-types/_swe-rebench-v2-pool.ts`.
- What changes:
  - Replace the `node:https` import + `request(...)` Promise body with `const res = await fetchHfWithRetry(url.toString(), opts); if (!res.ok) throw new Error(\`HF datasets-server returned ${res.status} for ${args.dataset}/${args.split}\`); const json = (await res.json()) as { rows?: Array<{ row?: unknown }> }; return (json.rows ?? []).map((r) => r.row);`.
  - Extend `fetchHfSplit`'s arg shape with an optional `opts?: { fetchImpl?, retryBackoffMs?, sleep?, limiter?, minRequestIntervalMs?, random? }` and pass it straight to the helper. Tests get an injection point; production callers stay one-arg.
  - Make sure to wrap the thrown error with `httpStatus` when it's a non-2xx — re-use `Object.assign(new Error(...), { httpStatus: res.status })` for parity with Step 6. Run the Step 3 tests; they go green.
- AC: AC1, AC2.
- Boundary note: n/a.

**Step 8 — Rewire `loadSweRebenchV2Pool`'s `/splits` fetch through the shared helper.**

- Touches: `client/src/solver-types/swe-rebench-v2.ts` (line 140–153, function `loadSweRebenchV2Pool`).
- What changes: import `fetchHfWithRetry` from `../harnesses/impls/swe-rebench-v2-evaluator/hf-fetcher.js`. Replace `const response = await fetch(splitsUrl);` with `const response = await fetchHfWithRetry(splitsUrl, {});` (default opts give the new `[1000, 2000, 4000, 8000]` schedule + 500 ms min interval + jitter). Leave the rest of the function unchanged — the `if (!response.ok)` check at line 143 already guards the splits-listing.
- AC: AC1.
- Boundary note: n/a.

**Step 9 — Extend `ValidatedPoolEntry`, the catch block, and the skip-check for transient-vs-terminal classification.**

- Touches: `client/src/solver-types/_swe-rebench-v2-validated-pool.ts`.
- What changes:
  - Add two optional fields to `ValidatedPoolEntry` (additive — old entries default to absent → effective `0`):
    - `transientRetryCount?: number` — number of times we've recorded a `transient:` reason for this instance under this `evalSemanticsVersion`.
    - `lastTransientAt?: string` — ISO timestamp of the most recent transient pass.
  - Modify the **skip-check** at line 578: replace the bare `if (!opts.force && (await deps.store.getEntry(...))) continue;` with a predicate that reads the entry, then:
    - if `entry === null` → fall through (process as today).
    - if `entry.reason.startsWith('transient:') && (entry.transientRetryCount ?? 0) < 5` → fall through (reprocess — AC2).
    - else → `continue;` (skip).
  - Modify the **catch block** at line 643–655: detect `(err as { httpStatus?: number }).httpStatus === 429` (the shape Step 6 emits). When true, look up the prior entry via `await deps.store.getEntry(task.instance_id, deps.semanticsVersion)` (read inside the catch so we use the current persisted count, not the in-memory value from before this attempt), compute `const prior = priorEntry?.transientRetryCount ?? 0; const next = prior + 1;` and:
    - if `next < 5` → record `{ scorable: false, reason: \`transient:HF-429:${msg.slice(0, 200)}\`, checkedAt, transientRetryCount: next, lastTransientAt: checkedAt, ...optional row fields }`.
    - if `next >= 5` → record `{ scorable: false, reason: 'error:HF-429-permanent-after-5-passes', checkedAt, transientRetryCount: next, lastTransientAt: checkedAt, ... }`.
  - Non-429 errors keep today's behaviour (`ungradeable:` or `error:` prefix), but the entry shape now passes through any prior `transientRetryCount` if you want to preserve history — for v1 keep it simple: non-429 errors clear / don't set the field. Document in a code comment that the field is `undefined` for non-transient entries.
  - Update `parseVettedPoolArtifactEntry` and `loadVettedPoolArtifactScorableEntries` callers only if they need to round-trip the new fields. The vetted-pool artifact only contains `scorable: true` rows, and transient rows are `scorable: false`, so the published artifact is untouched (no schema bump there). Add `transientRetryCount` / `lastTransientAt` to the on-disk `ValidatedPoolEntry` parser path only if there is an explicit parser; today the file is read as `JSON.parse` straight into `ValidatedPoolFile` so optional fields ride along free.
  - Run the Step 4 tests — they go green.
- AC: AC2.
- Boundary note: the `next < 5` / `next >= 5` branches are the literal boundary the issue calls for; covered by Step 4 cases (3) and (4).

**Step 10 — Concurrency cap (AC3).**

- Touches: none (notes-only step — the shared `SharedHfRequestLimiter` already serialises HF requests at min-interval granularity across the whole process, including `buildHistoricalPool`'s sequential `for await` over months. Per the design note, the AC's "optional concurrency cap" is satisfied by the limiter plus the now-doubled min-interval (250 → 500 ms). No additional code.).
- What changes: add a one-line comment in `hf-fetcher.ts` near `sharedHfRequestLimiter` noting that this is the AC3 concurrency-cap surface, with a pointer to the `minRequestIntervalMs` knob and the design note. This makes the implicit cap discoverable for the next person.
- AC: AC3.
- Boundary note: n/a.

---

## Acceptance check

**Step 11 — Verify green locally.**

- Touches: none.
- What changes: from `client/`, run in this order:
  1. `yarn typecheck` — must report zero errors. The `ValidatedPoolEntry` extension is additive, but double-check no production caller assumes the old narrow shape.
  2. `yarn test` — full vitest suite green. In particular, the four test files touched (`hf-fetcher.test.ts`, `swe-rebench-v2-pool.test.ts`, `swe-rebench-v2-validated-pool.test.ts`) all pass; the pre-existing 290+ tests in `client/` remain green.
  3. `yarn lint` if the package script exists (`grep -l '"lint"' client/package.json`); skip otherwise.
  4. Smoke-check the design's expected behaviour by hand: temporarily set `DEFAULT_RETRY_BACKOFF_MS = [10, 20, 40, 80]` in a local diff, run `node -e "import('./dist/solver-types/swe-rebench-v2.js').then(m => m.loadSweRebenchV2Pool().then(p => console.log(p.length)))"` against the real HF endpoint, confirm a 429 → success path in the log. Revert the local override before commit.
- AC: AC1, AC2, AC3 (verification).
- Boundary note: n/a.

**Step 12 — Wire to the PR per `superpowers:verification-before-completion`.**

- Touches: none (administrative).
- What changes: in the PR body, paste the Step 5 failing-test list ("evidence before assertions") and the Step 11 green output. Confirm the PR title prefix is `fix:` (handbook §The shapes of work) and the issue body's `## Run-mode` declares `fix` Medium.
- AC: none (process gate).
- Boundary note: n/a.

---

## Files touched, at a glance

| File | Steps |
|---|---|
| `client/src/harnesses/impls/swe-rebench-v2-evaluator/hf-fetcher.ts` | 6, 10 |
| `client/src/solver-types/_swe-rebench-v2-pool.ts` | 7 |
| `client/src/solver-types/swe-rebench-v2.ts` | 8 |
| `client/src/solver-types/_swe-rebench-v2-validated-pool.ts` | 9 |
| `client/test/harnesses/impls/swe-rebench-v2-evaluator/hf-fetcher.test.ts` | 1, 2 |
| `client/test/solver-types/swe-rebench-v2-pool.test.ts` | 3 |
| `client/test/solver-types/swe-rebench-v2-validated-pool.test.ts` | 4 |

No new source files are introduced; the shared helper lives in the existing `hf-fetcher.ts` module per the design note.
