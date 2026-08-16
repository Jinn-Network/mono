# `@jinn-network/task-curation`

> Candidate in `implementations-v1`. Eligible for receipt-gated canary; that is not independent ratification.

## What this is

A projection of observed verdicts into per-task **observed pass rates**.

`projectCuration(observations)` takes verdict observations and returns rows keyed by
`(taskDigest, bucket)`, each carrying `{taskDigest, bucket, attempts, verdicts, passRate: {num,
den}, window, inputRefs}`. `foldCuration(previous, observations)` folds new observations into an
existing projection and is idempotent under at-least-once redelivery.

It is a **projection, never a record**. Nothing here seals, signs, hashes, or assigns a record
kind. `serializeCurationProjection` emits host-stored derived state under the format token
`network.jinn.task-supply.curation-projection/1.0` — a format, not a record kind. Anyone can
throw the stored document away and re-derive it from the announcements listed in every row's
`inputRefs`.

The package is pure: no clock, no network, no filesystem, no randomness. `Date.parse` is the
only time primitive it uses, and it is a pure function of its argument. Every instant in the
output came from an observation. A guard
(`.github/scripts/task-supply-curation-guards.test.mjs`) enforces this by scanning the source.

## Bounded claims

The numbers on a row describe **what was observed**, and nothing more.

- `attempts` — the number of *distinct attempts among the observed verdicts*, counted by
  `attemptUri`. Not attempts posted, claimed, or in flight; this package cannot see those.
- `verdicts` — every observed verdict, including `inconclusive`.
- `passRate` — the observed pass rate over decision-grade verdicts: `num` = pass,
  `den` = pass + fail. Inconclusive verdicts are counted in `verdicts` but excluded from `den`,
  so `verdicts - passRate.den` recovers the inconclusive count and `passRate.den -
  passRate.num` recovers the fail count exactly. The rate is always a pair of integers; there
  is no bare rate and no float anywhere on the output.
- `window` — `{first, last}` observation instants for that row, compared by instant value
  rather than by string so that offsets other than `Z` order correctly.

A row is not a statement about the task itself. It is a statement about a population of
observed verdicts, produced by whichever solvers and evaluators happened to act, under whatever
incentives were in force. Two consumers filtering different cohorts will legitimately compute
different rates from the same announcements — see *Manipulation* below.

## Adapter boundary

`CurationObservation` is a neutral input type defined in this package. It mirrors upstream
shapes field for field but imports nothing, because the adapter that produces it needs fetch
capability and this package must not have any. That adapter therefore lives **outside** this
package.

| Field | Where an adapter reads it from |
| --- | --- |
| `taskDigest` | The **subject** Task digest, adapter-resolved. The evaluation Delivery's own `task` field is the *derived evaluation* Task (`packages/marketplace/binding/src/evaluation-derive.ts`), so the adapter resolves the subject through the evaluation Task payload's `subjectTask.digest` or the Result Evaluation Statement's subjects. |
| `verdict` | `statementVerdict` on the verdict-correspondence facts card emitted by `packages/marketplace/projector/src/announce.ts` (`"pass" \| "fail" \| "inconclusive"`). |
| `observedAt` | `AnnouncementEntry.timestamp` (`packages/discovery/protocol/src/entry.ts`), which the marketplace projection source fills from the deterministic block timestamp — never projector wall-clock time (`packages/marketplace/projector/src/observe.ts`). |
| `attribution` | The evaluator identity: on-chain `VerdictDeliveryClaimed.evaluator` (`packages/marketplace/projector/src/events.ts`) or the statement predicate's `evaluator.id`. Required. |
| `benchmarkRun` | The `benchrun` attribute of the **judged solution** Delivery (`packages/discovery/facts/task-execution/profiles/delivery.1.0.json`), joined by the adapter. Absent means organic. |
| `ref` | `AnnouncedItem.provenance` + `record.digest` (`packages/discovery/protocol/src/item.ts`), plus the Delivery facts card's `attemptUri`. |

`inputRefKey(ref)` is the discovery subscribe plane's at-least-once dedupe tuple
`(source agent, source name, entry digest, announcementId)` — the same tuple as
`announcementDedupeKey` in `packages/discovery/protocol/src/cloudevents.ts`. Folding on it is
what makes redelivery a no-op.

Malformed input throws `CurationInputError`. This package fails closed and never guesses:

- **No control characters in free text.** `source.agent`, `source.name`, `announcementId`,
  `attemptUri`, `attribution`, and `benchmarkRun` must carry none. The dedupe key is joined on
  the unit separator, so a component containing one would re-partition the key and let a source
  forge a collision with another source's ref.
- **A dedupe key identifies one observation.** An exact redelivery is a no-op; a redelivery that
  disagrees — different verdict, instant, attribution, subject task, bucket, or ref — is refused.
  Keeping the first and dropping the second would make the published rate depend on arrival
  order and would leave the discarded announcement out of `inputRefs`, invisible in the inputs.
- **Stored state is input too.** `parseCurationProjection` and `foldCuration`'s `previous`
  argument validate every row as strictly as an observation — digest form, bucket, instants, ref
  shape, dedupe-key uniqueness across the whole projection, and every counter against
  `inputRefs` — and reconstruct rows rather than passing the stored object through.

## Manipulation, and what this layer can and cannot do

Sybil and collusion effects on an observed pass rate **cannot be prevented at the projection
layer**. A cohort that floods a task with self-favourable verdicts moves the published rate, and
no amount of arithmetic here undoes that.

What this layer does instead is make the manipulation *visible in the inputs* and the rate
*re-derivable under any consumer's own filter*. Every row carries `inputRefs` listing every
announcement that fed it, with the attribution of each observation available on the input side.
A row without complete `inputRefs` is a contract violation, not an optimization.

`fixtures/observations-manipulation.json` and `src/manipulation.test.ts` pin both derivations:
twelve observations on one task, four honest and eight from a sybil cohort. The unfiltered
projection reports `{num: 10, den: 12}` with all twelve refs present; a consumer excluding the
cohort re-derives `{num: 2, den: 4}` from the same announcements, with the cohort's refs absent.
The two disagree, which is the point of publishing the inputs.

Benchmark-pinned attempts are a related but separate concern: a benchmark run deliberately
hammers one task, so its verdicts are not market evidence about it. They are not dropped and
not mixed in — the projection emits a separate row per `(task, bucket)`, so a consumer reading
the `organic` row never has to know benchmarking happened.

## Saturation

`saturationAt(row, threshold)` reports whether a row's observed pass rate sits strictly above a
**caller-supplied** threshold, comparing by exact integer cross-multiplication. It returns
`undefined` — never `false` — when the row has no decision-grade verdicts, because the
comparison is not observable. `compareRateTo` exposes the three-way ordering.

There is no default threshold, and the function has arity 2 so it cannot acquire one silently.
`SATURATION_REFERENCE_BAND` (`{min: 0.02, max: 0.70}`) and `SATURATION_REFERENCE_BAND_RATIO`
(the same band as exact ratios) are exported as **documentation**: the research band the design
cites as a reference. Nothing in this package applies them. Pass
`SATURATION_REFERENCE_BAND_RATIO.max` if you want to adopt the reference upper bound — that is a
deliberate choice at the call site, which is where it belongs.

## Fixtures

`fixtures/` is exported (`@jinn-network/task-curation/fixtures/*`) so a reviewer can re-derive
by hand: `observations-golden.json` → `projection-golden.json` is pinned byte-for-byte by
`src/golden.test.ts`, three ways (forward, reversed, and through an incremental fold).
