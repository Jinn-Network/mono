# Issue #578 — SWE-rebench v2 validation: HF 429 retry-with-backoff design

**Date:** 2026-05-26
**Shape:** `fix` (Medium)
**Branch:** `fix/578-swe-rebench-v2-validation-script-silently-loses-290-tasks-to`

## Approach

Extract a single shared `fetchHfWithRetry(url, opts)` helper (co-located with the
existing `HttpHfFetcher` in `client/src/harnesses/impls/swe-rebench-v2-evaluator/hf-fetcher.ts`,
re-exported for use from `solver-types`) that wraps `globalThis.fetch` with: a)
status-aware retries on `408 | 429 | 5xx` (existing `isRetryableStatus`); b) a
longer, jittered backoff schedule `[1000, 2000, 4000, 8000]` ms with ±33%
uniform jitter, capped/overridden by a `Retry-After` header when HF returns one
(parser already exists); c) the shared `SharedHfRequestLimiter` for global
min-interval spacing (raise the default from 250 ms to 500 ms — empirically the
old 250 ms + 4.2 s max backoff was insufficient to clear the 429 wave). Rewire
the three call sites: (1) the `/splits` fetch on `swe-rebench-v2.ts:142` (today
`fetch` with no retry); (2) `fetchHfSplit` in `_swe-rebench-v2-pool.ts:79-100`
(today raw `node:https.request` that doesn't even check `res.statusCode` —
replace the body with the shared helper + status check, fixing the silent-empty
bug as a side effect); (3) `HttpHfFetcher.fetchWithRetry` (delegate to the
shared helper so the backoff schedule is canonical). AC's "optional concurrency
cap" is already covered by `SharedHfRequestLimiter` serialising globally and by
`buildHistoricalPool` iterating months in a sequential `for await`; explicitly
no additional cap is added — instead the min-interval bump (250 → 500 ms) is
the tunable knob.

## Making transient 429s non-terminal across passes (option (a) — recommended)

Introduce a new reason prefix `transient:HF-429:<message>` (parallel to the
existing `ungradeable:` family) recorded when `fetchTaskRow` exhausts retries
with a 429. The catch block at `_swe-rebench-v2-validated-pool.ts:643-655`
gains a status-extraction branch (rethrow inner-error attaches `httpStatus`
from `fetchHfWithRetry`); on `httpStatus === 429` after exhausted retries it
records `reason: \`transient:HF-429:<msg>\`` plus a new
`transientRetryCount: number` (incremented from prior entry if present) and
`lastTransientAt` timestamp. The skip-check on line 578 grows a predicate:
re-process when `entry.reason.startsWith('transient:')` AND
`entry.transientRetryCount < 5`; after 5 exhausted passes it flips to
`reason: 'error:HF-429-permanent-after-5-passes'` and becomes terminal. This
preserves visibility (the entry stays in `validated-pool.json` with full
history) while making the next validation run reprocess transient failures, and
gives a clean convergence boundary so a permanently-broken split doesn't churn
forever. Note: the AC text says "the failure is still recorded as
`error:HF datasets-server returned 429 …`" — we deliberately diverge from the
literal `error:` prefix because that prefix is what marks an entry terminal
today; switching to `transient:` is the surgical lever that makes
re-processing safe. The verbatim error message is still embedded in the reason
string, so the operator-facing signal in `validated-pool.json` is preserved.

## TDD sketch, trade-offs, risks

**Failing tests written first** (regression, per handbook rule 7): (1)
`hf-fetcher.test.ts` — `fetchHfWithRetry` retries on 429, sleeps according to
the jittered backoff (mocked sleep + clock), honours `Retry-After`, gives up
after N attempts and surfaces `httpStatus`; (2) `_swe-rebench-v2-pool.test.ts`
— `fetchHfSplit` retries 429 then succeeds, and (regression) throws loudly on
non-2xx instead of returning `[]`; (3) `_swe-rebench-v2-validated-pool.test.ts`
— `validatePoolInstances` records `transient:HF-429:…` with
`transientRetryCount: 1` on the first 429 pass, re-processes it on the next
run (does not hit the skip), increments to 2, and after 5 passes flips to
`error:HF-429-permanent-after-5-passes` (terminal). **Risks:** extended backoff
adds ~15 s worst-case latency per failing instance, which is bounded and only
on failure — net positive vs. losing 40% of the pool. The convergence boundary
(5 passes) is a guess; if HF's 429 envelope is longer-lived than expected,
operators can `--force` to override or we raise the cap in a follow-up. Header
quirk: HF sometimes returns 429 with no `Retry-After`; our jittered schedule
handles that branch. Adding `transientRetryCount` is an additive schema change
to `ValidatedPoolEntry` — old entries without the field default to 0 on read,
so prior `validated-pool.json` snapshots remain forward-compatible.
