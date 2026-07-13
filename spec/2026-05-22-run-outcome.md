# Run-relative outcome on the operator Activity table

- **Version:** 0.1
- **Date:** 2026-05-22
- **Author:** Jinn contributor
- **Issue:** #502

The operator dashboard's Activity table lists this operator's task runs with a technical
`state` (pending / RUNNING / COMPLETE / FAILED / RACE_LOST). `state` answers "did my daemon
finish the run?" — it does *not* answer "did the network judge the run a pass or a fail?" This
spec adds a second, task-relative axis — **outcome** — and defines how it is derived, where it
comes from, and how it degrades.

## 1. Run vs task language

A **run** is one operator's local attempt at a task. It carries a technical `state` recording
the run's own lifecycle. The task-relative **outcome** is a separate axis: given the verdict
envelopes the network posted against the run's *task*, did the network judge the run a pass or a
fail? A run can be `state: COMPLETE` (my daemon delivered) while its outcome is `'fail'` (the
evaluators rejected the solution), `'pass'` (they accepted it), or `'awaiting'` (no quorum yet).
The two axes are orthogonal and are rendered in separate columns.

## 2. Quorum rule

The outcome of a solve run is decided by a **strict-majority** quorum over the resolved verdicts
for its task:

- `SOLVE_OUTCOME_QUORUM = 0.5`. A pole (pass or fail) must hold *strictly more than* half of the
  resolved verdicts to decide the outcome.
- The denominator is **resolved = PASS + FAIL**. `INVALID` / `INDETERMINATE` / `UNKNOWN` verdicts
  are excluded upstream and never counted into either pole.
- A **tie** (`pass === fail`) decides nothing and stays `'awaiting'`.
- A **non-COMPLETE** run has no outcome axis → `null` (the SPA renders `—`).
- A **COMPLETE** run with **zero** resolved verdicts → `'awaiting'`.

The rule is the single source of truth in `client/src/api/run-outcome.ts` (`deriveSolveOutcome`,
`deriveEvaluateOutcome`, and the exported `SOLVE_OUTCOME_QUORUM`). Build code MUST import these
rather than re-deriving the majority test inline — the quorum is never magic-numbered in the
status-build path.

## 3. Data source

Outcomes are derived from the shared indexer's `verdictEnvelopeMeta` entity, read through
`DiscoveryAPI.getVerdictTallies({ taskIds })`. That method returns, per decimal `taskId`, the
count of `verdictEnvelopeMeta` rows whose normalized `evaluatorVerdict` is `PASS` / `FAIL`
respectively; the indexer folds `REJECTED → FAIL`.

There is **no local `task_runs`/`verdicts` table to derive this from**. The daemon's local SQLite
store holds only *this operator's own* runs and the envelopes it produced — it has no view of the
verdicts *other* evaluators posted against a task. The task-relative outcome is a network-wide
judgement, so it must come from the indexer, not the local store.

## 4. Degradation

Outcome is a **DISPLAY signal**, not a correctness gate. Every failure mode degrades to a
non-committal value, never a wrong `'fail'`:

- Discovery outage / `DiscoveryUnavailableError` → the `withFallback` wrapper routes
  `getVerdictTallies` to the on-chain floor (tolerant, like `getTaskStatuses`), which returns an
  empty Map.
- On-chain floor → empty Map (it cannot decode the IPFS-enrichment-backed verdict poles).
- No `discovery` threaded into the status build, or any thrown error during enrichment → outcomes
  stay `null`.

An absent taskId in the tally map → `'awaiting'` (COMPLETE) or `null` (non-COMPLETE). The
enrichment step in `gather-status.ts` is wrapped so a discovery failure never breaks `/v1/status`.

## 5. Field type

`outcome: 'pass' | 'fail' | 'awaiting' | 'accepted' | 'rejected' | null` is added to
`TaskRunSummary` (`client/src/api/task-runs-build.ts`) and to `ActivityTask` in the SPA. The pure
`toSummary` seeds it to `null`; the async status path enriches it via `applyOutcomes`.

## 6. Evaluate-run deferral

An evaluate run's outcome asks a different question: did *this operator's own* verdict agree with
the network's majority pole? That answer needs the operator-verdict join (this run's own posted
verdict vs. the task's resolved pole). `deriveEvaluateOutcome` specifies the `'accepted'` /
`'rejected'` values for when that join lands, but the join is **not yet wired**: `applyOutcomes`
passes `operatorPassed = undefined` for evaluation runs today, so they ship as `'awaiting'`. Wiring
the operator-verdict join to light up `'accepted'` / `'rejected'` is a follow-up.
