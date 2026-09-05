# DR-2026-09-05 — Prediction-forecast tasks are paired-scoreable; task provenance rides a namespaced top-level extension

- **Date:** 2026-09-05
- **Status:** **Accepted 2026-09-05.** Ratified by operator ruling on [PR #3688](https://github.com/Jinn-Network/mono/pull/3688#issuecomment-5554840595) ("adopt as written"), answering D1–D3 of the design spec.
- **Owning doc:** [`docs/superpowers/specs/2026-09-02-prediction-forecast-paired-scoreability.md`](../../docs/superpowers/specs/2026-09-02-prediction-forecast-paired-scoreability.md) — the design this ruling adopts. It remains authoritative for the reasoning, the rejected routes, and the implementation packet.
- **Closes:** [#2606](https://github.com/Jinn-Network/mono/issues/2606).
- **Supersedes the premise of:** [P4b scoping §6.1](../../docs/superpowers/plans/demo-report-1/P4b-scoping.md) and [P4b implementation plan, Task 8a](../../docs/superpowers/plans/demo-report-1/2026-08-12-P4b-implementation-plan.md). Their conclusion — that a prediction-forecast task has nowhere legal to carry provenance — was correct when written and stopped being correct on 2026-08-13.
- **Does not amend:** `PREDICTION_SNAPSHOT_ADMISSION_POLICY_V1`, the sealed `prediction-forecast/1.0` profile or its digest, `payload.provenance` for `repository-work/1.0`, or any method's statistics, `minN` floors, exclusion rules, or reference sets.

## The question

Issue #2606 asked whether prediction-forecast tasks should be scoreable by the
clustered paired methods, and assumed a "yes" would cost a `v2` admission
policy — because the frozen v1 policy appeared to close the Task object to
exactly six keys, leaving provenance nowhere legal to live.

## What changed the answer

The issue's second premise went stale one day after it was filed. Commit
`6e8b9177c` (2026-08-13) replaced that exact-key closure with an
open-to-namespaced-extensions predicate: a top-level key is admitted if it is
`author` or matches an absolute-URI scheme
(`packages/task-supply/admission/src/prediction-snapshot.ts`, `forecastFromTask`).
`prediction-snapshot.test.ts:83` is a passing test that admits a Task carrying
`"https://product.example/extensions/derivation/v1"` at the top level.

So a prediction Task already has a legal home for provenance under the
**unchanged frozen v1 policy**. The remaining blocker is on the reader side:
`resolveBenchmarkTaskProvenance`
(`packages/benchmarking/records/src/benchmark/checks.ts`) reads provenance from
exactly one location, `task.data.payload["provenance"]`, and a
prediction-forecast payload is closed to exactly `{forecast}` — at the sealed
profile document (`additionalProperties: false`), not only at admission.

That reframes the decision. It is not "weaken a frozen contract to score a
profile." It is: **provenance is metadata about where a task came from, not part
of the work handed to the solver, and the resolver reads it from the one place
it does not belong.** `repository-work/1.0` gets away with the payload only
because its `payloadSchema` is open and declares `provenance`. Every
closed-payload profile — `prediction-forecast/1.0` today, every future bounded
venue profile — is excluded by an accident of where one reader happens to look.

## Decision

**D1 — Adopted: yes.** Prediction-forecast tasks are scoreable by the clustered
paired methods. The blast radius corrected: **five** registry methods declare
`clusteringRule: "task-provenance-source"` — `paired-delta@1`,
`paired-mcnemar@1`, `provenance-cluster-sign@1`, `noninferiority-iut@1` and
`paired-majority-delta@1` — not the three the issue named.

**D2 — Key spelling: `https://spec.jinn.network/task-provenance/v1`**, as
proposed. It must be an absolute URI; a bare reverse-DNS key such as
`jinn.benchmarking/cell` has no scheme colon and would be refused by the
admission predicate.

**D3 — The bundled sample does not grow.** It stays at its current three
fixed forecast variations sharing one synthetic source — one cluster — which is
below both thresholds the question named (≥5 tasks across ≥2 clusters). With
this decision the sample reaches *interval withheld with a stated reason* rather
than a typed refusal, and that is the honest first-run state. Whether the
first-run demo should instead show an interval is a separate product call.

> Recording-note on D3: the operator's ruling is worded "unchanged at 5 tasks /
> 2 clusters". Those two numbers are the **thresholds from the question**
> (`paired-delta@1`'s `minN = 5`, and the ≥2 clusters clustering needs), not the
> sample's size — `SAMPLE_FORECAST_VARIATIONS` in
> `packages/benchmark-product/core/src/intake/sample.ts` holds three variations
> against one synthetic source. The substantive ruling — *unchanged*, do not
> grow the sample — is unambiguous and is what is recorded here.

### The resolver contract this implies

`resolveBenchmarkTaskProvenance` accepts task provenance from either location:

1. `task.data.payload["provenance"]` — the profile-declared location, for
   profiles whose `payloadSchema` declares it;
2. `task.data["https://spec.jinn.network/task-provenance/v1"]` — the
   profile-agnostic location.

**Both present refuses `invalid-provenance`.** Fail closed on ambiguity rather
than inventing a precedence rule: a Task carrying two provenance claims is
corrupt, and a precedence rule would let the shadowed one drift unnoticed. This
is the same exactness discipline the surrounding code already applies — exactly
one of `source` or `sourceCommitment`, never both, never neither.

Neither present refuses `invalid-provenance`, exactly as today. **Every
currently passing input keeps its current outcome**; the change is purely
additive.

### What a prediction snapshot asserts

`source` is the market **venue** origin, never the individual market URL. A
per-market `source` would make every task its own singleton cluster and silently
defeat the correction — the lesson #2585 taught on the SWE-bench side, where the
cluster key was `https://github.com/<repo>@<base_commit>`. Market identity is
not lost; it stays task identity via `payload.forecast.marketId`.

## Why not the alternatives

| Route | Verdict |
|---|---|
| `payload.provenance` via a re-sealed `prediction-forecast/1.1` + admission policy `v2` | **Rejected.** Moves the sealed profile digest and cascades it through admission, the `prediction-v1-baseline` launcher and the pinned `profile.sha256`. The last time that digest moved, every prediction solve was rejected. It also entrenches the modelling error: provenance is not solver-visible work. |
| Make provenance optional in the five methods | **Rejected**, re-affirming P4b §5.4. Optional provenance silently disables the whole-source-cluster correction and reports a narrower interval than the data supports. That is a wrong number, not a missing one. |

## Consequences

- Issue #2606's third acceptance criterion — *does not weaken
  `PREDICTION_SNAPSHOT_ADMISSION_POLICY_V1`'s exact-key closure* — is satisfied
  **by construction rather than by promise**. The payload stays exactly
  `{forecast}`, and the `admitPredictionSnapshot` sanity call in
  `intake/sample.ts` stays load-bearing: under this design it additionally
  proves the extension key is admissible, which is the property being relied on.
- The bundled sample benchmark digest **moves** when the sample synthesises the
  extension key. Every pinned fixture is updated deliberately and called out.
- Implementation lands as a separate `feat` packet, filed as
  [#4098](https://github.com/Jinn-Network/mono/issues/4098) — §7 of the owning
  spec, four independently verifiable slices (resolver, sample synthesis, a
  paired-method acceptance test on the sample path, profile-facing
  documentation). It carries a native blocked-by edge on #2606, so it becomes
  claimable when this decision lands. Regression risk is concentrated in the
  digest movement; the resolver slice is additive and cannot change any currently
  passing outcome.

## Non-goals

- Growing the bundled sample past `minN = 5` (D3).
- Any change to the five methods' statistics or floors.
- A general provenance registry or attestation format. This decision moves one
  key to a second legal location; it does not model provenance more richly than
  the resolver already requires.
- Retrofitting existing `repository-work` tasks. They stay where they are,
  indefinitely.
